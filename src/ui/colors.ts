/**
 * Workload → categorical color slot assignment.
 *
 * Colors follow the entity (workload id): once assigned, a slot survives
 * list edits, and only slots freed by deletion get reused by new workloads.
 * The palette is a fixed 8-slot sequence (dataviz-validated) and never
 * cycles — workloads beyond the 8th fold into a neutral "other" color and
 * the legend/tooltips carry identification.
 */

export const SERIES_SLOTS = 8;

export function colorVar(slot: number): string {
  return slot >= 0 && slot < SERIES_SLOTS
    ? `var(--series-${slot})`
    : "var(--series-other)";
}

export function assignColorSlots(
  workloadIds: string[],
  prev: Record<string, number>,
): Record<string, number> {
  const next: Record<string, number> = {};
  const used = new Set<number>();
  for (const id of workloadIds) {
    const slot = prev[id];
    if (slot !== undefined) {
      next[id] = slot;
      if (slot >= 0) used.add(slot);
    }
  }
  for (const id of workloadIds) {
    if (next[id] !== undefined) continue;
    let s = 0;
    while (used.has(s)) s += 1;
    if (s < SERIES_SLOTS) {
      next[id] = s;
      used.add(s);
    } else {
      next[id] = -1;
    }
  }
  return next;
}
