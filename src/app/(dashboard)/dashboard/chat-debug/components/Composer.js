"use client";

import { memo, useRef } from "react";
import PropTypes from "prop-types";
import Tooltip from "@/shared/components/Tooltip";

// Codex-style composer: one rounded box holding the textarea, attachment
// previews, and a bottom bar with the attach button, model picker pill and
// send/stop action.
function Composer({
  draft,
  onDraftChange,
  attachments,
  onRemoveAttachment,
  visionOk = false,
  isStreaming = false,
  canSend = false,
  onSend,
  onStop,
  onAttachFiles,
  onPaste,
  modelSlot,
}) {
  const textareaRef = useRef(null);
  const fileInputRef = useRef(null);

  const autoGrow = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, window.innerHeight * 0.25)}px`;
  };

  const handleKeyDown = (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (canSend) onSend();
    }
  };

  const attachButton = (
    <button
      type="button"
      onClick={() => fileInputRef.current?.click()}
      disabled={!visionOk || isStreaming}
      className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-text-muted transition-colors ${
        visionOk && !isStreaming ? "hover:bg-surface-3 hover:text-text-main" : "cursor-not-allowed opacity-40"
      }`}
      aria-label="添加图片"
    >
      <span className="material-symbols-outlined text-[20px]">add</span>
    </button>
  );

  return (
    <div className="shrink-0 pb-4 pt-2">
      <div className="rounded-2xl border border-border bg-surface-2 transition-colors focus-within:border-brand-500/50">
        {attachments.length > 0 ? (
          <div className="flex flex-wrap gap-2 px-3 pt-3">
            {attachments.map((attachment) => (
              <div key={attachment.id} className="group relative">
                {/* eslint-disable-next-line @next/next/no-img-element -- data-URI previews */}
                <img src={attachment.dataUrl} alt={attachment.name || "attachment"} className="h-14 w-14 rounded-lg border border-border object-cover" />
                <button
                  type="button"
                  onClick={() => onRemoveAttachment(attachment.id)}
                  className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full border border-border bg-surface text-text-muted shadow-sm transition-colors hover:text-red-500"
                  aria-label="移除图片"
                >
                  <span className="material-symbols-outlined text-[14px]">close</span>
                </button>
              </div>
            ))}
          </div>
        ) : null}

        <textarea
          ref={textareaRef}
          value={draft}
          rows={1}
          placeholder={visionOk ? "发送消息，Enter 发送，Shift+Enter 换行，可直接粘贴图片" : "发送消息，Enter 发送，Shift+Enter 换行"}
          onChange={(event) => { onDraftChange(event.target.value); autoGrow(); }}
          onKeyDown={handleKeyDown}
          onPaste={onPaste}
          className="custom-scrollbar max-h-[25vh] min-h-8 w-full resize-none bg-transparent px-4 pb-0.5 pt-2.5 text-sm text-text-main placeholder:text-text-muted focus:outline-none"
        />

        <div className="flex items-center gap-1 px-2 pb-2 pt-0.5">
          {visionOk ? attachButton : <Tooltip text="所选模型不支持图像输入">{attachButton}</Tooltip>}
          {modelSlot}
          <div className="ml-auto flex items-center gap-2">
            {isStreaming ? (
              <button
                type="button"
                onClick={onStop}
                className="flex h-8 items-center gap-1.5 rounded-full border border-border px-3 text-xs text-text-muted transition-colors hover:border-red-500/50 hover:text-red-500"
              >
                <span className="material-symbols-outlined text-[16px]">stop</span>
                停止
              </button>
            ) : (
              <button
                type="button"
                onClick={onSend}
                disabled={!canSend}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-500 text-white transition-colors hover:bg-brand-600 disabled:cursor-not-allowed disabled:opacity-40"
                aria-label="发送"
              >
                <span className="material-symbols-outlined text-[18px]">arrow_upward</span>
              </button>
            )}
          </div>
        </div>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(event) => {
          onAttachFiles(Array.from(event.target.files || []));
          event.target.value = "";
        }}
      />
    </div>
  );
}

Composer.propTypes = {
  draft: PropTypes.string.isRequired,
  onDraftChange: PropTypes.func.isRequired,
  attachments: PropTypes.arrayOf(PropTypes.shape({
    id: PropTypes.string,
    name: PropTypes.string,
    dataUrl: PropTypes.string,
  })).isRequired,
  onRemoveAttachment: PropTypes.func.isRequired,
  visionOk: PropTypes.bool,
  isStreaming: PropTypes.bool,
  canSend: PropTypes.bool,
  onSend: PropTypes.func.isRequired,
  onStop: PropTypes.func.isRequired,
  onAttachFiles: PropTypes.func.isRequired,
  onPaste: PropTypes.func,
  modelSlot: PropTypes.node,
};

export default memo(Composer);
