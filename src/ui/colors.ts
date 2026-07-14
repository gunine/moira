/**
 * 워크로드 → 카테고리 색상 슬롯 배정.
 *
 * 색은 엔티티(워크로드 id)를 따라간다: 한번 배정된 슬롯은 목록이 바뀌어도
 * 유지되고, 삭제로 비워진 슬롯만 새 워크로드가 재사용한다.
 * 팔레트는 8슬롯 고정 순서(dataviz 검증 완료)이며 절대 순환 생성하지 않는다 —
 * 9번째 이후 워크로드는 중립 "기타" 색으로 접고 범례/툴팁이 식별을 맡는다.
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
