import { createContext, useContext } from "react";

// ---------- UI localization (Korean / English) ----------

export type Lang = "ko" | "en";

export const LANG_KEY = "moira:lang";

/**
 * Flat message catalog. Every user-facing UI string lives here so the two
 * languages stay in sync — TypeScript errors out if a key misses a language.
 * `{name}`-style placeholders are substituted by `translate()`.
 */
const MESSAGES = {
  "app.title": {
    en: "Moira — GPU Cluster Capacity Simulator",
    ko: "Moira — GPU 클러스터 용량 시뮬레이터",
  },
  "app.subtitle": {
    en: "GPU cluster capacity simulator",
    ko: "GPU 클러스터 용량 시뮬레이터",
  },
  "app.simError": { en: "Simulation error", ko: "시뮬레이션 오류" },

  // Header
  "header.strategy": { en: "Placement strategy", ko: "배치 전략" },
  "header.binpackHint": { en: "consolidate", ko: "몰아넣기" },
  "header.spreadHint": { en: "distribute", ko: "분산" },
  "header.toDark": { en: "Switch to dark theme", ko: "다크 테마로 전환" },
  "header.toLight": { en: "Switch to light theme", ko: "라이트 테마로 전환" },
  "header.dark": { en: "🌙 Dark", ko: "🌙 다크" },
  "header.light": { en: "☀️ Light", ko: "☀️ 라이트" },

  // Input panel
  "input.presets": { en: "Presets", ko: "프리셋" },
  "input.nodePools": { en: "Node pools", ko: "노드 풀" },
  "input.workloads": { en: "Workloads", ko: "워크로드" },
  "input.addPool": { en: "+ Add pool", ko: "+ 풀 추가" },
  "input.addWorkload": { en: "+ Add workload", ko: "+ 워크로드 추가" },
  "input.noNodes": { en: "Add a node pool.", ko: "노드 풀을 추가하세요." },
  "input.noWorkloads": { en: "Add a workload.", ko: "워크로드를 추가하세요." },
  "input.poolName": { en: "Node pool name", ko: "노드 풀 이름" },
  "input.removePool": { en: "Remove pool", ko: "풀 삭제" },
  "input.workloadName": { en: "Workload name", ko: "워크로드 이름" },
  "input.removeWorkload": { en: "Remove workload", ko: "워크로드 삭제" },
  "field.gpuModel": { en: "GPU model", ko: "GPU 모델" },
  "field.gpusPerNode": { en: "GPUs/node", ko: "GPU/노드" },
  "field.vcpu": { en: "vCPU", ko: "vCPU" },
  "field.memoryGiB": { en: "Memory (GiB)", ko: "메모리(GiB)" },
  "field.nodeCount": { en: "Nodes", ko: "노드 수" },
  "field.migMode": { en: "MIG mode", ko: "MIG 모드" },
  "field.gpuRequest": { en: "GPU request", ko: "GPU 요청" },
  "field.gpuCount": { en: "GPUs", ko: "GPU 수" },
  "field.profile": { en: "Profile", ko: "프로파일" },
  "field.instanceCount": { en: "Instances", ko: "인스턴스 수" },
  "field.replicas": { en: "replicas", ko: "replicas" },
  "field.modelConstraint": { en: "Model constraint", ko: "모델 제약" },
  "field.noConstraint": { en: "None", ko: "없음" },
  "field.migProfile": { en: "MIG profile", ko: "MIG 프로파일" },
  "mig.notSupported": {
    en: "This model does not support MIG",
    ko: "이 모델은 MIG를 지원하지 않습니다",
  },

  // Static layout builder
  "layout.title": { en: "Static layout per GPU", ko: "GPU당 static 레이아웃" },
  "layout.removeChip": { en: "Click to remove", ko: "클릭하여 제거" },
  "layout.addChip": { en: "Add {slices} slice(s)", ko: "{slices} slice 추가" },
  "layout.overflow": {
    en: "Exceeds 7 slices — cannot add",
    ko: "slice 7 초과 — 추가 불가",
  },
  "layout.empty": {
    en: "With an empty layout, GPUs stay unpartitioned.",
    ko: "레이아웃이 비어 있으면 GPU가 파티셔닝되지 않습니다.",
  },

  // Heatmap
  "heatmap.legend": { en: "Workload legend", ko: "워크로드 범례" },
  "heatmap.noNodes": { en: "No nodes to display.", ko: "표시할 노드가 없습니다." },
  "tip.wholeAlloc": {
    en: "{name} #{index} · occupies whole GPU",
    ko: "{name} #{index} · GPU 전체 점유",
  },
  "tip.idleWhole": { en: "Unused GPU (whole)", ko: "미사용 GPU (whole)" },
  "tip.freeInstance": {
    en: "Unallocated instance · {profile}",
    ko: "미할당 인스턴스 · {profile}",
  },
  "tip.residual": {
    en: "Uncarved residual slices ×{count}",
    ko: "커빙되지 않은 잔여 slice ×{count}",
  },

  // Summary panel
  "summary.results": { en: "Placement results", ko: "배치 결과" },
  "summary.successRate": { en: "Placement success rate", ko: "배치 성공률" },
  "summary.successDetail": {
    en: "{placed} of {total} pods placed",
    ko: "파드 {total}개 중 {placed}개 배치",
  },
  "summary.gpuUtil": { en: "GPU utilization (slices)", ko: "GPU 활용률 (slice)" },
  "summary.sliceRatio": { en: "{used}/{total} slices", ko: "{used}/{total} slice" },
  "summary.avgNodeUtil": { en: "Avg node occupancy", ko: "노드 평균 점유율" },
  "summary.nodeBasis": { en: "across {count} nodes", ko: "노드 {count}개 기준" },
  "summary.failures": { en: "Placement failures", ko: "배치 실패" },
  "summary.allPlaced": {
    en: "✓ All pods were placed",
    ko: "✓ 모든 파드가 배치되었습니다",
  },
  "summary.noWorkloads": { en: "No workloads", ko: "워크로드가 없습니다" },
  "summary.failMeta": { en: "{count} pod(s) · {reason}", ko: "파드 {count}개 · {reason}" },
  "summary.viewJson": { en: "View result JSON", ko: "결과 JSON 보기" },

  // Failure reasons → human-readable sentences
  "fail.gpu": {
    en: "No node can provide {count} whole GPU(s) (not enough GPUs)",
    ko: "온전한 GPU {count}개를 확보할 수 있는 노드가 없습니다 (GPU 부족)",
  },
  "fail.vcpu": {
    en: "GPUs are available, but not enough vCPU remains",
    ko: "GPU는 확보할 수 있지만 vCPU 잔량이 부족합니다",
  },
  "fail.memory": {
    en: "GPUs are available, but not enough memory remains",
    ko: "GPU는 확보할 수 있지만 메모리 잔량이 부족합니다",
  },
  "fail.modelConstrained": {
    en: "No '{model}' nodes exist, or that model does not support this request",
    ko: "'{model}' 모델 노드가 없거나 해당 모델이 이 요청을 지원하지 않습니다",
  },
  "fail.model": {
    en: "No node has a GPU model that supports this request",
    ko: "이 요청을 지원하는 GPU 모델 노드가 없습니다",
  },
  "fail.migNoInstance": {
    en: "No unallocated '{profile}' instances — static nodes never carve new ones",
    ko: "'{profile}' 미할당 인스턴스가 없습니다 — static 노드는 새로 커빙하지 않습니다",
  },
  "fail.requestedProfile": { en: "requested profile", ko: "요청 프로파일" },
  "fail.migCannotCarve": {
    en: "No unused whole GPU left to carve on dynamic nodes",
    ko: "dynamic 노드에 커빙할 미사용 whole GPU가 없습니다",
  },
  "fail.migModeMismatch": {
    en: "Enough GPUs exist, but they are locked by MIG partitioning and cannot serve whole-GPU requests",
    ko: "GPU 수는 충분하지만 MIG 파티셔닝으로 잠겨 있어 whole GPU로 사용할 수 없습니다",
  },

  // Fragmentation report
  "frag.title": { en: "Fragmentation", ko: "프래그멘테이션" },
  "frag.unallocated": { en: "Total unallocated slices", ko: "미할당 slice 총수" },
  "frag.idleWhole": { en: "└ Idle whole GPUs", ko: "└ 유휴 whole GPU" },
  "frag.idleWholeValue": {
    en: "{count} ({slices} slices)",
    ko: "{count}개 ({slices} slice)",
  },
  "frag.freeInstances": {
    en: "└ Unallocated MIG instances",
    ko: "└ 미할당 MIG 인스턴스",
  },
  "frag.residual": {
    en: "└ Uncarved residual slices",
    ko: "└ 커빙되지 않은 잔여 slice",
  },
  "frag.slices": { en: "{count} slices", ko: "{count} slice" },
  "frag.nodesWithFree": {
    en: "Nodes with usable free capacity",
    ko: "여유가 남은 노드",
  },
  "frag.nodesWithFreeValue": { en: "{free}/{total}", ko: "{free}/{total}개" },
  "frag.freeInstanceNote": {
    en: "Unallocated instances: {list}",
    ko: "미할당 인스턴스: {list}",
  },
  "frag.residualNote": {
    en: "{count} residual slice(s) cannot be used without repartitioning.",
    ko: "잔여 slice {count}개는 재파티셔닝 없이는 사용할 수 없습니다.",
  },
  "frag.smallestRejected": {
    en: "smallest profile it cannot accept is '{profile}'",
    ko: "최소 '{profile}' 프로파일부터 수용 불가",
  },
  "frag.allAccepted": {
    en: "can accept every profile",
    ko: "모든 프로파일 수용 가능",
  },
} as const satisfies Record<string, Record<Lang, string>>;

export type MessageKey = keyof typeof MESSAGES;

export type Translator = (
  key: MessageKey,
  params?: Record<string, string | number>,
) => string;

export function translate(
  lang: Lang,
  key: MessageKey,
  params?: Record<string, string | number>,
): string {
  let msg: string = MESSAGES[key][lang];
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      msg = msg.replaceAll(`{${k}}`, String(v));
    }
  }
  return msg;
}

export const I18nContext = createContext<Lang>("en");

export function useI18n(): { lang: Lang; t: Translator } {
  const lang = useContext(I18nContext);
  return {
    lang,
    t: (key, params) => translate(lang, key, params),
  };
}

/** Saved choice first; otherwise follow the browser language. */
export function initialLang(): Lang {
  try {
    const saved = localStorage.getItem(LANG_KEY);
    if (saved === "ko" || saved === "en") return saved;
  } catch {
    // localStorage unavailable — fall back to the browser language
  }
  return navigator.language?.toLowerCase().startsWith("ko") ? "ko" : "en";
}
