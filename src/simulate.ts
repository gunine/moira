import {
  getGpuModel,
  getProfile,
  isValidLayout,
  profileSlicesFromName,
} from "./catalog";
import type {
  FailReason,
  GpuModelSpec,
  GpuState,
  NodeSpec,
  NodeState,
  PlacementResult,
  SimulationOptions,
  SimulationResult,
  Strategy,
  WorkloadSpec,
} from "./types";

export { isValidLayout } from "./catalog";

// ---------- 내부 시뮬레이션 상태 ----------

interface SimNode {
  id: string;
  name: string;
  spec: NodeSpec;
  model: GpuModelSpec;
  /** 전개 순서 (동점 시 결정적 tie-break) */
  index: number;
  vcpuUsed: number;
  memoryGiBUsed: number;
  gpus: GpuState[];
}

// ---------- 전처리 ----------

/** 노드 풀을 count만큼 개별 노드로 전개하고 GPU 상태를 초기화한다. */
function expandNodes(specs: NodeSpec[]): SimNode[] {
  const out: SimNode[] = [];
  for (const spec of specs) {
    const model = getGpuModel(spec.gpuModel);
    if (!model) continue;
    // migMode=static이면 staticLayout대로 모든 GPU를 미리 파티셔닝한다.
    // 파티셔닝된 GPU는 whole 할당이 불가능해진다.
    const staticLayout =
      spec.migMode === "static" &&
      spec.staticLayout &&
      spec.staticLayout.length > 0 &&
      isValidLayout(model, spec.staticLayout)
        ? spec.staticLayout
        : undefined;
    for (let i = 0; i < spec.count; i++) {
      const id = `${spec.id}-${i}`;
      const gpus: GpuState[] = Array.from({ length: spec.gpuCount }, (_, g) =>
        staticLayout
          ? {
              nodeId: id,
              gpuIndex: g,
              mode: "partitioned" as const,
              instances: staticLayout.map((profile) => ({
                profile,
                allocatedTo: null,
              })),
              staticPartitioned: true,
            }
          : {
              nodeId: id,
              gpuIndex: g,
              mode: "whole" as const,
              instances: [],
            },
      );
      out.push({
        id,
        name: spec.count > 1 ? `${spec.name}-${i + 1}` : spec.name,
        spec,
        model,
        index: out.length,
        vcpuUsed: 0,
        memoryGiBUsed: 0,
        gpus,
      });
    }
  }
  return out;
}

/**
 * 워크로드 정렬: full 요청(count 내림차순) 먼저, 그다음 MIG 요청(slices 내림차순).
 * full을 먼저 배치해야 dynamic 노드의 온전한 GPU가 MIG 커빙으로 소모되는 것을 막는다.
 * 동순위는 입력 순서 유지(stable).
 */
function sortWorkloads(workloads: WorkloadSpec[]): WorkloadSpec[] {
  const keyed = workloads.map((w, i) => {
    const group = w.gpuRequest.kind === "full" ? 0 : 1;
    const size =
      w.gpuRequest.kind === "full"
        ? w.gpuRequest.count
        : profileSlicesFromName(w.gpuRequest.profile);
    return { w, i, group, size };
  });
  keyed.sort(
    (a, b) => a.group - b.group || b.size - a.size || a.i - b.i,
  );
  return keyed.map((k) => k.w);
}

// ---------- 공통 헬퍼 ----------

function freeWholeGpus(n: SimNode): GpuState[] {
  return n.gpus.filter((g) => g.mode === "whole" && !g.wholeAllocatedTo);
}

/** 파티셔닝돼 있지만 인스턴스가 전부 미할당인(= 잠겨만 있는) GPU */
function idleLockedGpus(n: SimNode): GpuState[] {
  return n.gpus.filter(
    (g) => g.mode === "partitioned" && g.instances.every((i) => !i.allocatedTo),
  );
}

function allocatedSlices(n: SimNode): number {
  let sum = 0;
  for (const g of n.gpus) {
    if (g.mode === "whole") {
      if (g.wholeAllocatedTo) sum += n.model.totalSlices;
    } else {
      for (const inst of g.instances) {
        if (inst.allocatedTo) sum += profileSlicesFromName(inst.profile);
      }
    }
  }
  return sum;
}

function gpuUtilization(n: SimNode): number {
  const total = n.spec.gpuCount * n.model.totalSlices;
  return total === 0 ? 0 : allocatedSlices(n) / total;
}

function vcpuFree(n: SimNode): number {
  return n.spec.vcpu - n.vcpuUsed;
}

function memoryFree(n: SimNode): number {
  return n.spec.memoryGiB - n.memoryGiBUsed;
}

function fitsCpuMem(n: SimNode, w: WorkloadSpec): boolean {
  return vcpuFree(n) >= w.vcpuRequest && memoryFree(n) >= w.memoryRequestGiB;
}

function modelOk(n: SimNode, w: WorkloadSpec): boolean {
  return !w.gpuModelConstraint || n.spec.gpuModel === w.gpuModelConstraint;
}

/**
 * Score: binpack = GPU 점유율 높은 노드 우선(MostAllocated),
 * spread = 낮은 노드 우선(LeastAllocated). 동점이면 전개 순서상 앞 노드.
 */
function pickBest(candidates: SimNode[], strategy: Strategy): SimNode {
  return candidates.reduce((best, n) => {
    const bu = gpuUtilization(best);
    const nu = gpuUtilization(n);
    if (nu === bu) return best;
    if (strategy === "binpack") return nu > bu ? n : best;
    return nu < bu ? n : best;
  });
}

/**
 * GPU 조건은 통과했지만 vCPU/메모리에서 전부 탈락한 후보들의 실패 사유.
 * 노드별 첫 부족 자원(vCPU 우선 검사)을 모아, 전부 메모리 부족일 때만 "memory".
 */
function resourceFailReason(candidates: SimNode[], w: WorkloadSpec): FailReason {
  const reasons = candidates.map((n) =>
    vcpuFree(n) < w.vcpuRequest ? "vcpu" : "memory",
  );
  return reasons.every((r) => r === "memory") ? "memory" : "vcpu";
}

function fail(w: WorkloadSpec, podIndex: number, reason: FailReason): PlacementResult {
  return { workloadId: w.id, podIndex, nodeId: null, failReason: reason };
}

// ---------- full GPU 요청 배치 ----------

function placeFullPod(
  sim: SimNode[],
  w: WorkloadSpec,
  podIndex: number,
  strategy: Strategy,
): PlacementResult {
  const req = w.gpuRequest as { kind: "full"; count: number };
  const podId = `${w.id}#${podIndex}`;

  const modelCands = sim.filter((n) => modelOk(n, w));
  if (modelCands.length === 0) return fail(w, podIndex, "model");

  const gpuCands = modelCands.filter(
    (n) => freeWholeGpus(n).length >= req.count,
  );
  if (gpuCands.length === 0) {
    // GPU 수량 자체는 충분한데 파티셔닝으로 잠겨서 실패한 경우를 구분
    const lockedWouldFit = modelCands.some(
      (n) => freeWholeGpus(n).length + idleLockedGpus(n).length >= req.count,
    );
    return fail(w, podIndex, lockedWouldFit ? "mig-mode-mismatch" : "gpu");
  }

  const resCands = gpuCands.filter((n) => fitsCpuMem(n, w));
  if (resCands.length === 0) {
    return fail(w, podIndex, resourceFailReason(gpuCands, w));
  }

  const node = pickBest(resCands, strategy);
  const gpus = freeWholeGpus(node).slice(0, req.count);
  for (const g of gpus) g.wholeAllocatedTo = podId;
  node.vcpuUsed += w.vcpuRequest;
  node.memoryGiBUsed += w.memoryRequestGiB;

  return {
    workloadId: w.id,
    podIndex,
    nodeId: node.id,
    gpuAssignments: gpus.map((g) => ({ gpuIndex: g.gpuIndex })),
  };
}

// ---------- MIG 요청 배치 ----------

interface FreeInstanceRef {
  gpu: GpuState;
  instanceIndex: number;
}

/** 해당 프로파일의 미할당 인스턴스 목록 (GPU/인스턴스 인덱스 순서 = 결정적) */
function freeInstances(n: SimNode, profile: string): FreeInstanceRef[] {
  const out: FreeInstanceRef[] = [];
  for (const g of n.gpus) {
    if (g.mode !== "partitioned") continue;
    g.instances.forEach((inst, instanceIndex) => {
      if (inst.profile === profile && !inst.allocatedTo) {
        out.push({ gpu: g, instanceIndex });
      }
    });
  }
  return out;
}

function placeMigPod(
  sim: SimNode[],
  w: WorkloadSpec,
  podIndex: number,
  strategy: Strategy,
): PlacementResult {
  const req = w.gpuRequest as { kind: "mig"; profile: string; count: number };
  const podId = `${w.id}#${podIndex}`;

  // migCapable=false 모델·프로파일 미지원 모델·제약 불일치 노드는 후보에서 제외
  const capable = sim.filter(
    (n) => modelOk(n, w) && n.model.migCapable && getProfile(n.model, req.profile),
  );
  if (capable.length === 0) return fail(w, podIndex, "model");

  // dynamic 노드에서 미사용 whole GPU 하나를 homogeneous 정책으로 커빙했을 때
  // 얻는 인스턴스 수 (예: 1g 요청 → floor(7/1) = 7개)
  const carveYield = (n: SimNode): number => {
    if (n.spec.migMode !== "dynamic") return 0; // static/disabled는 커빙 없음
    if (freeWholeGpus(n).length === 0) return 0;
    const p = getProfile(n.model, req.profile);
    return p ? Math.floor(n.model.totalSlices / p.slices) : 0;
  };

  // GPU 관점 수용 가능: 기존 미할당 인스턴스 + (필요 시) GPU 1개 커빙분
  const capCands = capable.filter(
    (n) => freeInstances(n, req.profile).length + carveYield(n) >= req.count,
  );
  if (capCands.length === 0) {
    // dynamic 노드가 있었는데도 실패 = 커빙할 whole GPU가 없거나 커빙분으로도 부족
    const anyDynamic = capable.some((n) => n.spec.migMode === "dynamic");
    return fail(w, podIndex, anyDynamic ? "mig-cannot-carve" : "mig-no-instance");
  }

  const resCands = capCands.filter((n) => fitsCpuMem(n, w));
  if (resCands.length === 0) {
    return fail(w, podIndex, resourceFailReason(capCands, w));
  }

  // 1) 기존 인스턴스만으로 수용 가능한 노드(재사용)를 커빙보다 우선한다.
  //    온전한 GPU를 아껴 이후 full 요청/다른 프로파일 커빙 여지를 남긴다.
  const reuseCands = resCands.filter(
    (n) => freeInstances(n, req.profile).length >= req.count,
  );
  const node = pickBest(reuseCands.length > 0 ? reuseCands : resCands, strategy);

  // 2) 재사용만으로 부족하면 미사용 whole GPU 하나를 커빙해 채운다.
  if (freeInstances(node, req.profile).length < req.count) {
    const gpu = freeWholeGpus(node)[0];
    const p = getProfile(node.model, req.profile)!;
    const instanceCount = Math.floor(node.model.totalSlices / p.slices);
    gpu.mode = "partitioned";
    gpu.instances = Array.from({ length: instanceCount }, () => ({
      profile: req.profile,
      allocatedTo: null,
    }));
  }

  const chosen = freeInstances(node, req.profile).slice(0, req.count);
  for (const { gpu, instanceIndex } of chosen) {
    gpu.instances[instanceIndex].allocatedTo = podId;
  }
  node.vcpuUsed += w.vcpuRequest;
  node.memoryGiBUsed += w.memoryRequestGiB;

  return {
    workloadId: w.id,
    podIndex,
    nodeId: node.id,
    gpuAssignments: chosen.map(({ gpu, instanceIndex }) => ({
      gpuIndex: gpu.gpuIndex,
      instanceIndex,
    })),
  };
}

// ---------- 엔트리포인트 ----------

export function simulate(
  nodes: NodeSpec[],
  workloads: WorkloadSpec[],
  options: SimulationOptions,
): SimulationResult {
  const sim = expandNodes(nodes);
  const placements: PlacementResult[] = [];

  for (const w of sortWorkloads(workloads)) {
    for (let r = 0; r < w.replicas; r++) {
      const p =
        w.gpuRequest.kind === "full"
          ? placeFullPod(sim, w, r, options.strategy)
          : placeMigPod(sim, w, r, options.strategy);
      placements.push(p);
    }
  }

  const nodeStates: NodeState[] = sim.map((n) => ({
    nodeId: n.id,
    name: n.name,
    specId: n.spec.id,
    gpuModel: n.spec.gpuModel,
    migMode: n.spec.migMode,
    gpuCount: n.spec.gpuCount,
    vcpuTotal: n.spec.vcpu,
    vcpuUsed: n.vcpuUsed,
    memoryGiBTotal: n.spec.memoryGiB,
    memoryGiBUsed: n.memoryGiBUsed,
  }));

  return {
    placements,
    gpuStates: sim.flatMap((n) => n.gpus),
    nodeStates,
  };
}
