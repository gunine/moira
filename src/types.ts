// ---------- GPU catalog ----------

export interface MigProfileSpec {
  /** e.g. "1g.10gb" */
  name: string;
  slices: 1 | 2 | 3 | 4 | 7;
  memoryGiB: number;
}

export interface GpuModelSpec {
  model: string;
  memoryGiB: number;
  migCapable: boolean;
  /** Fixed at 7 for current-generation GPUs */
  totalSlices: number;
  profiles: MigProfileSpec[];
}

// ---------- Node pools ----------

export type MigMode = "disabled" | "static" | "dynamic";

export interface NodeSpec {
  id: string;
  name: string;
  /** References a model in GPU_CATALOG */
  gpuModel: string;
  gpuCount: number;
  vcpu: number;
  memoryGiB: number;
  /** Number of identical nodes (input is pool-level) */
  count: number;
  migMode: MigMode;
  /**
   * Profiles used to partition one GPU when migMode=static.
   * Applied identically to every GPU in the pool.
   */
  staticLayout?: string[];
}

// ---------- Workloads ----------

export type GpuRequest =
  | { kind: "full"; count: number }
  | { kind: "mig"; profile: string; count: number };

export interface WorkloadSpec {
  id: string;
  name: string;
  gpuRequest: GpuRequest;
  vcpuRequest: number;
  memoryRequestGiB: number;
  replicas: number;
  gpuModelConstraint?: string;
}

// ---------- Simulation state / results ----------

export interface MigInstanceState {
  profile: string;
  /** Pod ID | null */
  allocatedTo: string | null;
}

export interface GpuState {
  nodeId: string;
  gpuIndex: number;
  mode: "whole" | "partitioned";
  instances: MigInstanceState[];
  /** Pod ID occupying the entire GPU when mode=whole */
  wholeAllocatedTo?: string;
  /** GPU partitioned during static preprocessing (drives the UI lock icon) */
  staticPartitioned?: boolean;
}

export type FailReason =
  | "gpu"
  | "vcpu"
  | "memory"
  | "model"
  | "mig-no-instance"
  | "mig-cannot-carve"
  | "mig-mode-mismatch";

export interface PlacementResult {
  workloadId: string;
  podIndex: number;
  /** null = placement failed */
  nodeId: string | null;
  gpuAssignments?: { gpuIndex: number; instanceIndex?: number }[];
  failReason?: FailReason;
}

export interface NodeState {
  nodeId: string;
  name: string;
  /** id of the pool (NodeSpec) this node was expanded from */
  specId: string;
  gpuModel: string;
  migMode: MigMode;
  gpuCount: number;
  vcpuTotal: number;
  vcpuUsed: number;
  memoryGiBTotal: number;
  memoryGiBUsed: number;
}

export type Strategy = "binpack" | "spread";

export interface SimulationOptions {
  strategy: Strategy;
}

export interface SimulationResult {
  placements: PlacementResult[];
  gpuStates: GpuState[];
  nodeStates: NodeState[];
}
