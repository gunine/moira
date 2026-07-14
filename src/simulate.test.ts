import { describe, expect, it } from "vitest";
import { simulate } from "./simulate";
import type { NodeSpec, PlacementResult, WorkloadSpec } from "./types";

// ---------- Test helpers ----------

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

// ---------- 1. Basic bin-packing without MIG ----------

describe("basic bin-packing (no MIG)", () => {
  it("places every pod when total GPU capacity suffices", () => {
    const nodes = [node({ id: "pool", gpuCount: 8, count: 2 })]; // 16 GPUs total
    const wl = workload({
      id: "train",
      gpuRequest: { kind: "full", count: 4 },
      replicas: 4, // needs 16 GPUs
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
    // all 16 GPUs whole-allocated
    expect(gpuStates.filter((g) => g.wholeAllocatedTo).length).toBe(16);
  });

  it("fails overflow pods with failReason='gpu' when GPUs run out", () => {
    const nodes = [node({ id: "pool", gpuCount: 8, count: 2 })]; // 16 GPUs total
    const wl = workload({
      id: "train",
      gpuRequest: { kind: "full", count: 4 },
      replicas: 5, // needs 20 GPUs
    });

    const { placements } = simulate(nodes, [wl], { strategy: "binpack" });

    const failed = placements.filter((p) => p.nodeId === null);
    expect(failed).toHaveLength(1);
    expect(failed[0].failReason).toBe("gpu");
    expect(placements.filter((p) => p.nodeId !== null)).toHaveLength(4);
  });

  it("fails a pod whose request exceeds a single node's GPU count regardless of node count", () => {
    const nodes = [node({ id: "pool", gpuCount: 4, count: 4 })]; // 16 GPUs total, 4 per node
    const wl = workload({
      id: "big",
      gpuRequest: { kind: "full", count: 8 },
    });

    const { placements } = simulate(nodes, [wl], { strategy: "binpack" });
    expect(placements[0].nodeId).toBeNull();
    expect(placements[0].failReason).toBe("gpu");
  });
});

// ---------- 2. vCPU bottleneck ----------

describe("vCPU bottleneck", () => {
  it("reports failReason='vcpu' when GPUs remain but vCPU is short", () => {
    const nodes = [node({ id: "n", gpuCount: 8, vcpu: 16 })];
    const wl = workload({
      id: "cpu-heavy",
      gpuRequest: { kind: "full", count: 1 },
      vcpuRequest: 12,
      replicas: 2, // second pod: remaining vCPU 4 < 12
    });

    const { placements, nodeStates } = simulate(nodes, [wl], {
      strategy: "binpack",
    });

    expect(placements[0].nodeId).not.toBeNull();
    expect(placements[1].nodeId).toBeNull();
    expect(placements[1].failReason).toBe("vcpu");
    expect(nodeStates[0].vcpuUsed).toBe(12);
  });

  it("reports failReason='memory' when memory is short", () => {
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

// ---------- 3. static MIG layout ----------

describe("static MIG layout", () => {
  const staticNode = () =>
    node({
      id: "mig-node",
      gpuCount: 1,
      migMode: "static",
      staticLayout: ["3g.40gb", "3g.40gb", "1g.10gb"], // Σ slices = 7
    });

  it("places requests for profiles in the layout by reusing instances", () => {
    const wl = workload({
      id: "infer",
      gpuRequest: { kind: "mig", profile: "3g.40gb", count: 1 },
      replicas: 2, // consumes both 3g instances
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
    expect(gpu.instances.filter((i) => !i.allocatedTo).length).toBe(1); // only the 1g remains
  });

  it("fails requests for profiles missing from the layout with failReason='mig-no-instance'", () => {
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

  it("also reports 'mig-no-instance' when count exceeds the available instances", () => {
    const wl = workload({
      id: "many",
      gpuRequest: { kind: "mig", profile: "1g.10gb", count: 2 }, // only one 1g exists
    });

    const { placements } = simulate([staticNode()], [wl], {
      strategy: "binpack",
    });
    expect(placements[0].failReason).toBe("mig-no-instance");
  });
});

// ---------- 6. full requests against partition-locked nodes ----------

describe("full requests vs partitioned GPUs", () => {
  it("reports failReason='mig-mode-mismatch' when enough GPUs exist but all are partitioned", () => {
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

  it("reports failReason='gpu' when GPUs are simply too few, partitioning aside", () => {
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
      gpuRequest: { kind: "full", count: 2 }, // even unlocked there is only 1 GPU
    });

    const { placements } = simulate(nodes, [wl], { strategy: "binpack" });
    expect(placements[0].failReason).toBe("gpu");
  });
});

// ---------- 4. dynamic MIG carving ----------

describe("dynamic MIG carving", () => {
  it("carves one GPU into 1g×7 for a 1g.10gb ×3 request: 3 allocated, 4 left unallocated", () => {
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
    expect(carved.staticPartitioned).toBeUndefined(); // carving gets no lock icon
    expect(carved.instances).toHaveLength(7); // 1g×7 homogeneous
    expect(carved.instances.filter((i) => i.allocatedTo).length).toBe(3);
    expect(carved.instances.filter((i) => !i.allocatedTo).length).toBe(4);

    // the second GPU stays intact (reuse takes priority over carving)
    const untouched = gpuStates.find((g) => g.gpuIndex === 1)!;
    expect(untouched.mode).toBe("whole");
    expect(untouched.wholeAllocatedTo).toBeUndefined();
  });

  it("carves 2g profiles into floor(7/2)=3 instances, leaving 1 residual slice", () => {
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

  it("reports failReason='mig-cannot-carve' when no whole GPU is left to carve", () => {
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

  it("cannot place MIG requests on migCapable=false models (failReason='model')", () => {
    const nodes = [node({ id: "l40s", gpuModel: "L40S-48GB", migMode: "dynamic" })];
    const wl = workload({
      id: "mig-wl",
      gpuRequest: { kind: "mig", profile: "1g.10gb", count: 1 },
    });

    const { placements } = simulate(nodes, [wl], { strategy: "binpack" });
    expect(placements[0].failReason).toBe("model");
  });
});

// ---------- 5. full-first ordering ----------

describe("full requests place before MIG requests when mixed", () => {
  it("succeeds for every pod only because full places first, regardless of input order", () => {
    // Nodes A (2 GPUs) and B (1 GPU), both dynamic.
    // Placing in raw input order: the MIG request carves A's GPU via the
    // tie-break → no node can take full×2 anymore → failure.
    // With full-first ordering: full×2 → A, MIG carves B → everyone succeeds.
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

  it("orders MIG requests among themselves by profile slices descending", () => {
    // Single-GPU dynamic node: unless 4g carves first (i.e. if 1g carves
    // first), the 4g request fails. With slices-descending order, 4g carves
    // the GPU first → 1g has no GPU left to carve and fails.
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

  it("binpack consolidates onto already-occupied nodes", () => {
    const { placements } = simulate(nodes(), [wl()], { strategy: "binpack" });
    const ids = placementsOf(placements, "svc").map((p) => p.nodeId);
    expect(ids[0]).not.toBeNull();
    expect(ids[0]).toBe(ids[1]); // same node
  });

  it("spread distributes evenly across nodes", () => {
    const { placements } = simulate(nodes(), [wl()], { strategy: "spread" });
    const ids = placementsOf(placements, "svc").map((p) => p.nodeId);
    expect(ids[0]).not.toBeNull();
    expect(ids[1]).not.toBeNull();
    expect(ids[0]).not.toBe(ids[1]); // different nodes
  });
});
