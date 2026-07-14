import { GPU_CATALOG, getGpuModel, getProfile } from "../catalog";
import { useI18n } from "../i18n";
import type { GpuModelSpec, MigMode, NodeSpec, WorkloadSpec } from "../types";
import { colorVar } from "./colors";
import { clamp, uid } from "./util";

interface Props {
  nodes: NodeSpec[];
  workloads: WorkloadSpec[];
  colorSlots: Record<string, number>;
  onNodes: (next: NodeSpec[]) => void;
  onWorkloads: (next: WorkloadSpec[]) => void;
  onPreset: (index: number) => void;
  presetLabels: string[];
}

// ---------- Shared fields ----------

function NumField(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="field">
      <span>{props.label}</span>
      <input
        type="number"
        value={props.value}
        min={props.min}
        max={props.max}
        onChange={(e) =>
          props.onChange(clamp(Number(e.target.value), props.min, props.max))
        }
      />
    </label>
  );
}

// ---------- Static layout builder ----------

function LayoutBuilder(props: {
  model: GpuModelSpec;
  layout: string[];
  onChange: (next: string[]) => void;
}) {
  const { model, layout, onChange } = props;
  const { t } = useI18n();
  const usedSlices = layout.reduce(
    (sum, name) => sum + (getProfile(model, name)?.slices ?? 0),
    0,
  );

  return (
    <div className="layout-builder">
      <div className="layout-head">
        <span>{t("layout.title")}</span>
        <span className="layout-count">
          {usedSlices}/{model.totalSlices} slice
        </span>
      </div>
      <div className="slice-gauge" aria-hidden>
        {Array.from({ length: model.totalSlices }, (_, i) => (
          <span key={i} className={i < usedSlices ? "cell on" : "cell"} />
        ))}
      </div>
      {layout.length > 0 && (
        <div className="chip-row">
          {layout.map((name, i) => (
            <button
              key={`${name}-${i}`}
              type="button"
              className="chip"
              title={t("layout.removeChip")}
              onClick={() => onChange(layout.filter((_, j) => j !== i))}
            >
              {name} ✕
            </button>
          ))}
        </div>
      )}
      <div className="chip-row">
        {model.profiles.map((p) => {
          const full = usedSlices + p.slices > model.totalSlices;
          return (
            <button
              key={p.name}
              type="button"
              className="chip add"
              disabled={full}
              title={
                full
                  ? t("layout.overflow")
                  : t("layout.addChip", { slices: p.slices })
              }
              onClick={() => onChange([...layout, p.name])}
            >
              + {p.name}
            </button>
          );
        })}
      </div>
      {layout.length === 0 && <p className="hint">{t("layout.empty")}</p>}
    </div>
  );
}

// ---------- Node pools ----------

function NodePoolCard(props: {
  node: NodeSpec;
  onChange: (patch: Partial<NodeSpec>) => void;
  onRemove: () => void;
}) {
  const { node, onChange, onRemove } = props;
  const { t } = useI18n();
  const model = getGpuModel(node.gpuModel);

  const changeModel = (name: string) => {
    const next = getGpuModel(name);
    onChange({
      gpuModel: name,
      // A model change swaps the profile scheme, so reset the layout;
      // if the new model cannot do MIG, force the mode back to disabled.
      staticLayout: undefined,
      migMode: next && !next.migCapable ? "disabled" : node.migMode,
    });
  };

  const changeMigMode = (mode: MigMode) => {
    onChange({
      migMode: mode,
      staticLayout: mode === "static" ? (node.staticLayout ?? []) : undefined,
    });
  };

  return (
    <div className="card entity-card">
      <div className="entity-head">
        <input
          className="name-input"
          value={node.name}
          onChange={(e) => onChange({ name: e.target.value })}
          aria-label={t("input.poolName")}
        />
        <button
          type="button"
          className="icon-btn"
          title={t("input.removePool")}
          onClick={onRemove}
        >
          ✕
        </button>
      </div>
      <div className="field-grid">
        <label className="field">
          <span>{t("field.gpuModel")}</span>
          <select value={node.gpuModel} onChange={(e) => changeModel(e.target.value)}>
            {GPU_CATALOG.map((m) => (
              <option key={m.model} value={m.model}>
                {m.model}
              </option>
            ))}
          </select>
        </label>
        <NumField
          label={t("field.gpusPerNode")}
          value={node.gpuCount}
          min={1}
          max={16}
          onChange={(v) => onChange({ gpuCount: v })}
        />
        <NumField
          label={t("field.vcpu")}
          value={node.vcpu}
          min={1}
          max={1024}
          onChange={(v) => onChange({ vcpu: v })}
        />
        <NumField
          label={t("field.memoryGiB")}
          value={node.memoryGiB}
          min={1}
          max={8192}
          onChange={(v) => onChange({ memoryGiB: v })}
        />
        <NumField
          label={t("field.nodeCount")}
          value={node.count}
          min={1}
          max={32}
          onChange={(v) => onChange({ count: v })}
        />
        <label className="field">
          <span>{t("field.migMode")}</span>
          <select
            value={node.migMode}
            disabled={!model?.migCapable}
            title={model?.migCapable ? undefined : t("mig.notSupported")}
            onChange={(e) => changeMigMode(e.target.value as MigMode)}
          >
            <option value="disabled">disabled</option>
            <option value="static">static</option>
            <option value="dynamic">dynamic</option>
          </select>
        </label>
      </div>
      {node.migMode === "static" && model?.migCapable && (
        <LayoutBuilder
          model={model}
          layout={node.staticLayout ?? []}
          onChange={(layout) => onChange({ staticLayout: layout })}
        />
      )}
    </div>
  );
}

// ---------- Workloads ----------

const MIG_MODELS = GPU_CATALOG.filter((m) => m.migCapable);

function WorkloadCard(props: {
  workload: WorkloadSpec;
  color: string;
  onChange: (patch: Partial<WorkloadSpec>) => void;
  onRemove: () => void;
}) {
  const { workload: w, color, onChange, onRemove } = props;
  const { t } = useI18n();

  const changeKind = (kind: "full" | "mig") => {
    if (kind === w.gpuRequest.kind) return;
    onChange({
      gpuRequest:
        kind === "full"
          ? { kind: "full", count: 1 }
          : { kind: "mig", profile: defaultProfileFor(w.gpuModelConstraint), count: 1 },
    });
  };

  const changeConstraint = (value: string) => {
    const constraint = value === "" ? undefined : value;
    const patch: Partial<WorkloadSpec> = { gpuModelConstraint: constraint };
    // If the constraint model changes while a MIG request is active,
    // realign the profile to one that model actually offers.
    if (w.gpuRequest.kind === "mig" && constraint) {
      const model = getGpuModel(constraint);
      if (model?.migCapable && !getProfile(model, w.gpuRequest.profile)) {
        patch.gpuRequest = {
          ...w.gpuRequest,
          profile: model.profiles[0].name,
        };
      }
    }
    onChange(patch);
  };

  return (
    <div className="card entity-card">
      <div className="entity-head">
        <span className="color-dot" style={{ background: color }} aria-hidden />
        <input
          className="name-input"
          value={w.name}
          onChange={(e) => onChange({ name: e.target.value })}
          aria-label={t("input.workloadName")}
        />
        <button
          type="button"
          className="icon-btn"
          title={t("input.removeWorkload")}
          onClick={onRemove}
        >
          ✕
        </button>
      </div>
      <div className="field-grid">
        <label className="field">
          <span>{t("field.gpuRequest")}</span>
          <select
            value={w.gpuRequest.kind}
            onChange={(e) => changeKind(e.target.value as "full" | "mig")}
          >
            <option value="full">Full GPU</option>
            <option value="mig">{t("field.migProfile")}</option>
          </select>
        </label>
        {w.gpuRequest.kind === "full" ? (
          <NumField
            label={t("field.gpuCount")}
            value={w.gpuRequest.count}
            min={0}
            max={16}
            onChange={(count) => onChange({ gpuRequest: { kind: "full", count } })}
          />
        ) : (
          <>
            <label className="field">
              <span>{t("field.profile")}</span>
              <select
                value={w.gpuRequest.profile}
                onChange={(e) =>
                  onChange({
                    gpuRequest: { ...w.gpuRequest, profile: e.target.value } as never,
                  })
                }
              >
                {MIG_MODELS.map((m) => (
                  <optgroup key={m.model} label={m.model}>
                    {m.profiles.map((p) => (
                      <option key={p.name} value={p.name}>
                        {p.name}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </label>
            <NumField
              label={t("field.instanceCount")}
              value={w.gpuRequest.count}
              min={1}
              max={7}
              onChange={(count) =>
                onChange({ gpuRequest: { ...w.gpuRequest, count } as never })
              }
            />
          </>
        )}
        <NumField
          label={t("field.vcpu")}
          value={w.vcpuRequest}
          min={0}
          max={1024}
          onChange={(v) => onChange({ vcpuRequest: v })}
        />
        <NumField
          label={t("field.memoryGiB")}
          value={w.memoryRequestGiB}
          min={0}
          max={8192}
          onChange={(v) => onChange({ memoryRequestGiB: v })}
        />
        <NumField
          label={t("field.replicas")}
          value={w.replicas}
          min={1}
          max={200}
          onChange={(v) => onChange({ replicas: v })}
        />
        <label className="field">
          <span>{t("field.modelConstraint")}</span>
          <select
            value={w.gpuModelConstraint ?? ""}
            onChange={(e) => changeConstraint(e.target.value)}
          >
            <option value="">{t("field.noConstraint")}</option>
            {GPU_CATALOG.map((m) => (
              <option key={m.model} value={m.model}>
                {m.model}
              </option>
            ))}
          </select>
        </label>
      </div>
    </div>
  );
}

function defaultProfileFor(constraint: string | undefined): string {
  if (constraint) {
    const model = getGpuModel(constraint);
    if (model?.migCapable && model.profiles.length > 0) return model.profiles[0].name;
  }
  return MIG_MODELS[0].profiles[0].name;
}

// ---------- Panel ----------

export default function InputPanel(props: Props) {
  const { nodes, workloads, colorSlots, onNodes, onWorkloads, onPreset, presetLabels } =
    props;
  const { t } = useI18n();

  const addNode = () =>
    onNodes([
      ...nodes,
      {
        id: uid("node"),
        name: `gpu-pool-${nodes.length + 1}`,
        gpuModel: "H100-80GB",
        gpuCount: 8,
        vcpu: 128,
        memoryGiB: 1024,
        count: 1,
        migMode: "disabled",
      },
    ]);

  const addWorkload = () =>
    onWorkloads([
      ...workloads,
      {
        id: uid("wl"),
        name: `workload-${workloads.length + 1}`,
        gpuRequest: { kind: "full", count: 1 },
        vcpuRequest: 4,
        memoryRequestGiB: 16,
        replicas: 1,
      },
    ]);

  return (
    <div className="input-panel">
      <section>
        <div className="section-head">
          <h2>{t("input.presets")}</h2>
        </div>
        <div className="preset-row">
          {presetLabels.map((label, i) => (
            <button key={label} type="button" className="preset-btn" onClick={() => onPreset(i)}>
              {label}
            </button>
          ))}
        </div>
      </section>

      <section>
        <div className="section-head">
          <h2>{t("input.nodePools")}</h2>
          <button type="button" className="add-btn" onClick={addNode}>
            {t("input.addPool")}
          </button>
        </div>
        {nodes.map((n) => (
          <NodePoolCard
            key={n.id}
            node={n}
            onChange={(patch) =>
              onNodes(nodes.map((x) => (x.id === n.id ? { ...x, ...patch } : x)))
            }
            onRemove={() => onNodes(nodes.filter((x) => x.id !== n.id))}
          />
        ))}
        {nodes.length === 0 && <p className="hint">{t("input.noNodes")}</p>}
      </section>

      <section>
        <div className="section-head">
          <h2>{t("input.workloads")}</h2>
          <button type="button" className="add-btn" onClick={addWorkload}>
            {t("input.addWorkload")}
          </button>
        </div>
        {workloads.map((w) => (
          <WorkloadCard
            key={w.id}
            workload={w}
            color={colorVar(colorSlots[w.id] ?? -1)}
            onChange={(patch) =>
              onWorkloads(workloads.map((x) => (x.id === w.id ? { ...x, ...patch } : x)))
            }
            onRemove={() => onWorkloads(workloads.filter((x) => x.id !== w.id))}
          />
        ))}
        {workloads.length === 0 && <p className="hint">{t("input.noWorkloads")}</p>}
      </section>
    </div>
  );
}
