import type { GpuModelSpec, MigProfileSpec } from "./types";

export const GPU_CATALOG: GpuModelSpec[] = [
  {
    model: "H100-80GB",
    memoryGiB: 80,
    migCapable: true,
    totalSlices: 7,
    profiles: [
      { name: "1g.10gb", slices: 1, memoryGiB: 10 },
      { name: "2g.20gb", slices: 2, memoryGiB: 20 },
      { name: "3g.40gb", slices: 3, memoryGiB: 40 },
      { name: "4g.40gb", slices: 4, memoryGiB: 40 },
      { name: "7g.80gb", slices: 7, memoryGiB: 80 },
    ],
  },
  {
    model: "A100-40GB",
    memoryGiB: 40,
    migCapable: true,
    totalSlices: 7,
    profiles: [
      { name: "1g.5gb", slices: 1, memoryGiB: 5 },
      { name: "2g.10gb", slices: 2, memoryGiB: 10 },
      { name: "3g.20gb", slices: 3, memoryGiB: 20 },
      { name: "7g.40gb", slices: 7, memoryGiB: 40 },
    ],
  },
  {
    model: "L40S-48GB",
    memoryGiB: 48,
    migCapable: false,
    totalSlices: 7,
    profiles: [],
  },
];

export function getGpuModel(model: string): GpuModelSpec | undefined {
  return GPU_CATALOG.find((m) => m.model === model);
}

export function getProfile(
  model: GpuModelSpec,
  profileName: string,
): MigProfileSpec | undefined {
  return model.profiles.find((p) => p.name === profileName);
}

/**
 * Parse the slice count from a profile name ("3g.40gb").
 * Used in contexts that don't know the GPU model (e.g. workload sorting).
 */
export function profileSlicesFromName(name: string): number {
  const n = parseInt(name, 10);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Validate a partition layout for a single GPU.
 *
 * v1 only checks the slice-sum model: "Σ slices ≤ totalSlices".
 * Real NVIDIA MIG constrains profile combinations and placement positions,
 * so swapping in an allowed-combination table later only requires replacing
 * this one function.
 */
export function isValidLayout(
  gpuModel: GpuModelSpec,
  profiles: string[],
): boolean {
  if (!gpuModel.migCapable) return false;
  let used = 0;
  for (const name of profiles) {
    const p = getProfile(gpuModel, name);
    if (!p) return false;
    used += p.slices;
  }
  return used <= gpuModel.totalSlices;
}
