export function uid(prefix: string): string {
  const rand =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `${prefix}-${rand}`;
}

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

export function podLabel(podId: string): { workloadId: string; index: number } {
  const at = podId.lastIndexOf("#");
  return {
    workloadId: at < 0 ? podId : podId.slice(0, at),
    index: at < 0 ? 0 : Number(podId.slice(at + 1)),
  };
}
