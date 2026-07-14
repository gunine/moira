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
 * 프로파일 이름("3g.40gb")에서 slice 수를 파싱한다.
 * 모델을 모르는 문맥(워크로드 정렬 등)에서 사용.
 */
export function profileSlicesFromName(name: string): number {
  const n = parseInt(name, 10);
  return Number.isFinite(n) ? n : 0;
}

/**
 * GPU 하나에 대한 파티션 레이아웃 유효성 검사.
 *
 * v1은 "Σ slices ≤ totalSlices" 슬라이스 합산 모델만 검사한다.
 * 실제 NVIDIA MIG는 프로파일 조합/배치 위치에 제약이 있으므로,
 * 추후 허용 조합 테이블 기반 검증으로 교체하려면 이 함수만 바꾸면 된다.
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
