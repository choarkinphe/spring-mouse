"use client";

import { useState } from "react";
import PropTypes from "prop-types";
import { normalizeAccessTags } from "@/shared/utils/accessTags";

export default function AccessTagsEditor({ value, onChange, label = "权限标签", hint = "标签用于控制资源权限或优先级，具体行为以当前资源说明为准。" }) {
  const [draft, setDraft] = useState("");
  const tags = normalizeAccessTags(value);

  const addDraft = () => {
    const next = normalizeAccessTags([...tags, ...draft.split(/[,，\n]/)]);
    onChange(next);
    setDraft("");
  };

  return (
    <div>
      <label className="mb-1.5 block text-sm font-medium text-text-main">{label}</label>
      <div className="rounded-lg border border-border bg-bg/35 p-2.5 focus-within:border-[#38bdf8]/55">
        <div className="flex min-h-7 flex-wrap items-center gap-1.5">
          {tags.map((tag) => (
            <span key={tag} className="inline-flex items-center gap-1 rounded-md border border-violet-400/20 bg-violet-400/[0.08] px-2 py-1 font-mono text-[11px] text-violet-200">
              {tag}
              <button type="button" onClick={() => onChange(tags.filter((item) => item !== tag))} className="text-violet-300/70 hover:text-violet-100" aria-label={`移除标签 ${tag}`}>×</button>
            </span>
          ))}
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === "," || event.key === "，") {
                event.preventDefault();
                addDraft();
              }
            }}
            onBlur={() => { if (draft.trim()) addDraft(); }}
            placeholder={tags.length === 0 ? "输入标签，按 Enter 添加" : "继续添加"}
            className="h-7 min-w-36 flex-1 bg-transparent px-1 text-sm text-text-main outline-none placeholder:text-text-muted"
          />
        </div>
      </div>
      <p className="mt-1.5 text-xs leading-5 text-text-muted">{hint}</p>
    </div>
  );
}

AccessTagsEditor.propTypes = {
  value: PropTypes.arrayOf(PropTypes.string),
  onChange: PropTypes.func.isRequired,
  label: PropTypes.string,
  hint: PropTypes.string,
};
