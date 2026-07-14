import { useEffect, useMemo, useRef, useState } from "react";
import { DEFAULT_STATE, PRESETS } from "./presets";
import type { AppState } from "./presets";
import { simulate } from "./simulate";
import type { SimulationResult, Strategy } from "./types";
import { assignColorSlots } from "./ui/colors";
import Heatmap from "./ui/Heatmap";
import InputPanel from "./ui/InputPanel";
import SummaryPanel from "./ui/SummaryPanel";

const STORAGE_KEY = "moira:v1";

function loadInitialState(): AppState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_STATE;
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !Array.isArray((parsed as AppState).nodes) ||
      !Array.isArray((parsed as AppState).workloads)
    ) {
      return DEFAULT_STATE;
    }
    const s = parsed as AppState;
    return {
      nodes: s.nodes.filter((n) => n && typeof n.id === "string"),
      workloads: s.workloads.filter(
        (w) => w && typeof w.id === "string" && w.gpuRequest != null,
      ),
      strategy: s.strategy === "spread" ? "spread" : "binpack",
    };
  } catch {
    return DEFAULT_STATE;
  }
}

export default function App() {
  const [state, setState] = useState<AppState>(loadInitialState);

  // 입력 자동 저장
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // 저장 불가(사파리 프라이빗 모드 등)여도 앱은 동작해야 한다
    }
  }, [state]);

  // 색상 슬롯은 워크로드 id에 고정 배정 — 목록이 바뀌어도 기존 색은 유지
  const slotsRef = useRef<Record<string, number>>({});
  const colorSlots = useMemo(() => {
    const next = assignColorSlots(
      state.workloads.map((w) => w.id),
      slotsRef.current,
    );
    slotsRef.current = next;
    return next;
  }, [state.workloads]);

  const result = useMemo<SimulationResult | null>(() => {
    try {
      return simulate(state.nodes, state.workloads, { strategy: state.strategy });
    } catch {
      return null;
    }
  }, [state.nodes, state.workloads, state.strategy]);

  return (
    <div className="app">
      <header className="app-header">
        <h1>Moira</h1>
        <span className="subtitle">GPU 클러스터 용량 시뮬레이터</span>
      </header>
      <main className="columns">
        <div className="col col-input">
          <InputPanel
            nodes={state.nodes}
            workloads={state.workloads}
            strategy={state.strategy}
            colorSlots={colorSlots}
            onNodes={(nodes) => setState((s) => ({ ...s, nodes }))}
            onWorkloads={(workloads) => setState((s) => ({ ...s, workloads }))}
            onStrategy={(strategy: Strategy) => setState((s) => ({ ...s, strategy }))}
            onPreset={(i) => setState(PRESETS[i].build())}
            presetLabels={PRESETS.map((p) => p.label)}
          />
        </div>
        <div className="col col-center">
          {result ? (
            <Heatmap
              nodeStates={result.nodeStates}
              gpuStates={result.gpuStates}
              workloads={state.workloads}
              colorSlots={colorSlots}
            />
          ) : (
            <p className="hint">시뮬레이션 오류</p>
          )}
        </div>
        <div className="col col-summary">
          {result ? (
            <SummaryPanel
              result={result}
              workloads={state.workloads}
              colorSlots={colorSlots}
            />
          ) : (
            <p className="hint">시뮬레이션 오류</p>
          )}
        </div>
      </main>
    </div>
  );
}
