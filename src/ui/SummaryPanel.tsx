import { GPU_CATALOG, getGpuModel, profileSlicesFromName } from "../catalog";
import { useI18n } from "../i18n";
import type { Translator } from "../i18n";
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

// ---------- Failure reason → human-readable sentence ----------

function failSentence(
  t: Translator,
  w: WorkloadSpec | undefined,
  reason: FailReason,
): string {
  const req = w?.gpuRequest;
  switch (reason) {
    case "gpu": {
      const count = req?.kind === "full" ? req.count : 1;
      return t("fail.gpu", { count });
    }
    case "vcpu":
      return t("fail.vcpu");
    case "memory":
      return t("fail.memory");
    case "model":
      return w?.gpuModelConstraint
        ? t("fail.modelConstrained", { model: w.gpuModelConstraint })
        : t("fail.model");
    case "mig-no-instance": {
      const profile =
        req?.kind === "mig" ? req.profile : t("fail.requestedProfile");
      return t("fail.migNoInstance", { profile });
    }
    case "mig-cannot-carve":
      return t("fail.migCannotCarve");
    case "mig-mode-mismatch":
      return t("fail.migModeMismatch");
  }
}

// ---------- Cluster-wide slice aggregation ----------

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
 * Admissibility: given the current cluster state, could a single-instance
 * request for this profile be accepted (via an existing unallocated
 * instance, or by carving on a dynamic node)?
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

// ---------- Panel ----------

const pct = (v: number) => `${Math.round(v * 1000) / 10}%`;

export default function SummaryPanel(props: Props) {
  const { result, workloads, colorSlots } = props;
  const { t } = useI18n();
  const byId = new Map(workloads.map((w) => [w.id, w]));

  const totalPods = result.placements.length;
  const placedPods = result.placements.filter((p) => p.nodeId !== null).length;
  const stats = analyzeSlices(result);
  const avgNodeUtil =
    stats.perNodeUtil.length > 0
      ? stats.perNodeUtil.reduce((a, b) => a + b, 0) / stats.perNodeUtil.length
      : 0;

  // Group failures by (workload, reason)
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
        <h2>{t("summary.results")}</h2>
        <div className="stat-tiles">
          <div className="stat-tile hero">
            <div className="label">{t("summary.successRate")}</div>
            <div className="value">
              {totalPods > 0 ? pct(placedPods / totalPods) : "—"}
            </div>
            <div className="detail">
              {t("summary.successDetail", { placed: placedPods, total: totalPods })}
            </div>
          </div>
          <div className="stat-tile">
            <div className="label">{t("summary.gpuUtil")}</div>
            <div className="value">
              {stats.totalSlices > 0
                ? pct(stats.allocatedSlices / stats.totalSlices)
                : "—"}
            </div>
            <div className="detail">
              {t("summary.sliceRatio", {
                used: stats.allocatedSlices,
                total: stats.totalSlices,
              })}
            </div>
          </div>
          <div className="stat-tile">
            <div className="label">{t("summary.avgNodeUtil")}</div>
            <div className="value">
              {stats.perNodeUtil.length > 0 ? pct(avgNodeUtil) : "—"}
            </div>
            <div className="detail">
              {t("summary.nodeBasis", { count: stats.perNodeUtil.length })}
            </div>
          </div>
        </div>
      </section>

      <section>
        <h2>{t("summary.failures")}</h2>
        {failGroups.size === 0 ? (
          <p className="ok-note">
            {totalPods > 0 ? t("summary.allPlaced") : t("summary.noWorkloads")}
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
                      {t("summary.failMeta", { count: g.count, reason: g.reason })}
                    </span>
                  </div>
                  <div className="why">{failSentence(t, w, g.reason)}</div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section>
        <h2>{t("frag.title")}</h2>
        <table className="frag-table">
          <tbody>
            <tr>
              <td>{t("frag.unallocated")}</td>
              <td>
                {unallocated}/{stats.totalSlices}
              </td>
            </tr>
            <tr>
              <td>{t("frag.idleWhole")}</td>
              <td>
                {t("frag.idleWholeValue", {
                  count: stats.idleWholeGpus,
                  slices: stats.idleWholeSlices,
                })}
              </td>
            </tr>
            <tr>
              <td>{t("frag.freeInstances")}</td>
              <td>{t("frag.slices", { count: stats.freeInstanceSlices })}</td>
            </tr>
            <tr>
              <td>{t("frag.residual")}</td>
              <td>{t("frag.slices", { count: stats.residualSlices })}</td>
            </tr>
            <tr>
              <td>{t("frag.nodesWithFree")}</td>
              <td>
                {t("frag.nodesWithFreeValue", {
                  free: stats.nodesWithUsableFree,
                  total: result.nodeStates.length,
                })}
              </td>
            </tr>
          </tbody>
        </table>
        {stats.freeInstanceByProfile.size > 0 && (
          <p className="frag-note">
            {t("frag.freeInstanceNote", {
              list: [...stats.freeInstanceByProfile.entries()]
                .map(([profile, count]) => `${profile}×${count}`)
                .join(", "),
            })}
          </p>
        )}
        {stats.residualSlices > 0 && (
          <p className="frag-note">
            {t("frag.residualNote", { count: stats.residualSlices })}
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
                ? t("frag.smallestRejected", { profile: rejected })
                : t("frag.allAccepted")}
            </p>
          );
        })}
      </section>

      <section>
        <details className="raw-json">
          <summary>{t("summary.viewJson")}</summary>
          <pre className="json-view">{JSON.stringify(result, null, 2)}</pre>
        </details>
      </section>
    </div>
  );
}
