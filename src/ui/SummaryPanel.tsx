import { GPU_CATALOG, getGpuModel, profileSlicesFromName } from "../catalog";
import type {
  FailReason,
  GpuState,
  SimulationResult,
  WorkloadSpec,
} from "../types";
import { colorVar } from "./colors";

interface Props {
  result: SimulationResult;
  workloads: WorkloadSpec[];
  colorSlots: Record<string, number>;
}

// ---------- 실패 사유 → 사람이 읽는 문장 ----------

function failSentence(w: WorkloadSpec | undefined, reason: FailReason): string {
  const req = w?.gpuRequest;
  switch (reason) {
    case "gpu": {
      const count = req?.kind === "full" ? req.count : 1;
      return `온전한 GPU ${count}개를 확보할 수 있는 노드가 없습니다 (GPU 부족)`;
    }
    case "vcpu":
      return "GPU는 확보할 수 있지만 vCPU 잔량이 부족합니다";
    case "memory":
      return "GPU는 확보할 수 있지만 메모리 잔량이 부족합니다";
    case "model":
      return w?.gpuModelConstraint
        ? `'${w.gpuModelConstraint}' 모델 노드가 없거나 해당 모델이 이 요청을 지원하지 않습니다`
        : "이 요청을 지원하는 GPU 모델 노드가 없습니다";
    case "mig-no-instance": {
      const profile = req?.kind === "mig" ? req.profile : "요청 프로파일";
      return `'${profile}' 미할당 인스턴스가 없습니다 — static 노드는 새로 커빙하지 않습니다`;
    }
    case "mig-cannot-carve":
      return "dynamic 노드에 커빙할 미사용 whole GPU가 없습니다";
    case "mig-mode-mismatch":
      return "GPU 수는 충분하지만 MIG 파티셔닝으로 잠겨 있어 whole GPU로 사용할 수 없습니다";
  }
}

// ---------- 클러스터 slice 집계 ----------

interface SliceStats {
  totalSlices: number;
  allocatedSlices: number;
  freeInstanceSlices: number;
  freeInstanceByProfile: Map<string, number>;
  idleWholeGpus: number;
  idleWholeSlices: number;
  residualSlices: number;
  nodesWithUsableFree: number;
  perNodeUtil: number[];
}

function analyzeSlices(result: SimulationResult): SliceStats {
  const stats: SliceStats = {
    totalSlices: 0,
    allocatedSlices: 0,
    freeInstanceSlices: 0,
    freeInstanceByProfile: new Map(),
    idleWholeGpus: 0,
    idleWholeSlices: 0,
    residualSlices: 0,
    nodesWithUsableFree: 0,
    perNodeUtil: [],
  };

  const gpusByNode = new Map<string, GpuState[]>();
  for (const g of result.gpuStates) {
    const list = gpusByNode.get(g.nodeId) ?? [];
    list.push(g);
    gpusByNode.set(g.nodeId, list);
  }

  for (const ns of result.nodeStates) {
    const totalPerGpu = getGpuModel(ns.gpuModel)?.totalSlices ?? 7;
    let nodeTotal = 0;
    let nodeAlloc = 0;
    let nodeUsableFree = 0;

    for (const gpu of gpusByNode.get(ns.nodeId) ?? []) {
      nodeTotal += totalPerGpu;
      if (gpu.mode === "whole") {
        if (gpu.wholeAllocatedTo) {
          nodeAlloc += totalPerGpu;
        } else {
          stats.idleWholeGpus += 1;
          stats.idleWholeSlices += totalPerGpu;
          nodeUsableFree += totalPerGpu;
        }
        continue;
      }
      let used = 0;
      for (const inst of gpu.instances) {
        const s = Math.max(1, profileSlicesFromName(inst.profile));
        used += s;
        if (inst.allocatedTo) {
          nodeAlloc += s;
        } else {
          stats.freeInstanceSlices += s;
          nodeUsableFree += s;
          stats.freeInstanceByProfile.set(
            inst.profile,
            (stats.freeInstanceByProfile.get(inst.profile) ?? 0) + 1,
          );
        }
      }
      stats.residualSlices += Math.max(0, totalPerGpu - used);
    }

    stats.totalSlices += nodeTotal;
    stats.allocatedSlices += nodeAlloc;
    stats.perNodeUtil.push(nodeTotal > 0 ? nodeAlloc / nodeTotal : 0);
    if (nodeUsableFree > 0) stats.nodesWithUsableFree += 1;
  }

  return stats;
}

/**
 * 수용 가능성: 지금 이 클러스터 상태에서 프로파일 1개짜리 요청을
 * 받아줄 수 있는가 (기존 미할당 인스턴스 or dynamic 노드 커빙)
 */
function findSmallestRejectedProfile(
  result: SimulationResult,
  model: string,
): string | null {
  const spec = getGpuModel(model);
  if (!spec?.migCapable) return null;

  const gpusByNode = new Map<string, GpuState[]>();
  for (const g of result.gpuStates) {
    const list = gpusByNode.get(g.nodeId) ?? [];
    list.push(g);
    gpusByNode.set(g.nodeId, list);
  }

  const modelNodes = result.nodeStates.filter((ns) => ns.gpuModel === model);
  const profilesAsc = [...spec.profiles].sort((a, b) => a.slices - b.slices);

  for (const profile of profilesAsc) {
    const accepted = modelNodes.some((ns) => {
      const gpus = gpusByNode.get(ns.nodeId) ?? [];
      const hasFreeInstance = gpus.some(
        (g) =>
          g.mode === "partitioned" &&
          g.instances.some((i) => i.profile === profile.name && !i.allocatedTo),
      );
      if (hasFreeInstance) return true;
      const canCarve =
        ns.migMode === "dynamic" &&
        gpus.some((g) => g.mode === "whole" && !g.wholeAllocatedTo);
      return canCarve;
    });
    if (!accepted) return profile.name;
  }
  return null;
}

// ---------- 패널 ----------

const pct = (v: number) => `${Math.round(v * 1000) / 10}%`;

export default function SummaryPanel(props: Props) {
  const { result, workloads, colorSlots } = props;
  const byId = new Map(workloads.map((w) => [w.id, w]));

  const totalPods = result.placements.length;
  const placedPods = result.placements.filter((p) => p.nodeId !== null).length;
  const stats = analyzeSlices(result);
  const avgNodeUtil =
    stats.perNodeUtil.length > 0
      ? stats.perNodeUtil.reduce((a, b) => a + b, 0) / stats.perNodeUtil.length
      : 0;

  // 실패를 (워크로드, 사유)로 묶는다
  const failGroups = new Map<string, { workloadId: string; reason: FailReason; count: number }>();
  for (const p of result.placements) {
    if (p.nodeId !== null || !p.failReason) continue;
    const key = `${p.workloadId}|${p.failReason}`;
    const g = failGroups.get(key) ?? {
      workloadId: p.workloadId,
      reason: p.failReason,
      count: 0,
    };
    g.count += 1;
    failGroups.set(key, g);
  }

  const modelsInCluster = [...new Set(result.nodeStates.map((ns) => ns.gpuModel))];
  const migModelsInCluster = modelsInCluster.filter(
    (m) => GPU_CATALOG.find((c) => c.model === m)?.migCapable,
  );
  const unallocated = stats.totalSlices - stats.allocatedSlices;

  return (
    <div className="summary-panel">
      <section>
        <h2>배치 결과</h2>
        <div className="stat-tiles">
          <div className="stat-tile hero">
            <div className="label">배치 성공률</div>
            <div className="value">
              {totalPods > 0 ? pct(placedPods / totalPods) : "—"}
            </div>
            <div className="detail">
              파드 {totalPods}개 중 {placedPods}개 배치
            </div>
          </div>
          <div className="stat-tile">
            <div className="label">GPU 활용률 (slice)</div>
            <div className="value">
              {stats.totalSlices > 0
                ? pct(stats.allocatedSlices / stats.totalSlices)
                : "—"}
            </div>
            <div className="detail">
              {stats.allocatedSlices}/{stats.totalSlices} slice
            </div>
          </div>
          <div className="stat-tile">
            <div className="label">노드 평균 점유율</div>
            <div className="value">
              {stats.perNodeUtil.length > 0 ? pct(avgNodeUtil) : "—"}
            </div>
            <div className="detail">노드 {stats.perNodeUtil.length}개 기준</div>
          </div>
        </div>
      </section>

      <section>
        <h2>배치 실패</h2>
        {failGroups.size === 0 ? (
          <p className="ok-note">
            {totalPods > 0 ? "✓ 모든 파드가 배치되었습니다" : "워크로드가 없습니다"}
          </p>
        ) : (
          <div className="fail-list">
            {[...failGroups.values()].map((g) => {
              const w = byId.get(g.workloadId);
              return (
                <div key={`${g.workloadId}|${g.reason}`} className="fail-item">
                  <div className="who">
                    <span
                      className="color-dot"
                      style={{
                        background: colorVar(colorSlots[g.workloadId] ?? -1),
                      }}
                    />
                    {w?.name ?? g.workloadId}
                    <span className="hint" style={{ margin: 0 }}>
                      파드 {g.count}개 · {g.reason}
                    </span>
                  </div>
                  <div className="why">{failSentence(w, g.reason)}</div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section>
        <h2>프래그멘테이션</h2>
        <table className="frag-table">
          <tbody>
            <tr>
              <td>미할당 slice 총수</td>
              <td>
                {unallocated}/{stats.totalSlices}
              </td>
            </tr>
            <tr>
              <td>└ 유휴 whole GPU</td>
              <td>
                {stats.idleWholeGpus}개 ({stats.idleWholeSlices} slice)
              </td>
            </tr>
            <tr>
              <td>└ 미할당 MIG 인스턴스</td>
              <td>{stats.freeInstanceSlices} slice</td>
            </tr>
            <tr>
              <td>└ 커빙되지 않은 잔여 slice</td>
              <td>{stats.residualSlices} slice</td>
            </tr>
            <tr>
              <td>여유가 남은 노드</td>
              <td>
                {stats.nodesWithUsableFree}/{result.nodeStates.length}개
              </td>
            </tr>
          </tbody>
        </table>
        {stats.freeInstanceByProfile.size > 0 && (
          <p className="frag-note">
            미할당 인스턴스:{" "}
            {[...stats.freeInstanceByProfile.entries()]
              .map(([profile, count]) => `${profile}×${count}`)
              .join(", ")}
          </p>
        )}
        {stats.residualSlices > 0 && (
          <p className="frag-note">
            잔여 slice {stats.residualSlices}개는 재파티셔닝 없이는 사용할 수
            없습니다.
          </p>
        )}
        {migModelsInCluster.map((model) => {
          const rejected = findSmallestRejectedProfile(result, model);
          return (
            <p
              key={model}
              className={rejected ? "frag-note warn" : "frag-note"}
            >
              {model}:{" "}
              {rejected
                ? `최소 '${rejected}' 프로파일부터 수용 불가`
                : "모든 프로파일 수용 가능"}
            </p>
          );
        })}
      </section>

      <section>
        <details className="raw-json">
          <summary>결과 JSON 보기</summary>
          <pre className="json-view">{JSON.stringify(result, null, 2)}</pre>
        </details>
      </section>
    </div>
  );
}
