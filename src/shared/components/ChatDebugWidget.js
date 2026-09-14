"use client";

import { useEffect, useRef, useState } from "react";
import ChatDebugClient from "@/app/(dashboard)/dashboard/chat-debug/ChatDebugClient";

export default function ChatDebugWidget() {
  const [enabled, setEnabled] = useState(false);
  const [collapsed, setCollapsed] = useState(true);
  const [position, setPosition] = useState({ x: null, y: null });
  const drag = useRef(null);
  const suppressClick = useRef(false);

  useEffect(() => {
    const onToggle = (event) => {
      const next = Boolean(event.detail?.enabled);
      setEnabled(next);
      if (next) setCollapsed(false);
    };
    window.addEventListener("spring-mouse-debug-toggle", onToggle);
    return () => window.removeEventListener("spring-mouse-debug-toggle", onToggle);
  }, []);

  if (!enabled) return null;
  const expandedHeight = Math.min(680, Math.max(0, window.innerHeight - 32));
  const style = position.x === null
    ? undefined
    : { left: `${position.x}px`, top: `${Math.max(8, collapsed ? position.y : Math.min(position.y, window.innerHeight - expandedHeight - 8))}px`, right: "auto", bottom: "auto" };
  const startDrag = (event) => {
    if (event.button !== 0) return;
    const rect = event.currentTarget.parentElement.getBoundingClientRect();
    drag.current = { dx: event.clientX - rect.left, dy: event.clientY - rect.top, startX: event.clientX, startY: event.clientY, moved: false };
    const move = (next) => {
      if (Math.abs(next.clientX - drag.current.startX) > 4 || Math.abs(next.clientY - drag.current.startY) > 4) drag.current.moved = true;
      setPosition({ x: Math.max(8, Math.min(window.innerWidth - 72, next.clientX - drag.current.dx)), y: Math.max(8, Math.min(window.innerHeight - 72, next.clientY - drag.current.dy)) });
    };
    const stop = () => { suppressClick.current = drag.current?.moved === true; window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", stop); drag.current = null; };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", stop);
  };

  return <div className="fixed z-[70]" style={style || { right: "1rem", bottom: "1rem" }}>
    <><div style={collapsed ? undefined : { width: 760, height: 680, maxWidth: "calc(100vw - 2rem)", maxHeight: "calc(100vh - 2rem)" }} className={collapsed ? "pointer-events-none invisible absolute h-0 w-0 overflow-hidden" : "flex flex-col overflow-hidden rounded-2xl border border-brand-500/30 bg-surface shadow-2xl"}><div onPointerDown={startDrag} className="flex shrink-0 cursor-move items-center justify-between border-b border-border bg-surface-2/80 px-4 py-2.5"><h3 className="text-sm font-semibold">对话调试</h3><div className="flex items-center gap-1"><button type="button" onClick={() => setCollapsed(true)} className="rounded p-1 text-text-muted hover:bg-surface" aria-label="收起对话调试"><span className="material-symbols-outlined text-[18px]">minimize</span></button><button type="button" onClick={() => setEnabled(false)} className="rounded p-1 text-text-muted hover:bg-surface" aria-label="关闭对话调试"><span className="material-symbols-outlined text-[18px]">close</span></button></div></div><div className="min-h-0 flex-1"><ChatDebugClient /></div></div>{collapsed && <button type="button" onPointerDown={startDrag} onClick={(event) => { if (suppressClick.current) { suppressClick.current = false; event.preventDefault(); return; } setCollapsed(false); }} className="flex h-14 w-14 items-center justify-center rounded-full border border-brand-400/50 bg-surface-2 text-brand-300 shadow-2xl hover:bg-brand-500/20" title="展开对话调试"><span className="material-symbols-outlined">forum</span></button>}</>
  </div>;
}
