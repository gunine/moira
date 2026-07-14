import type { ReactNode } from "react";
import { getGpuModel, profileSlicesFromName } from "../catalog";
import type {
  GpuState,
  MigMode,
  NodeState,
  WorkloadSpec,
} from "../types";
import { colorVar } from "./colors";
import { podLabel } from "./util";

interface Props {
  nodeStates: NodeState[];
  gpuStates: GpuState[];
  workloads: WorkloadSpec[];
  colorSlots: Record<string, number>;
}

const MIG_MODE_LABEL: Record<MigMode, string> = {
  disabled: "MIG off",
  static: "MIG static",
  dynamic: "MIG dynamic",
};

interface PodInfo {
  name: string;
  color: string;
  index: number;
}

function usePodInfo(
  workloads: WorkloadSpec[],
  colorSlots: Record<string, number>,
): (podId: string) => PodInfo {
  const byId = new Map(workloads.map((w) => [w.id, w]));
  return (podId: string) => {
    const { workloadId, index } = podLabel(podId);
    const w = byId.get(workloadId);
    return {
      name: w?.name ?? workloadId,
      color: colorVar(colorSlots[workloadId] ?? -1),
      index,
    };
  };
}

function GpuBar(props: {
  gpu: GpuState;
  totalSlices: number;
  podInfo: (podId: string) => PodInfo;
}) {
  const { gpu, totalSlices, podInfo } = props;
  const blocks: ReactNode[] = [];

  if (gpu.mode === "whole") {
    if (gpu.wholeAllocatedTo) {
      const pod = podInfo(gpu.wholeAllocatedTo);
      blocks.push(
        <div
          key="whole"
          className="blk alloc"
          style={{ gridColumn: `span ${totalSlices}`, background: pod.color }}
          data-tip={`${pod.name} #${pod.index} · GPU 전체 점유`}
        />,
      );
    } else {
      blocks.push(
        <div
          key="idle"
          className="blk idle-whole"
          style={{ gridColumn: `span ${totalSlices}` }}
          data-tip="미사용 GPU (whole)"
        />,
      );
    }
  } else {
    let used = 0;
    gpu.instances.forEach((inst, i) => {
      const slices = Math.min(
        Math.max(1, profileSlicesFromName(inst.profile)),
        totalSlices - used,
      );
      used += slices;
      if (inst.allocatedTo) {
        const pod = podInfo(inst.allocatedTo);
        blocks.push(
          <div
            key={i}
            className="blk alloc"
            style={{ gridColumn: `span ${slices}`, background: pod.color }}
            data-tip={`${pod.name} #${pod.index} · ${inst.profile}`}
          />,
        );
      } else {
        blocks.push(
          <div
            key={i}
            className="blk free-inst"
            style={{ gridColumn: `span ${slices}` }}
            data-tip={`미할당 인스턴스 · ${inst.profile}`}
          />,
        );
      }
    });
    const residual = totalSlices - used;
    if (residual > 0) {
      blocks.push(
        <div
          key="residual"
          className="blk residual"
          style={{ gridColumn: `span ${residual}` }}
          data-tip={`커빙되지 않은 잔여 slice ×${residual}`}
        />,
      );
    }
  }

  return (
    <div className="gpu-row">
      <span className="gpu-tag">
        {gpu.staticPartitioned ? "🔒 " : ""}GPU{gpu.gpuIndex}
      </span>
      <div
        className="slice-bar"
        style={{ gridTemplateColumns: `repeat(${totalSlices}, 1fr)` }}
      >
        {blocks}
      </div>
    </div>
  );
}

function Meter(props: { label: string; used: number; total: number; unit: string }) {
  const pct = props.total > 0 ? Math.min(100, (props.used / props.total) * 100) : 0;
  return (
    <div className="meter-row">
      <span className="meter-label">{props.label}</span>
      <div
        className="meter"
        role="meter"
        aria-valuemin={0}
        aria-valuemax={props.total}
        aria-valuenow={props.used}
        aria-label={props.label}
      >
        <div className="fill" style={{ width: `${pct}%` }} />
      </div>
      <span className="meter-value">
        {props.used}/{props.total}
        {props.unit}
      </span>
    </div>
  );
}

export default function Heatmap(props: Props) {
  const { nodeStates, gpuStates, workloads, colorSlots } = props;
  const podInfo = usePodInfo(workloads, colorSlots);

  const gpusByNode = new Map<string, GpuState[]>();
  for (const g of gpuStates) {
    const list = gpusByNode.get(g.nodeId) ?? [];
    list.push(g);
    gpusByNode.set(g.nodeId, list);
  }

  return (
    <div>
      {workloads.length > 0 && (
        <div className="legend-row" aria-label="워크로드 범례">
          {workloads.map((w) => (
            <span key={w.id} className="legend-item">
              <span
                className="color-dot"
                style={{ background: colorVar(colorSlots[w.id] ?? -1) }}
              />
              {w.name}
            </span>
          ))}
        </div>
      )}
      <div className="node-grid">
        {nodeStates.map((ns) => {
          const model = getGpuModel(ns.gpuModel);
          const totalSlices = model?.totalSlices ?? 7;
          return (
            <div key={ns.nodeId} className="node-card">
              <div className="node-head">
                <span className="node-name">{ns.name}</span>
                <span className="node-meta">
                  {ns.gpuModel} · {MIG_MODE_LABEL[ns.migMode]}
                </span>
              </div>
              <div className="gpu-list">
                {(gpusByNode.get(ns.nodeId) ?? []).map((gpu) => (
                  <GpuBar
                    key={gpu.gpuIndex}
                    gpu={gpu}
                    totalSlices={totalSlices}
                    podInfo={podInfo}
                  />
                ))}
              </div>
              <Meter label="vCPU" used={ns.vcpuUsed} total={ns.vcpuTotal} unit="" />
              <Meter
                label="MEM"
                used={ns.memoryGiBUsed}
                total={ns.memoryGiBTotal}
                unit="G"
              />
            </div>
          );
        })}
      </div>
      {nodeStates.length === 0 && <p className="hint">표시할 노드가 없습니다.</p>}
    </div>
  );
}
