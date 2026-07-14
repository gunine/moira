import { describe, expect, it } from "vitest";
import { simulate } from "./simulate";
import type { NodeSpec, PlacementResult, WorkloadSpec } from "./types";

// ---------- 테스트 헬퍼 ----------

let seq = 0;

function node(partial: Partial<NodeSpec>): NodeSpec {
  seq += 1;
  return {
    id: partial.id ?? `node-${seq}`,
    name: partial.name ?? partial.id ?? `node-${seq}`,
    gpuModel: "H100-80GB",
    gpuCount: 8,
    vcpu: 128,
    memoryGiB: 1024,
    count: 1,
    migMode: "disabled",
    ...partial,
  };
}

function workload(partial: Partial<WorkloadSpec>): WorkloadSpec {
  seq += 1;
  return {
    id: partial.id ?? `wl-${seq}`,
    name: partial.name ?? partial.id ?? `wl-${seq}`,
    gpuRequest: { kind: "full", count: 1 },
    vcpuRequest: 4,
    memoryRequestGiB: 16,
    replicas: 1,
    ...partial,
  };
}

function placementsOf(placements: PlacementResult[], workloadId: string) {
  return placements.filter((p) => p.workloadId === workloadId);
}

// ---------- 1. MIG 없는 기본 bin-packing ----------

describe("기본 bin-packing (MIG 없음)", () => {
  it("GPU 총량이 충분하면 모든 파드가 배치된다", () => {
    const nodes = [node({ id: "pool", gpuCount: 8, count: 2 })]; // 총 16 GPU
    const wl = workload({
      id: "train",
      gpuRequest: { kind: "full", count: 4 },
      replicas: 4, // 16 GPU 필요
    });

    const { placements, gpuStates } = simulate(nodes, [wl], {
      strategy: "binpack",
    });

    expect(placements).toHaveLength(4);
    for (const p of placements) {
      expect(p.nodeId).not.toBeNull();
      expect(p.gpuAssignments).toHaveLength(4);
      expect(p.failReason).toBeUndefined();
    }
    // 16개 GPU 전부 whole 할당
    expect(gpuStates.filter((g) => g.wholeAllocatedTo).length).toBe(16);
  });

  it("GPU가 모자라면 초과 파드는 failReason='gpu'로 실패한다", () => {
    const nodes = [node({ id: "pool", gpuCount: 8, count: 2 })]; // 총 16 GPU
    const wl = workload({
      id: "train",
      gpuRequest: { kind: "full", count: 4 },
      replicas: 5, // 20 GPU 필요
    });

    const { placements } = simulate(nodes, [wl], { strategy: "binpack" });

    const failed = placements.filter((p) => p.nodeId === null);
    expect(failed).toHaveLength(1);
    expect(failed[0].failReason).toBe("gpu");
    expect(placements.filter((p) => p.nodeId !== null)).toHaveLength(4);
  });

  it("파드 하나의 요청이 단일 노드 GPU 수를 넘으면 노드 수와 무관하게 실패한다", () => {
    const nodes = [node({ id: "pool", gpuCount: 4, count: 4 })]; // 총 16 GPU, 노드당 4
    const wl = workload({
      id: "big",
      gpuRequest: { kind: "full", count: 8 },
    });

    const { placements } = simulate(nodes, [wl], { strategy: "binpack" });
    expect(placements[0].nodeId).toBeNull();
    expect(placements[0].failReason).toBe("gpu");
  });
});

// ---------- 2. vCPU 병목 ----------

describe("vCPU 병목", () => {
  it("GPU는 남는데 vCPU가 부족하면 failReason='vcpu'", () => {
    const nodes = [node({ id: "n", gpuCount: 8, vcpu: 16 })];
    const wl = workload({
      id: "cpu-heavy",
      gpuRequest: { kind: "full", count: 1 },
      vcpuRequest: 12,
      replicas: 2, // 두 번째 파드는 vCPU 잔량 4 < 12
    });

    const { placements, nodeStates } = simulate(nodes, [wl], {
      strategy: "binpack",
    });

    expect(placements[0].nodeId).not.toBeNull();
    expect(placements[1].nodeId).toBeNull();
    expect(placements[1].failReason).toBe("vcpu");
    expect(nodeStates[0].vcpuUsed).toBe(12);
  });

  it("메모리 부족은 failReason='memory'", () => {
    const nodes = [node({ id: "n", gpuCount: 8, memoryGiB: 100 })];
    const wl = workload({
      id: "mem-heavy",
      memoryRequestGiB: 80,
      replicas: 2,
    });

    const { placements } = simulate(nodes, [wl], { strategy: "binpack" });
    expect(placements[1].failReason).toBe("memory");
  });
});

// ---------- 3. static MIG 레이아웃 ----------

describe("static MIG 레이아웃", () => {
  const staticNode = () =>
    node({
      id: "mig-node",
      gpuCount: 1,
      migMode: "static",
      staticLayout: ["3g.40gb", "3g.40gb", "1g.10gb"], // Σ slices = 7
    });

  it("레이아웃에 있는 프로파일 요청은 인스턴스를 재사용해 배치된다", () => {
    const wl = workload({
      id: "infer",
      gpuRequest: { kind: "mig", profile: "3g.40gb", count: 1 },
      replicas: 2, // 3g 인스턴스 2개 소진
    });

    const { placements, gpuStates } = simulate([staticNode()], [wl], {
      strategy: "binpack",
    });

    for (const p of placements) {
      expect(p.nodeId).toBe("mig-node-0");
      expect(p.gpuAssignments).toHaveLength(1);
      expect(p.gpuAssignments![0].instanceIndex).toBeDefined();
    }
    const gpu = gpuStates[0];
    expect(gpu.mode).toBe("partitioned");
    expect(gpu.staticPartitioned).toBe(true);
    expect(gpu.instances.filter((i) => i.allocatedTo).length).toBe(2);
    expect(gpu.instances.filter((i) => !i.allocatedTo).length).toBe(1); // 1g만 남음
  });

  it("레이아웃에 없는 프로파일 요청은 failReason='mig-no-instance'", () => {
    const wl = workload({
      id: "mid",
      gpuRequest: { kind: "mig", profile: "2g.20gb", count: 1 },
    });

    const { placements } = simulate([staticNode()], [wl], {
      strategy: "binpack",
    });
    expect(placements[0].nodeId).toBeNull();
    expect(placements[0].failReason).toBe("mig-no-instance");
  });

  it("인스턴스 수보다 많은 count 요청도 'mig-no-instance'", () => {
    const wl = workload({
      id: "many",
      gpuRequest: { kind: "mig", profile: "1g.10gb", count: 2 }, // 1g는 1개뿐
    });

    const { placements } = simulate([staticNode()], [wl], {
      strategy: "binpack",
    });
    expect(placements[0].failReason).toBe("mig-no-instance");
  });
});

// ---------- 6. 파티셔닝으로 잠긴 노드에 full 요청 ----------

describe("full 요청 vs 파티셔닝된 GPU", () => {
  it("GPU 수는 충분하지만 전부 파티셔닝돼 있으면 failReason='mig-mode-mismatch'", () => {
    const nodes = [
      node({
        id: "locked",
        gpuCount: 2,
        migMode: "static",
        staticLayout: ["1g.10gb", "1g.10gb"],
      }),
    ];
    const wl = workload({
      id: "full-train",
      gpuRequest: { kind: "full", count: 2 },
    });

    const { placements } = simulate(nodes, [wl], { strategy: "binpack" });
    expect(placements[0].nodeId).toBeNull();
    expect(placements[0].failReason).toBe("mig-mode-mismatch");
  });

  it("파티셔닝과 무관하게 GPU 자체가 모자라면 failReason='gpu'", () => {
    const nodes = [
      node({
        id: "locked",
        gpuCount: 1,
        migMode: "static",
        staticLayout: ["1g.10gb"],
      }),
    ];
    const wl = workload({
      id: "full-train",
      gpuRequest: { kind: "full", count: 2 }, // 잠긴 GPU를 풀어도 1개뿐
    });

    const { placements } = simulate(nodes, [wl], { strategy: "binpack" });
    expect(placements[0].failReason).toBe("gpu");
  });
});

// ---------- 4. dynamic MIG 커빙 ----------

describe("dynamic MIG 커빙", () => {
  it("1g.10gb ×3 요청 시 GPU 하나가 1g×7로 커빙되고 3개 할당, 4개는 미할당", () => {
    const nodes = [node({ id: "dyn", gpuCount: 2, migMode: "dynamic" })];
    const wl = workload({
      id: "small-infer",
      gpuRequest: { kind: "mig", profile: "1g.10gb", count: 1 },
      replicas: 3,
    });

    const { placements, gpuStates } = simulate(nodes, [wl], {
      strategy: "binpack",
    });

    for (const p of placements) expect(p.nodeId).toBe("dyn-0");

    const carved = gpuStates.find((g) => g.gpuIndex === 0)!;
    expect(carved.mode).toBe("partitioned");
    expect(carved.staticPartitioned).toBeUndefined(); // 커빙은 자물쇠 없음
    expect(carved.instances).toHaveLength(7); // 1g×7 homogeneous
    expect(carved.instances.filter((i) => i.allocatedTo).length).toBe(3);
    expect(carved.instances.filter((i) => !i.allocatedTo).length).toBe(4);

    // 두 번째 GPU는 온전한 상태 유지 (재사용이 커빙보다 우선)
    const untouched = gpuStates.find((g) => g.gpuIndex === 1)!;
    expect(untouched.mode).toBe("whole");
    expect(untouched.wholeAllocatedTo).toBeUndefined();
  });

  it("2g 프로파일은 floor(7/2)=3개로 커빙되고 잔여 1 slice가 남는다", () => {
    const nodes = [
      node({ id: "dyn", gpuModel: "A100-40GB", gpuCount: 1, migMode: "dynamic" }),
    ];
    const wl = workload({
      id: "mid",
      gpuRequest: { kind: "mig", profile: "2g.10gb", count: 3 },
    });

    const { placements, gpuStates } = simulate(nodes, [wl], {
      strategy: "binpack",
    });
    expect(placements[0].nodeId).toBe("dyn-0");
    expect(gpuStates[0].instances).toHaveLength(3);
    expect(gpuStates[0].instances.every((i) => i.allocatedTo)).toBe(true);
  });

  it("커빙할 whole GPU가 없으면 failReason='mig-cannot-carve'", () => {
    const nodes = [node({ id: "dyn", gpuCount: 1, migMode: "dynamic" })];
    const workloads = [
      workload({ id: "occupy", gpuRequest: { kind: "full", count: 1 } }),
      workload({
        id: "mig-late",
        gpuRequest: { kind: "mig", profile: "1g.10gb", count: 1 },
      }),
    ];

    const { placements } = simulate(nodes, workloads, { strategy: "binpack" });
    const migResult = placementsOf(placements, "mig-late")[0];
    expect(migResult.nodeId).toBeNull();
    expect(migResult.failReason).toBe("mig-cannot-carve");
  });

  it("migCapable=false 모델에는 MIG 요청을 배치할 수 없다 (failReason='model')", () => {
    const nodes = [node({ id: "l40s", gpuModel: "L40S-48GB", migMode: "dynamic" })];
    const wl = workload({
      id: "mig-wl",
      gpuRequest: { kind: "mig", profile: "1g.10gb", count: 1 },
    });

    const { placements } = simulate(nodes, [wl], { strategy: "binpack" });
    expect(placements[0].failReason).toBe("model");
  });
});

// ---------- 5. full 우선 정렬 ----------

describe("full 요청과 MIG 요청 혼합 시 full 우선 배치", () => {
  it("입력 순서와 무관하게 full이 먼저 배치돼야 모든 파드가 성공한다", () => {
    // 노드 A(2 GPU), B(1 GPU) 모두 dynamic.
    // 정렬 없이 입력 순서대로 배치하면: MIG가 동점 tie-break로 A의 GPU를 커빙
    // → full×2가 들어갈 노드가 사라져 실패.
    // full 우선 정렬 시: full×2 → A, MIG는 B를 커빙 → 전원 성공.
    const nodes = [
      node({ id: "a", gpuCount: 2, migMode: "dynamic" }),
      node({ id: "b", gpuCount: 1, migMode: "dynamic" }),
    ];
    const workloads = [
      workload({
        id: "mig-first",
        gpuRequest: { kind: "mig", profile: "1g.10gb", count: 1 },
      }),
      workload({ id: "full-pair", gpuRequest: { kind: "full", count: 2 } }),
      workload({
        id: "mig-second",
        gpuRequest: { kind: "mig", profile: "1g.10gb", count: 1 },
      }),
    ];

    const { placements } = simulate(nodes, workloads, { strategy: "binpack" });

    for (const p of placements) expect(p.failReason).toBeUndefined();
    expect(placementsOf(placements, "full-pair")[0].nodeId).toBe("a-0");
    expect(placementsOf(placements, "mig-first")[0].nodeId).toBe("b-0");
    expect(placementsOf(placements, "mig-second")[0].nodeId).toBe("b-0");
  });

  it("MIG 요청끼리는 프로파일 slices 내림차순으로 배치된다", () => {
    // 1 GPU dynamic 노드: 4g를 먼저 커빙하지 않으면(1g가 먼저 커빙하면) 4g가 실패.
    // slices 내림차순 정렬로 4g가 먼저 GPU를 커빙 → 1g는 커빙할 GPU가 없어 실패.
    const nodes = [node({ id: "dyn", gpuCount: 1, migMode: "dynamic" })];
    const workloads = [
      workload({
        id: "small",
        gpuRequest: { kind: "mig", profile: "1g.10gb", count: 1 },
      }),
      workload({
        id: "big",
        gpuRequest: { kind: "mig", profile: "4g.40gb", count: 1 },
      }),
    ];

    const { placements } = simulate(nodes, workloads, { strategy: "binpack" });
    expect(placementsOf(placements, "big")[0].nodeId).toBe("dyn-0");
    expect(placementsOf(placements, "small")[0].failReason).toBe(
      "mig-cannot-carve",
    );
  });
});

// ---------- 7. binpack vs spread ----------

describe("binpack vs spread", () => {
  const nodes = () => [
    node({ id: "a", gpuCount: 2 }),
    node({ id: "b", gpuCount: 2 }),
  ];
  const wl = () =>
    workload({
      id: "svc",
      gpuRequest: { kind: "full", count: 1 },
      replicas: 2,
    });

  it("binpack은 이미 점유된 노드에 몰아넣는다", () => {
    const { placements } = simulate(nodes(), [wl()], { strategy: "binpack" });
    const ids = placementsOf(placements, "svc").map((p) => p.nodeId);
    expect(ids[0]).not.toBeNull();
    expect(ids[0]).toBe(ids[1]); // 같은 노드
  });

  it("spread는 노드에 고르게 분산한다", () => {
    const { placements } = simulate(nodes(), [wl()], { strategy: "spread" });
    const ids = placementsOf(placements, "svc").map((p) => p.nodeId);
    expect(ids[0]).not.toBeNull();
    expect(ids[1]).not.toBeNull();
    expect(ids[0]).not.toBe(ids[1]); // 서로 다른 노드
  });
});
