import { useEffect, useState } from "react";
import {
  WPHI_DIMENSIONS,
  type WphiConfig,
  type WphiReading,
} from "../../../shared/wphi";
export function WphiControls({
  config,
  onRefresh,
  onEditingChange,
}: {
  config: WphiConfig;
  onRefresh: () => void;
  onEditingChange?: (editing: boolean) => void;
}) {
  const [open, setOpen] = useState(false),
    [draft, setDraft] = useState(config),
    [reading, setReading] = useState<WphiReading | null>(null),
    [normal, setNormal] = useState("true"),
    [reason, setReason] = useState(""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false),
    [loaded, setLoaded] = useState(false);
  useEffect(() => {
    onEditingChange?.(open);
    return () => onEditingChange?.(false);
  }, [open, onEditingChange]);
  useEffect(() => {
    if (!open) return;
    let live = true;
    setLoaded(false);
    setMessage("正在读取日报…");
    fetch("/api/dashboard/wphi")
      .then(async (r) => {
        if (!r.ok) {
          const error = await r.json().catch(() => ({}));
          throw Error(error.message ?? error.error ?? "服务器拒绝请求");
        }
        return r.json();
      })
      .then((v) => {
        if (live) {
          setLoaded(true);
          setReading(v.reading);
          setDraft(v.config);
          setNormal(
            v.reading.systemNormal === null
              ? "unknown"
              : String(v.reading.systemNormal),
          );
          setReason(v.reading.abnormalReason ?? "");
          setMessage("");
        }
      })
      .catch(() => {
        if (live) setMessage("读取失败，请关闭后重试");
      });
    return () => {
      live = false;
    };
  }, [open]);
  async function save(path: string, body: unknown) {
    setBusy(true);
    setMessage("正在保存…");
    try {
      const r = await fetch(`/api/dashboard/wphi/${path}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const error = await r.json().catch(() => ({}));
        throw Error(error.message ?? error.error ?? "服务器拒绝请求");
      }
      setMessage("保存成功");
      onRefresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "保存失败，请重试");
    } finally {
      setBusy(false);
    }
  }
  return (
    <details
      open={open}
      onToggle={(e) => {
        setOpen(e.currentTarget.open);
      }}
    >
      <summary>评分配置与每日运行上报</summary>
      <fieldset disabled={busy || !loaded}>
        <legend>目标值</legend>
        {Object.entries(draft.targets).map(([key, value]) => (
          <label key={key}>
            {
              (
                {
                  tnIn: "进水总氮 mg/L",
                  tnOut: "出水总氮 mg/L",
                  tnRemoval: "总氮去除率 %",
                  tnCv: "7日CV %",
                  blowerTotal: "风机总能耗 kWh/d",
                  blowerPerM3: "吨水风机能耗 kWh/m³",
                  carbonTotal: "碳源总用量 kg/d",
                  carbonPerM3: "吨水碳源用量 kg/m³",
                } as Record<string, string>
              )[key]
            }
            <input
              type="number"
              min="0"
              step="any"
              value={value}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  targets: { ...draft.targets, [key]: Number(e.target.value) },
                })
              }
            />
          </label>
        ))}
        <div>
          {Object.entries(WPHI_DIMENSIONS).map(([key, label]) => (
            <label key={key}>
              <input
                type="checkbox"
                checked={draft.enabled[key as keyof typeof draft.enabled]}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    enabled: { ...draft.enabled, [key]: e.target.checked },
                  })
                }
              />
              {label}
            </label>
          ))}
        </div>
        <label>
          低浓度豁免比例 %
          <input
            type="number"
            value={draft.cvExemptionRatio * 100}
            onChange={(e) =>
              setDraft({
                ...draft,
                cvExemptionRatio: Number(e.target.value) / 100,
              })
            }
          />
        </label>
        <details>
          <summary>高级评分断点</summary>
          {(["lowBreakpoints", "highBreakpoints"] as const).map((key) => (
            <div key={key}>
              {draft[key].map((v, i) => (
                <label key={i}>
                  {key === "lowBreakpoints"
                    ? "低值优指标断点"
                    : "高值优指标断点"}{" "}
                  {i + 1}
                  <input
                    type="number"
                    step="any"
                    value={v}
                    onChange={(e) => {
                      const values = [...draft[key]] as [
                        number,
                        number,
                        number,
                      ];
                      values[i] = Number(e.target.value);
                      setDraft({ ...draft, [key]: values });
                    }}
                  />
                </label>
              ))}
            </div>
          ))}
        </details>
        <label>
          <input
            type="checkbox"
            checked={draft.maintenance}
            onChange={(e) =>
              setDraft({ ...draft, maintenance: e.target.checked })
            }
          />
          检修模式
        </label>
        <button type="button" onClick={() => void save("config", draft)}>
          保存评分配置
        </button>
      </fieldset>
      <fieldset disabled={busy || !loaded || !reading}>
        <legend>每日运行上报 {reading?.date}</legend>
        <label>
          系统运行状态
          <select value={normal} onChange={(e) => setNormal(e.target.value)}>
            <option value="unknown">未上报</option>
            <option value="true">正常</option>
            <option value="false">异常</option>
          </select>
        </label>
        <label>
          异常原因
          <input value={reason} onChange={(e) => setReason(e.target.value)} />
        </label>
        <button
          disabled={
            normal === "unknown" || (normal === "false" && !reason.trim())
          }
          type="button"
          onClick={() =>
            void save("report", {
              date: reading?.date,
              systemNormal: normal === "true",
              reason,
            })
          }
        >
          保存运行日报
        </button>
      </fieldset>
      <p role="status">{message}</p>
    </details>
  );
}
