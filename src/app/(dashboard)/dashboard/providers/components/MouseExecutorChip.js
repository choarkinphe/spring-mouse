"use client";

import PropTypes from "prop-types";
import { cn } from "@/shared/utils/cn";

/**
 * Where this account's upstream request actually leaves from.
 *
 * `mouseId === null` → the Spring host dials the provider directly.
 * `mouseId` set → the request is forwarded to that Mouse node, which is the
 * one talking to the provider. An offline node is worth flagging because the
 * account stops being selectable until it heartbeats again.
 */
export default function MouseExecutorChip({ mouseId, mouseName, isOnline, className }) {
  const routed = Boolean(mouseId);
  const name = typeof mouseName === "string" ? mouseName.trim() : "";
  const offline = routed && !isOnline;

  const label = routed ? (name || "未知节点") : "本机";
  const title = routed
    ? `执行者：Mouse 节点「${name || "已删除的节点"}」${offline ? "（离线，该账号暂不可用）" : "（在线）"}`
    : "执行者：Spring 主机本机直连上游";

  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] leading-none",
        routed
          ? offline
            ? "border-amber-400/40 bg-amber-400/[0.12] text-amber-200"
            : "border-[#38bdf8]/45 bg-[#38bdf8]/[0.12] text-[#7dd3fc]"
          : "border-border bg-surface-2 text-text-main",
        className,
      )}
      title={title}
    >
      {/* `!` is required: globals.css sets a 24px font-size on
          .material-symbols-outlined outside any cascade layer, which beats
          every Tailwind text-[Npx] utility. */}
      <span className="material-symbols-outlined text-[12px]! leading-none">{routed ? "device_hub" : "computer"}</span>
      <span>{label}</span>
      {offline && <span className="shrink-0 text-amber-200/75">· 离线</span>}
    </span>
  );
}

MouseExecutorChip.propTypes = {
  mouseId: PropTypes.string,
  mouseName: PropTypes.string,
  isOnline: PropTypes.bool,
  className: PropTypes.string,
};
