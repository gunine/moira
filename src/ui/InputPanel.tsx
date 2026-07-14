import { GPU_CATALOG, getGpuModel, getProfile } from "../catalog";
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

// ---------- 공용 필드 ----------

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

// ---------- static 레이아웃 빌더 ----------

function LayoutBuilder(props: {
  model: GpuModelSpec;
  layout: string[];
  onChange: (next: string[]) => void;
}) {
  const { model, layout, onChange } = props;
  const usedSlices = layout.reduce(
    (sum, name) => sum + (getProfile(model, name)?.slices ?? 0),
    0,
  );

  return (
    <div className="layout-builder">
      <div className="layout-head">
        <span>GPU당 static 레이아웃</span>
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
              title="클릭하여 제거"
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
              title={full ? "slice 7 초과 — 추가 불가" : `${p.slices} slice 추가`}
              onClick={() => onChange([...layout, p.name])}
            >
              + {p.name}
            </button>
          );
        })}
      </div>
      {layout.length === 0 && (
        <p className="hint">레이아웃이 비어 있으면 GPU가 파티셔닝되지 않습니다.</p>
      )}
    </div>
  );
}

// ---------- 노드 풀 ----------

function NodePoolCard(props: {
  node: NodeSpec;
  onChange: (patch: Partial<NodeSpec>) => void;
  onRemove: () => void;
}) {
  const { node, onChange, onRemove } = props;
  const model = getGpuModel(node.gpuModel);

  const changeModel = (name: string) => {
    const next = getGpuModel(name);
    onChange({
      gpuModel: name,
      // 모델이 바뀌면 프로파일 체계가 달라지므로 레이아웃은 초기화,
      // MIG 미지원 모델이면 모드도 disabled로 되돌린다.
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
          aria-label="노드 풀 이름"
        />
        <button type="button" className="icon-btn" title="풀 삭제" onClick={onRemove}>
          ✕
        </button>
      </div>
      <div className="field-grid">
        <label className="field">
          <span>GPU 모델</span>
          <select value={node.gpuModel} onChange={(e) => changeModel(e.target.value)}>
            {GPU_CATALOG.map((m) => (
              <option key={m.model} value={m.model}>
                {m.model}
              </option>
            ))}
          </select>
        </label>
        <NumField
          label="GPU/노드"
          value={node.gpuCount}
          min={1}
          max={16}
          onChange={(v) => onChange({ gpuCount: v })}
        />
        <NumField
          label="vCPU"
          value={node.vcpu}
          min={1}
          max={1024}
          onChange={(v) => onChange({ vcpu: v })}
        />
        <NumField
          label="메모리(GiB)"
          value={node.memoryGiB}
          min={1}
          max={8192}
          onChange={(v) => onChange({ memoryGiB: v })}
        />
        <NumField
          label="노드 수"
          value={node.count}
          min={1}
          max={32}
          onChange={(v) => onChange({ count: v })}
        />
        <label className="field">
          <span>MIG 모드</span>
          <select
            value={node.migMode}
            disabled={!model?.migCapable}
            title={model?.migCapable ? undefined : "이 모델은 MIG를 지원하지 않습니다"}
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

// ---------- 워크로드 ----------

const MIG_MODELS = GPU_CATALOG.filter((m) => m.migCapable);

function WorkloadCard(props: {
  workload: WorkloadSpec;
  color: string;
  onChange: (patch: Partial<WorkloadSpec>) => void;
  onRemove: () => void;
}) {
  const { workload: w, color, onChange, onRemove } = props;

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
    // MIG 요청 중에 제약 모델이 바뀌면 해당 모델의 프로파일로 맞춰준다.
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
          aria-label="워크로드 이름"
        />
        <button type="button" className="icon-btn" title="워크로드 삭제" onClick={onRemove}>
          ✕
        </button>
      </div>
      <div className="field-grid">
        <label className="field">
          <span>GPU 요청</span>
          <select
            value={w.gpuRequest.kind}
            onChange={(e) => changeKind(e.target.value as "full" | "mig")}
          >
            <option value="full">Full GPU</option>
            <option value="mig">MIG 프로파일</option>
          </select>
        </label>
        {w.gpuRequest.kind === "full" ? (
          <NumField
            label="GPU 수"
            value={w.gpuRequest.count}
            min={0}
            max={16}
            onChange={(count) => onChange({ gpuRequest: { kind: "full", count } })}
          />
        ) : (
          <>
            <label className="field">
              <span>프로파일</span>
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
              label="인스턴스 수"
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
          label="vCPU"
          value={w.vcpuRequest}
          min={0}
          max={1024}
          onChange={(v) => onChange({ vcpuRequest: v })}
        />
        <NumField
          label="메모리(GiB)"
          value={w.memoryRequestGiB}
          min={0}
          max={8192}
          onChange={(v) => onChange({ memoryRequestGiB: v })}
        />
        <NumField
          label="replicas"
          value={w.replicas}
          min={1}
          max={200}
          onChange={(v) => onChange({ replicas: v })}
        />
        <label className="field">
          <span>모델 제약</span>
          <select
            value={w.gpuModelConstraint ?? ""}
            onChange={(e) => changeConstraint(e.target.value)}
          >
            <option value="">없음</option>
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

// ---------- 패널 ----------

export default function InputPanel(props: Props) {
  const { nodes, workloads, colorSlots, onNodes, onWorkloads, onPreset, presetLabels } =
    props;

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
          <h2>프리셋</h2>
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
          <h2>노드 풀</h2>
          <button type="button" className="add-btn" onClick={addNode}>
            + 풀 추가
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
        {nodes.length === 0 && <p className="hint">노드 풀을 추가하세요.</p>}
      </section>

      <section>
        <div className="section-head">
          <h2>워크로드</h2>
          <button type="button" className="add-btn" onClick={addWorkload}>
            + 워크로드 추가
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
        {workloads.length === 0 && <p className="hint">워크로드를 추가하세요.</p>}
      </section>
    </div>
  );
}
