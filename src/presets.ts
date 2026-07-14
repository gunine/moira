import type { NodeSpec, Strategy, WorkloadSpec } from "./types";

export interface AppState {
  nodes: NodeSpec[];
  workloads: WorkloadSpec[];
  strategy: Strategy;
}

export interface Preset {
  label: string;
  build: () => AppState;
}

export const PRESETS: Preset[] = [
  {
    label: "H100×8 MIG없음 ×4대",
    build: () => ({
      strategy: "binpack",
      nodes: [
        {
          id: "p1-h100",
          name: "h100-node",
          gpuModel: "H100-80GB",
          gpuCount: 8,
          vcpu: 128,
          memoryGiB: 1024,
          count: 4,
          migMode: "disabled",
        },
      ],
      workloads: [
        {
          id: "p1-train",
          name: "대규모 학습",
          gpuRequest: { kind: "full", count: 4 },
          vcpuRequest: 32,
          memoryRequestGiB: 256,
          replicas: 6,
        },
        {
          id: "p1-ft",
          name: "파인튜닝",
          gpuRequest: { kind: "full", count: 2 },
          vcpuRequest: 16,
          memoryRequestGiB: 128,
          replicas: 3,
        },
        {
          id: "p1-infer",
          name: "온라인 추론",
          gpuRequest: { kind: "full", count: 1 },
          vcpuRequest: 8,
          memoryRequestGiB: 64,
          replicas: 3,
        },
      ],
    }),
  },
  {
    label: "H100×8 static 1g×7 ×2대",
    build: () => ({
      strategy: "binpack",
      nodes: [
        {
          id: "p2-h100-mig",
          name: "h100-mig",
          gpuModel: "H100-80GB",
          gpuCount: 8,
          vcpu: 128,
          memoryGiB: 1024,
          count: 2,
          migMode: "static",
          staticLayout: [
            "1g.10gb",
            "1g.10gb",
            "1g.10gb",
            "1g.10gb",
            "1g.10gb",
            "1g.10gb",
            "1g.10gb",
          ],
        },
      ],
      workloads: [
        {
          id: "p2-small",
          name: "소형 추론",
          gpuRequest: { kind: "mig", profile: "1g.10gb", count: 1 },
          vcpuRequest: 2,
          memoryRequestGiB: 8,
          replicas: 40,
        },
        {
          id: "p2-mid",
          name: "중형 추론",
          gpuRequest: { kind: "mig", profile: "3g.40gb", count: 1 },
          vcpuRequest: 8,
          memoryRequestGiB: 32,
          replicas: 2,
        },
        {
          id: "p2-batch",
          name: "배치 학습",
          gpuRequest: { kind: "full", count: 1 },
          vcpuRequest: 8,
          memoryRequestGiB: 64,
          replicas: 2,
        },
      ],
    }),
  },
  {
    label: "A100×4 dynamic ×4대",
    build: () => ({
      strategy: "binpack",
      nodes: [
        {
          id: "p3-a100",
          name: "a100-dyn",
          gpuModel: "A100-40GB",
          gpuCount: 4,
          vcpu: 64,
          memoryGiB: 512,
          count: 4,
          migMode: "dynamic",
        },
      ],
      workloads: [
        {
          id: "p3-train",
          name: "학습 잡",
          gpuRequest: { kind: "full", count: 2 },
          vcpuRequest: 16,
          memoryRequestGiB: 128,
          replicas: 2,
        },
        {
          id: "p3-mid",
          name: "중형 추론",
          gpuRequest: { kind: "mig", profile: "3g.20gb", count: 1 },
          vcpuRequest: 8,
          memoryRequestGiB: 32,
          replicas: 4,
        },
        {
          id: "p3-small",
          name: "소형 추론",
          gpuRequest: { kind: "mig", profile: "1g.5gb", count: 1 },
          vcpuRequest: 2,
          memoryRequestGiB: 8,
          replicas: 10,
        },
      ],
    }),
  },
];

export const DEFAULT_STATE: AppState = PRESETS[2].build();
