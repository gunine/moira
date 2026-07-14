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

// ---------- Internal simulation state ----------

interface SimNode {
  id: string;
  name: string;
  spec: NodeSpec;
  model: GpuModelSpec;
  /** Expansion order (deterministic tie-break) */
  index: number;
  vcpuUsed: number;
  memoryGiBUsed: number;
  gpus: GpuState[];
}

// ---------- Preprocessing ----------

/** Expand each node pool into `count` individual nodes and initialize GPU state. */
function expandNodes(specs: NodeSpec[]): SimNode[] {
  const out: SimNode[] = [];
  for (const spec of specs) {
    const model = getGpuModel(spec.gpuModel);
    if (!model) continue;
    // With migMode=static, pre-partition every GPU according to staticLayout.
    // A partitioned GPU can no longer take whole-GPU allocations.
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
 * Workload ordering: full requests first (count descending), then MIG
 * requests (profile slices descending). Placing full requests first keeps
 * dynamic nodes' intact GPUs from being consumed by MIG carving.
 * Ties preserve input order (stable).
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

// ---------- Shared helpers ----------

function freeWholeGpus(n: SimNode): GpuState[] {
  return n.gpus.filter((g) => g.mode === "whole" && !g.wholeAllocatedTo);
}

/** GPUs that are partitioned but have every instance unallocated (locked but idle) */
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
 * Score: binpack prefers the most-utilized node (MostAllocated),
 * spread prefers the least-utilized (LeastAllocated). Ties go to the node
 * that comes first in expansion order.
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
 * Failure reason for candidates that passed the GPU checks but all fell out
 * on vCPU/memory. Collect each node's first-lacking resource (vCPU checked
 * first) and report "memory" only when every node lacks memory.
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

// ---------- Placing full-GPU requests ----------

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
    // Distinguish "enough GPUs exist but they are locked by partitioning"
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

// ---------- Placing MIG requests ----------

interface FreeInstanceRef {
  gpu: GpuState;
  instanceIndex: number;
}

/** Unallocated instances of the given profile (GPU/instance index order = deterministic) */
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

  // Exclude nodes with migCapable=false models, models lacking the profile,
  // and nodes that fail the model constraint
  const capable = sim.filter(
    (n) => modelOk(n, w) && n.model.migCapable && getProfile(n.model, req.profile),
  );
  if (capable.length === 0) return fail(w, podIndex, "model");

  // Instances gained by carving one unused whole GPU on a dynamic node with
  // the homogeneous policy (e.g. a 1g request → floor(7/1) = 7 instances)
  const carveYield = (n: SimNode): number => {
    if (n.spec.migMode !== "dynamic") return 0; // static/disabled never carve
    if (freeWholeGpus(n).length === 0) return 0;
    const p = getProfile(n.model, req.profile);
    return p ? Math.floor(n.model.totalSlices / p.slices) : 0;
  };

  // GPU-side capacity: existing unallocated instances + (if needed) one carved GPU
  const capCands = capable.filter(
    (n) => freeInstances(n, req.profile).length + carveYield(n) >= req.count,
  );
  if (capCands.length === 0) {
    // Failing despite dynamic nodes = no whole GPU to carve, or carving still isn't enough
    const anyDynamic = capable.some((n) => n.spec.migMode === "dynamic");
    return fail(w, podIndex, anyDynamic ? "mig-cannot-carve" : "mig-no-instance");
  }

  const resCands = capCands.filter((n) => fitsCpuMem(n, w));
  if (resCands.length === 0) {
    return fail(w, podIndex, resourceFailReason(capCands, w));
  }

  // 1) Prefer nodes that can satisfy the request with existing instances
  //    (reuse) over carving. Sparing intact GPUs leaves room for later
  //    full requests and carving of other profiles.
  const reuseCands = resCands.filter(
    (n) => freeInstances(n, req.profile).length >= req.count,
  );
  const node = pickBest(reuseCands.length > 0 ? reuseCands : resCands, strategy);

  // 2) If reuse alone falls short, carve one unused whole GPU to fill the gap.
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

// ---------- Entry point ----------

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
