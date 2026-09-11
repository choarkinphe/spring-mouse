"use client";

import { useState } from "react";
import PropTypes from "prop-types";
import Modal from "./Modal";
import Button from "./Button";
import Input from "./Input";
import Toggle from "./Toggle";

// Boolean capability flags, grouped for the editor. `key` matches the runtime
// capability names in open-sse/providers/capabilities.js.
const CAPABILITY_GROUPS = [
  {
    title: "输入模态",
    items: [
      { key: "vision", label: "视觉 / 图片", hint: "可读图片（多模态）" },
      { key: "pdf", label: "PDF / 文档", hint: "可读 PDF、文档" },
      { key: "audioInput", label: "音频输入", hint: "可读音频" },
      { key: "videoInput", label: "视频输入", hint: "可读视频" },
    ],
  },
  {
    title: "输出模态",
    items: [
      { key: "imageOutput", label: "图像生成", hint: "可输出图片" },
      { key: "audioOutput", label: "音频生成", hint: "可输出语音" },
    ],
  },
  {
    title: "能力特性",
    items: [
      { key: "reasoning", label: "思考 / 推理", hint: "支持 thinking" },
      { key: "search", label: "联网搜索", hint: "自带联网检索" },
      { key: "tools", label: "工具调用", hint: "支持 function calling" },
    ],
  },
];

const BOOLEAN_KEYS = CAPABILITY_GROUPS.flatMap((group) => group.items.map((item) => item.key));

function toDraft(caps = {}) {
  const draft = {};
  for (const key of BOOLEAN_KEYS) draft[key] = caps?.[key] === true;
  draft.contextWindow = Number.isFinite(caps?.contextWindow) && caps.contextWindow > 0 ? String(caps.contextWindow) : "";
  draft.maxOutput = Number.isFinite(caps?.maxOutput) && caps.maxOutput > 0 ? String(caps.maxOutput) : "";
  return draft;
}

function toCapabilities(draft) {
  const out = {};
  for (const key of BOOLEAN_KEYS) {
    if (draft[key] === true) out[key] = true;
  }
  const contextWindow = Number.parseInt(draft.contextWindow, 10);
  if (Number.isFinite(contextWindow) && contextWindow > 0) out.contextWindow = contextWindow;
  const maxOutput = Number.parseInt(draft.maxOutput, 10);
  if (Number.isFinite(maxOutput) && maxOutput > 0) out.maxOutput = maxOutput;
  return out;
}

/**
 * Capability editor for a single model.
 *
 * NOTE: this modal is always mounted by the caller with `key={...}` tied to the
 * selected model, so the draft state below is seeded exactly once per open.
 * Do NOT re-seed with useEffect + setState (react-hooks/set-state-in-effect).
 */
export default function ModelCapabilitiesModal({ isOpen, modelId, fullModel, caps, saving = false, onSave, onClose }) {
  const [draft, setDraft] = useState(() => toDraft(caps));

  const setFlag = (key, value) => setDraft((prev) => ({ ...prev, [key]: value }));
  const setNumber = (key, value) => setDraft((prev) => ({ ...prev, [key]: value }));

  const dirty = JSON.stringify(toCapabilities(draft)) !== JSON.stringify(toCapabilities(toDraft(caps)));
  const activeCount = BOOLEAN_KEYS.filter((key) => draft[key]).length;

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="模型能力配置" size="lg">
      <div className="flex flex-col gap-5">
        <div className="rounded-[10px] border border-border-subtle bg-surface-2 px-3 py-2">
          <p className="truncate text-sm font-semibold text-text-main" title={modelId}>{modelId}</p>
          <code className="mt-0.5 block truncate font-mono text-[11px] text-text-muted" title={fullModel}>{fullModel}</code>
        </div>

        {CAPABILITY_GROUPS.map((group) => (
          <section key={group.title} className="flex flex-col gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-text-subtle">{group.title}</h3>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {group.items.map((item) => (
                <div
                  key={item.key}
                  className="flex items-center justify-between gap-3 rounded-[10px] border border-border-subtle bg-bg/40 px-3 py-2"
                >
                  <div className="min-w-0">
                    <p className="text-sm text-text-main">{item.label}</p>
                    <p className="truncate text-[11px] text-text-muted">{item.hint}</p>
                  </div>
                  <Toggle
                    size="sm"
                    checked={draft[item.key] === true}
                    onChange={(value) => setFlag(item.key, value)}
                    ariaLabel={`${item.label}：${draft[item.key] ? "已开启，点击关闭" : "已关闭，点击开启"}`}
                  />
                </div>
              ))}
            </div>
          </section>
        ))}

        <section className="flex flex-col gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-text-subtle">上下文与输出</h3>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Input
              label="上下文长度 (tokens)"
              type="number"
              min="1"
              placeholder="留空使用内置默认值"
              value={draft.contextWindow}
              onChange={(e) => setNumber("contextWindow", e.target.value)}
              inputClassName="font-mono text-xs"
            />
            <Input
              label="最大输出 (tokens)"
              type="number"
              min="1"
              placeholder="留空使用内置默认值"
              value={draft.maxOutput}
              onChange={(e) => setNumber("maxOutput", e.target.value)}
              inputClassName="font-mono text-xs"
            />
          </div>
        </section>

        <p className="text-xs leading-relaxed text-text-muted">
          已开启 {activeCount} 项能力。留空或全部关闭表示不覆盖，运行时将继续使用内置识别结果。
        </p>

        <div className="flex gap-2 pt-1">
          <Button variant="ghost" fullWidth onClick={onClose} disabled={saving}>
            取消
          </Button>
          <Button variant="secondary" fullWidth onClick={() => onSave({})} disabled={saving}>
            恢复默认
          </Button>
          <Button fullWidth loading={saving} disabled={!dirty} onClick={() => onSave(toCapabilities(draft))}>
            保存
          </Button>
        </div>
      </div>
    </Modal>
  );
}

ModelCapabilitiesModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  modelId: PropTypes.string.isRequired,
  fullModel: PropTypes.string,
  caps: PropTypes.object,
  saving: PropTypes.bool,
  onSave: PropTypes.func.isRequired,
  onClose: PropTypes.func.isRequired,
};
