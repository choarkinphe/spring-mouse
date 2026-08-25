"use client";

import { memo, useEffect, useRef } from "react";
import PropTypes from "prop-types";
import { renderMarkdown } from "../chatDebugLib.js";

const STATUS_LABELS = { streaming: "流式返回中", error: "失败", aborted: "已停止" };

function AttachmentThumbs({ attachments }) {
  if (!attachments || attachments.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap justify-end gap-2">
      {attachments.map((attachment) => (
        <a
          key={attachment.id}
          href={attachment.dataUrl}
          target="_blank"
          rel="noreferrer"
          className="block overflow-hidden rounded-lg border border-border"
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- data-URI previews, no optimizer needed */}
          <img src={attachment.dataUrl} alt={attachment.name || "attachment"} className="h-20 w-20 object-cover" loading="lazy" decoding="async" />
        </a>
      ))}
    </div>
  );
}

AttachmentThumbs.propTypes = {
  attachments: PropTypes.arrayOf(PropTypes.shape({
    id: PropTypes.string,
    name: PropTypes.string,
    dataUrl: PropTypes.string,
  })),
};

function MessageList({ messages, streamingId }) {
  const containerRef = useRef(null);
  const stickToBottomRef = useRef(true);

  const scrollToBottom = () => {
    const el = containerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  };

  useEffect(() => {
    if (stickToBottomRef.current) scrollToBottom();
  }, [messages]);

  const handleScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  };

  if (messages.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
        <span className="material-symbols-outlined text-5xl text-text-muted">forum</span>
        <div className="text-sm text-text-muted">选择模型并发送消息，实测生产链路的响应速度。</div>
        <div className="text-xs text-text-muted">输入框下方选「策略」走完整路由（含账号回退），选「策略成员模型」直连单个上游。</div>
      </div>
    );
  }

  return (
    <div ref={containerRef} onScroll={handleScroll} className="custom-scrollbar flex-1 space-y-4 overflow-y-auto p-4">
      {messages.map((message) => {
        if (message.role === "user") {
          return (
            <div key={message.id} className="flex flex-col items-end">
              <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-surface-2 px-4 py-2.5 text-sm text-text-main">
                {message.content}
              </div>
              <AttachmentThumbs attachments={message.attachments} />
            </div>
          );
        }

        const isStreaming = message.status === "streaming";
        return (
          <div key={message.id} className="flex min-w-0 flex-col items-start gap-1">
            {message.reasoning ? (
              <details className="w-full rounded-lg border border-border-subtle bg-surface px-3 py-2 text-xs text-text-muted">
                <summary className="cursor-pointer select-none">思考过程</summary>
                <div className="mt-2 whitespace-pre-wrap break-words">{message.reasoning}</div>
              </details>
            ) : null}
            <div
              className={`markdown-content w-full max-w-full overflow-x-auto rounded-2xl rounded-bl-md px-4 py-2.5 text-sm ${
                message.status === "error"
                  ? "border border-red-500/30 bg-red-500/10 text-red-500"
                  : "bg-surface-2 text-text-main"
              }`}
            >
              {message.status === "error" ? (
                <div className="whitespace-pre-wrap break-words">{message.error || "请求失败"}</div>
              ) : (
                <>
                  <div dangerouslySetInnerHTML={{ __html: renderMarkdown(message.content) }} />
                  {isStreaming && message.content === "" && !message.reasoning ? (
                    <span className="inline-block h-4 w-2 animate-pulse bg-text-muted align-middle" />
                  ) : null}
                  {isStreaming && message.content !== "" ? (
                    <span className="ml-0.5 inline-block h-4 w-2 animate-pulse bg-brand-500 align-middle" />
                  ) : null}
                </>
              )}
            </div>
            {!isStreaming && message.status !== "error" ? (
              <span className="pl-1 text-xs text-text-muted">{STATUS_LABELS[message.status] || ""}</span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

MessageList.propTypes = {
  messages: PropTypes.arrayOf(PropTypes.shape({
    id: PropTypes.string.isRequired,
    role: PropTypes.oneOf(["user", "assistant"]).isRequired,
    content: PropTypes.string,
    reasoning: PropTypes.string,
    status: PropTypes.string,
    error: PropTypes.string,
    attachments: PropTypes.array,
  })).isRequired,
  streamingId: PropTypes.string,
};

export default memo(MessageList);
