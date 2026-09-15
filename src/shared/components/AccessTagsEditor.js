"use client";

import { useState } from "react";
import PropTypes from "prop-types";
import { normalizeAccessTags } from "@/shared/utils/accessTags";

export default function AccessTagsEditor({ value, onChange, compact = false, label = "权限标签", hint = "标签用于控制模型与模型组合的访问权限；未设置标签表示对所有密钥开放。" }) {
  const [draft, setDraft] = useState("");
  const tags = normalizeAccessTags(value);

  const addDraft = () => {
    const next = normalizeAccessTags([...tags, ...draft.split(/[,，\n]/)]);
    onChange(next);
    setDraft("");
  };

  return (
    <div>
      <label className={`block font-medium text-text-main ${compact ? "mb-1 text-xs" : "mb-1.5 text-sm"}`}>{label}</label>
      <div className={`border border-border bg-bg/35 focus-within:border-[#38bdf8]/55 ${compact ? "w-full max-w-sm rounded-md px-2 py-1" : "rounded-lg p-2.5"}`}>
        <div className={`flex flex-wrap items-center gap-1.5 ${compact ? "min-h-6" : "min-h-7"}`}>
          {tags.map((tag) => (
            <span key={tag} className={`inline-flex items-center gap-1 rounded-md border border-violet-400/20 bg-violet-400/[0.08] font-mono text-[11px] text-violet-200 ${compact ? "px-1.5 py-0.5" : "px-2 py-1"}`}>
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
            className={`min-w-0 flex-1 bg-transparent px-1 text-text-main outline-none placeholder:text-text-muted ${compact ? "h-6 basis-36 text-xs" : "h-7 min-w-36 text-sm"}`}
          />
        </div>
      </div>
      <p className={`text-text-muted ${compact ? "mt-1 text-[10px] leading-4" : "mt-1.5 text-xs leading-5"}`}>{hint}</p>
    </div>
  );
}

AccessTagsEditor.propTypes = {
  value: PropTypes.arrayOf(PropTypes.string),
  onChange: PropTypes.func.isRequired,
  compact: PropTypes.bool,
  label: PropTypes.string,
  hint: PropTypes.string,
};
