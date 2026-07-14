// ---------- GPU 카탈로그 ----------

export interface MigProfileSpec {
  /** "1g.10gb" 형식 */
  name: string;
  slices: 1 | 2 | 3 | 4 | 7;
  memoryGiB: number;
}

export interface GpuModelSpec {
  model: string;
  memoryGiB: number;
  migCapable: boolean;
  /** 현재 세대 GPU는 7로 고정 */
  totalSlices: number;
  profiles: MigProfileSpec[];
}

// ---------- 노드 풀 ----------

export type MigMode = "disabled" | "static" | "dynamic";

export interface NodeSpec {
  id: string;
  name: string;
  /** GPU_CATALOG의 model 참조 */
  gpuModel: string;
  gpuCount: number;
  vcpu: number;
  memoryGiB: number;
  /** 동일 스펙 노드 수 (풀 단위 입력) */
  count: number;
  migMode: MigMode;
  /** migMode=static일 때 GPU 하나를 파티셔닝할 프로파일 배열. 풀의 모든 GPU에 동일 적용 */
  staticLayout?: string[];
}

// ---------- 워크로드 ----------

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

// ---------- 시뮬레이션 상태/결과 ----------

export interface MigInstanceState {
  profile: string;
  /** 파드 ID | null */
  allocatedTo: string | null;
}

export interface GpuState {
  nodeId: string;
  gpuIndex: number;
  mode: "whole" | "partitioned";
  instances: MigInstanceState[];
  /** mode=whole일 때 GPU 전체를 점유한 파드 ID */
  wholeAllocatedTo?: string;
  /** static 전처리로 파티셔닝된 GPU (UI 자물쇠 표시용) */
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
  /** null = 배치 실패 */
  nodeId: string | null;
  gpuAssignments?: { gpuIndex: number; instanceIndex?: number }[];
  failReason?: FailReason;
}

export interface NodeState {
  nodeId: string;
  name: string;
  /** 이 노드를 전개한 풀(NodeSpec)의 id */
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
