"use client";

import { useState } from "react";
import PropTypes from "prop-types";
import Drawer from "./Drawer";
import Button from "./Button";
import Input from "./Input";
import Toggle from "./Toggle";
import {
  CAPABILITY_BOOLEAN_KEYS,
  CAPABILITY_GROUPS,
  capabilitiesFromDraft,
  createCapabilityDraft,
} from "@/shared/constants/modelCapabilities";

/**
 * Capability editor for a single model.
 *
 * NOTE: this drawer is always mounted by the caller with `key={...}` tied to the
 * selected model, so the draft state below is seeded exactly once per open.
 * Do NOT re-seed with useEffect + setState (react-hooks/set-state-in-effect).
 */
export default function ModelCapabilitiesModal({ isOpen, modelId, fullModel, caps, saving = false, onSave, onClose }) {
  const [draft, setDraft] = useState(() => createCapabilityDraft(caps));

  const setFlag = (key, value) => setDraft((prev) => ({ ...prev, [key]: value }));
  const setNumber = (key, value) => setDraft((prev) => ({ ...prev, [key]: value }));

  const dirty = JSON.stringify(capabilitiesFromDraft(draft)) !== JSON.stringify(capabilitiesFromDraft(createCapabilityDraft(caps)));
  const activeCount = CAPABILITY_BOOLEAN_KEYS.filter((key) => draft[key]).length;

  return (
    <Drawer isOpen={isOpen} onClose={onClose} title="模型能力配置" width="lg">
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
          <Button fullWidth loading={saving} disabled={!dirty} onClick={() => onSave(capabilitiesFromDraft(draft))}>
            保存
          </Button>
        </div>
      </div>
    </Drawer>
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
