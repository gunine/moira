# Moira — GPU Cluster Capacity Simulator

Given a set of node pools and a workload list, Moira runs a simplified
kube-scheduler-style bin-packing simulation, computes placement results, and
visualizes GPU occupancy including MIG partitioning.

Its core value is **telling you which resource or constraint is the bottleneck
when placement fails** — not just "failed", but whether it was a GPU shortage,
a vCPU bottleneck, or GPUs locked away by MIG partitioning, explained in
human-readable sentences.

There is no backend; every simulation runs in the browser as pure functions.

## Running

```bash
npm install
npm run dev      # dev server (http://localhost:5173)
npm test         # vitest — 18 tests for the simulation logic
npm run build    # typecheck + production build
```

## Deployment (GitHub Pages)

Served under `https://<account>.github.io/moira/`.
`base: "/moira/"` applies only to production builds, so local development
(`npm run dev`) keeps working from the `http://localhost:5173/` root.

**One-time setup** — in the GitHub repository web UI:

1. Change **Settings → Pages → Build and deployment → Source** to **"GitHub Actions"**

**Automatic deploys afterwards** — pushing to the `main` branch runs
[.github/workflows/deploy.yml](.github/workflows/deploy.yml):

```
npm ci → npm test → npm run build → upload dist → deploy to GitHub Pages
```

If any test fails, the workflow stops without building or deploying.
Deployment status is visible in the repository's **Actions** tab.

## UI layout

**Top header**
- Placement strategy toggle (binpack / spread)
- Language toggle (한국어 / English) — the choice is saved to localStorage;
  first visits follow the browser language
- Light/dark theme toggle — the choice is saved to localStorage; first visits
  follow the OS preference

**Left — input panel**
- Node pool table: GPU model (H100-80GB / A100-40GB / L40S-48GB), GPU count,
  vCPU, memory, number of identical nodes, MIG mode (disabled / static / dynamic)
- Static-mode layout builder: adding profiles fills a slice gauge up to 7, and
  profiles that would overflow have their add button disabled
- Workload table: Full GPU / MIG profile request toggle, vCPU/memory/replicas,
  model constraint
- 3 presets
- Every input is auto-saved to and restored from localStorage

**Center — GPU heatmap** (CSS Grid, no chart library)
- 1 node = 1 card, 1 GPU = a horizontal 7-cell slice bar
- Whole allocations fill all 7 cells with the workload color; MIG instances
  are blocks sized by slice width (allocated = workload color, unallocated
  instance = dashed outline, uncarved residual slices = gray)
- Statically pre-partitioned GPUs show a 🔒; hovering shows a
  workload/profile tooltip
- vCPU/memory occupancy meters at the bottom of each card

**Right — result summary**
- Placement success rate, slice-level GPU utilization, average node occupancy
- Placement failure list: per-workload failure reasons as sentences
- Fragmentation report: unallocated-slice breakdown (idle whole GPUs /
  unallocated instances / residual slices), plus the smallest profile the
  current state cannot accept

## Simulation model

All logic is isolated as pure functions in [src/simulate.ts](src/simulate.ts).
For a detailed walkthrough with diagrams, see
[docs/how-it-works.md](docs/how-it-works.md).

```ts
simulate(nodes: NodeSpec[], workloads: WorkloadSpec[], { strategy: "binpack" | "spread" })
  => { placements, gpuStates, nodeStates }
```

**Preprocessing**
1. Expand each node pool into `count` individual nodes
2. Nodes with `migMode: "static"` pre-partition all GPUs per `staticLayout`
   (partitioned GPUs cannot take whole allocations)
3. Sort workloads: full requests (GPU count descending) → MIG requests
   (profile slices descending). Placing full requests first keeps dynamic
   nodes' intact GPUs from being consumed by MIG carving

**Per-pod placement**
- Full requests: among nodes with at least `count` unallocated whole GPUs,
  enough remaining vCPU/memory, and a passing model constraint, pick by
  strategy score (binpack = most-utilized node, spread = least-utilized)
- MIG requests: ① reuse a node with enough unallocated instances of the
  profile (preferred over carving) → ② otherwise carve one unused whole GPU
  on a dynamic node with the homogeneous policy
  (e.g. 1g request → 1g×7, 2g request → 2g×3 + 1 residual slice)
- vCPU/memory are deducted from node-level totals regardless of MIG

**Failure reason (failReason) breakdown**

| Reason | Meaning |
|---|---|
| `gpu` | No node has as many whole GPUs as requested |
| `mig-mode-mismatch` | Enough GPUs, but they are locked by MIG partitioning and cannot serve whole allocations |
| `vcpu` / `memory` | GPUs are available, but remaining vCPU/memory falls short |
| `model` | Model constraint mismatch, or a MIG request against a model without MIG support (L40S) |
| `mig-no-instance` | No unallocated instances (static nodes never carve new ones) |
| `mig-cannot-carve` | No unused whole GPU left to carve on dynamic nodes |

**Determinism rules (implementation choices beyond the spec)**
- Strategy score ties pick the node earlier in expansion order — the same
  input always yields the same result
- When vCPU and memory shortages are mixed, each node reports its first
  lacking resource; `memory` is reported only when every node lacks memory
- `mig-mode-mismatch` is reported only when the request would fit if
  "partitioned GPUs whose instances are all unallocated" were reverted to
  whole GPUs

**Layout validation**: isolated in `isValidLayout(gpuModel, profiles)`
([src/catalog.ts](src/catalog.ts)). v1 checks only the "Σ slices ≤ 7"
slice-sum model; to switch to NVIDIA's allowed-combination table, replace
just this function.

## Project structure

```
src/
  types.ts            Data model (nodes/workloads/placement results)
  catalog.ts          GPU catalog seed + isValidLayout
  simulate.ts         Placement simulation (pure functions)
  simulate.test.ts    18 vitest tests
  presets.ts          3 preset scenarios
  i18n.ts             UI message catalog (Korean/English) + language hook
  App.tsx             State management + localStorage
  ui/
    InputPanel.tsx    Node pool/workload/strategy inputs
    Heatmap.tsx       GPU slice heatmap
    SummaryPanel.tsx  Result summary + fragmentation report
    colors.ts         Workload color slot assignment (pinned to id, no cycling)
```

## Limitations (v1)

- MIG layout validation is a slice-sum approximation — real NVIDIA allowed
  combinations and placement-position constraints are not modeled
- Carving tries at most one GPU per pod (no single-pod MIG carving across
  multiple GPUs)
- The scheduler score reflects only GPU slice occupancy (vCPU/memory act as
  filters only)
