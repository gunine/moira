import { useEffect, useMemo, useRef, useState } from "react";
import { I18nContext, LANG_KEY, initialLang, translate } from "./i18n";
import type { Lang } from "./i18n";
import { PRESETS, defaultState } from "./presets";
import type { AppState } from "./presets";
import { simulate } from "./simulate";
import type { SimulationResult } from "./types";
import { assignColorSlots } from "./ui/colors";
import Heatmap from "./ui/Heatmap";
import InputPanel from "./ui/InputPanel";
import SummaryPanel from "./ui/SummaryPanel";

const STORAGE_KEY = "moira:v1";
const THEME_KEY = "moira:theme";

type Theme = "light" | "dark";

function initialTheme(): Theme {
  // Prefer the value the bootstrap script in index.html already applied
  const applied = document.documentElement.dataset.theme;
  if (applied === "dark" || applied === "light") return applied;
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === "dark" || saved === "light") return saved;
  } catch {
    // localStorage unavailable — fall back to the OS preference
  }
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function loadInitialState(lang: Lang): AppState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState(lang);
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !Array.isArray((parsed as AppState).nodes) ||
      !Array.isArray((parsed as AppState).workloads)
    ) {
      return defaultState(lang);
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
    return defaultState(lang);
  }
}

export default function App() {
  const [lang, setLang] = useState<Lang>(initialLang);
  const [state, setState] = useState<AppState>(() => loadInitialState(lang));
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const t = (key: Parameters<typeof translate>[1], params?: Record<string, string | number>) =>
    translate(lang, key, params);

  // Auto-save inputs
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // The app must keep working even if saving fails (e.g. Safari private mode)
    }
  }, [state]);

  // Apply + persist theme
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      // Persisting failed, but the current session still gets the theme
    }
  }, [theme]);

  // Apply + persist language
  useEffect(() => {
    document.documentElement.lang = lang;
    document.title = translate(lang, "app.title");
    try {
      localStorage.setItem(LANG_KEY, lang);
    } catch {
      // Persisting failed, but the current session still gets the language
    }
  }, [lang]);

  // Color slots are pinned to workload ids — existing colors survive list edits
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
    <I18nContext.Provider value={lang}>
      <div className="app">
        <header className="app-header">
          <div className="brand">
            <h1>Moira</h1>
            <span className="subtitle">{t("app.subtitle")}</span>
          </div>
          <div className="header-spacer" />
          <span className="header-label">{t("header.strategy")}</span>
          <div className="segmented" role="radiogroup" aria-label={t("header.strategy")}>
            <button
              type="button"
              className={state.strategy === "binpack" ? "on" : ""}
              onClick={() => setState((s) => ({ ...s, strategy: "binpack" }))}
            >
              binpack <small>{t("header.binpackHint")}</small>
            </button>
            <button
              type="button"
              className={state.strategy === "spread" ? "on" : ""}
              onClick={() => setState((s) => ({ ...s, strategy: "spread" }))}
            >
              spread <small>{t("header.spreadHint")}</small>
            </button>
          </div>
          <button
            type="button"
            className="theme-btn"
            onClick={() => setLang((l) => (l === "ko" ? "en" : "ko"))}
            aria-label={lang === "ko" ? "Switch to English" : "한국어로 전환"}
          >
            {lang === "ko" ? "🌐 EN" : "🌐 한국어"}
          </button>
          <button
            type="button"
            className="theme-btn"
            onClick={() => setTheme((th) => (th === "light" ? "dark" : "light"))}
            aria-label={theme === "light" ? t("header.toDark") : t("header.toLight")}
          >
            {theme === "light" ? t("header.dark") : t("header.light")}
          </button>
        </header>
        <main className="columns">
          <div className="col col-input">
            <InputPanel
              nodes={state.nodes}
              workloads={state.workloads}
              colorSlots={colorSlots}
              onNodes={(nodes) => setState((s) => ({ ...s, nodes }))}
              onWorkloads={(workloads) => setState((s) => ({ ...s, workloads }))}
              onPreset={(i) => setState(PRESETS[i].build(lang))}
              presetLabels={PRESETS.map((p) => p.label[lang])}
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
              <p className="hint">{t("app.simError")}</p>
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
              <p className="hint">{t("app.simError")}</p>
            )}
          </div>
        </main>
      </div>
    </I18nContext.Provider>
  );
}
