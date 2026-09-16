"use client";

import { useState, useEffect, useLayoutEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import PropTypes from "prop-types";
import { AccessTagsEditor, Badge, Button, DashboardHero, Input, Modal, CardSkeleton, ConfirmModal, SegmentedControl, Toggle } from "@/shared/components";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import EndpointRow from "./components/EndpointRow";
import SecurityWarning from "./components/SecurityWarning";
import styles from "./credentials.module.css";

const QUOTA_REFRESH_INTERVAL_MS = 60_000;

function formatLastAccess(value) {
  if (!value) return "尚未访问";
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) return "尚未访问";

  const delta = Date.now() - timestamp.getTime();
  if (delta >= 0 && delta < 60_000) return "刚刚访问";
  if (delta >= 0 && delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前访问`;
  if (delta >= 0 && delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前访问`;
  return timestamp.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
}

function formatTokenMillions(valueM) {
  if (valueM === null || valueM === undefined) return "—";
  return `${Number(valueM).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: Number(valueM) < 1 ? 3 : 2,
  })}M`;
}

function formatQuotaReset(value) {
  if (!value) return "等待新用量后滚动重置";
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) return "—";
  return timestamp.toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function getQuotaTone(percentage) {
  if (percentage >= 100) return "bg-rose-400";
  if (percentage >= 80) return "bg-amber-400";
  return "bg-emerald-400";
}

function getQuotaResetLabel() {
  return "下次重置";
}

function QuotaWindow({ window, onReset, resetting = false }) {
  if (!window.limitM) {
    return (
      <span className="rounded-md border border-white/[.08] bg-black/[.12] px-2 py-1 text-[11px] text-text-muted">
        未配置
      </span>
    );
  }

  const percentage = Math.min(window.usedPercentage || 0, 100);
  return (
    <div className="flex min-w-0 items-start gap-2">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-[11px] leading-none">
          <span className="w-12 shrink-0 text-text-muted">{window.label}</span>
          <span className="min-w-0 flex-1 truncate font-mono text-text-main">
            剩 {formatTokenMillions(window.remainingM)} · {formatTokenMillions(window.usedM)} / {formatTokenMillions(window.limitM)}
          </span>
          <span className={`shrink-0 font-mono ${window.exceeded ? "text-rose-300" : "text-text-muted"}`}>
            {window.usedPercentage || 0}%
          </span>
        </div>
        <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-white/[.09]">
          <div
            className={`h-full rounded-full ${getQuotaTone(window.usedPercentage || 0)}`}
            style={{ width: `${percentage}%` }}
          />
        </div>
        <p className="mt-1 truncate text-[10px] text-text-muted">{getQuotaResetLabel()} {formatQuotaReset(window.resetAt)}</p>
      </div>
      <button
        type="button"
        onClick={onReset}
        disabled={resetting}
        title={`重置${window.label}用量`}
        aria-label={`重置${window.label}用量`}
        className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-lg text-text-muted transition-colors hover:bg-sky-400/10 hover:text-sky-300 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <span aria-hidden="true" className={`material-symbols-outlined ${styles.icon} ${resetting ? "animate-spin" : ""}`}>
          {resetting ? "progress_activity" : "restart_alt"}
        </span>
      </button>
    </div>
  );
}

// Model ids run long ("anthropic/claude-3-5-sonnet-20241022") and the live
// column is narrow, so the chip keeps only the recognisable tail: the provider
// prefix is implied by the key's own configuration and the dated suffix is
// noise. The full id stays available in the tooltip.
function shortModelLabel(model) {
  const tail = String(model || "").split("/").pop() || "";
  return tail.replace(/-\d{4}-\d{2}-\d{2}$/, "").replace(/-\d{8}$/, "") || tail;
}

function RateLimitPolicyCell({ activity }) {
  if (!activity) {
    return <span className="text-[11px] text-text-muted">正在读取限流策略…</span>;
  }

  if (!activity.enabled || !activity.limit) {
    return (
      <div className="flex min-w-0 items-center gap-2 text-[11px] text-text-muted">
        <span>不限流</span>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] leading-5 text-text-muted">
      <span className="font-mono tabular-nums text-text-main">{activity.limit}/分钟</span>
      <span aria-hidden="true" className="text-border">|</span>
      <span className="truncate tabular-nums">队列 {activity.queueMax > 0 ? activity.queueMax : "—"}</span>
      <span aria-hidden="true" className="text-border">|</span>
      <span className="truncate tabular-nums">等待 {activity.queueMax > 0 && activity.queueTimeoutMs != null ? `${activity.queueTimeoutMs / 1000}s` : "—"}</span>
    </div>
  );
}

// Live activity for one key, mirroring the concurrency chip on the channel
// page: how much of the per-minute allowance is spent, whether anything is
// queued behind it, and which models those requests are asking for. Fed by
// /api/keys/activity, which reads the same counters admission uses.

// The credentials section clips its overflow so the rounded corners stay
// clean, which also cut off any dropdown that opened near the last row. The
// menu therefore renders through a portal onto the body and is positioned from
// the trigger's rect at open time, flipping above the button when the viewport
// leaves no room below.
const MENU_GAP = 8;
const MENU_VIEWPORT_MARGIN = 12;

function KeyActionMenu({ onRotate, onTags, onRateLimit, onDelete }) {
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState(null);
  const rootRef = useRef(null);
  const buttonRef = useRef(null);
  const menuRef = useRef(null);

  const close = useCallback(() => {
    setOpen(false);
    setPlacement(null);
  }, []);

  // Measured while the panel is still invisible, so it never flashes at the
  // wrong spot before the flip decision is made.
  useEffect(() => {
    if (!open || placement) return;
    const button = buttonRef.current;
    const menu = menuRef.current;
    if (!button || !menu) return;

    const rect = button.getBoundingClientRect();
    const height = menu.offsetHeight;
    const width = menu.offsetWidth;
    const roomBelow = window.innerHeight - rect.bottom - MENU_GAP - MENU_VIEWPORT_MARGIN;
    const roomAbove = rect.top - MENU_GAP - MENU_VIEWPORT_MARGIN;
    const flipUp = height > roomBelow && roomAbove > roomBelow;

    setPlacement({
      top: Math.max(
        MENU_VIEWPORT_MARGIN,
        flipUp ? rect.top - MENU_GAP - height : rect.bottom + MENU_GAP
      ),
      left: Math.min(
        Math.max(MENU_VIEWPORT_MARGIN, rect.right - width),
        Math.max(MENU_VIEWPORT_MARGIN, window.innerWidth - width - MENU_VIEWPORT_MARGIN)
      ),
    });
  }, [open, placement]);

  useEffect(() => {
    if (!open) return undefined;

    // A scroll moves the anchor out from under a viewport-anchored panel, so
    // the menu closes the same way Escape and an outside click do. A resize is
    // rare and changes how much room is left, so it re-measures instead of
    // throwing the menu away. The panel is a portal, so the trigger and the
    // panel need two separate containment checks.
    const closeOnOutside = (event) => {
      if (rootRef.current?.contains(event.target)) return;
      if (menuRef.current?.contains(event.target)) return;
      close();
    };
    const closeOnEscape = (event) => {
      if (event.key === "Escape") close();
    };
    let frame = 0;
    const remeasure = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        setPlacement(null);
      });
    };

    document.addEventListener("pointerdown", closeOnOutside);
    document.addEventListener("keydown", closeOnEscape);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", remeasure);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", closeOnOutside);
      document.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", remeasure);
    };
  }, [open, close]);

  const runAction = (action) => {
    close();
    action();
  };

  return (
    <div ref={rootRef} className={styles.actionMenuRoot}>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => (open ? close() : setOpen(true))}
        className={`${styles.actionButton} hover:bg-sky-400/10 hover:text-sky-300`}
        title="更多操作"
        aria-label="更多操作"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span aria-hidden="true" className={`material-symbols-outlined ${styles.icon}`}>more_horiz</span>
      </button>
      {open && createPortal(
        <div
          ref={menuRef}
          role="menu"
          className={styles.actionMenu}
          style={{
            top: placement ? placement.top : -9999,
            left: placement ? placement.left : -9999,
            visibility: placement ? "visible" : "hidden",
          }}
        >
          <button type="button" role="menuitem" onClick={() => runAction(onRotate)} className={styles.actionMenuItem}>
            <span aria-hidden="true" className={`material-symbols-outlined ${styles.icon}`}>sync</span>
            <span>轮换密钥</span>
          </button>
          <button type="button" role="menuitem" onClick={() => runAction(onTags)} className={styles.actionMenuItem}>
            <span aria-hidden="true" className={`material-symbols-outlined ${styles.icon}`}>sell</span>
            <span>配置密钥权限</span>
          </button>
          <button type="button" role="menuitem" onClick={() => runAction(onRateLimit)} className={styles.actionMenuItem}>
            <span aria-hidden="true" className={`material-symbols-outlined ${styles.icon}`}>speed</span>
            <span>配置请求限流</span>
          </button>
          <div className={styles.actionMenuDivider} />
          <button type="button" role="menuitem" onClick={() => runAction(onDelete)} className={`${styles.actionMenuItem} ${styles.actionMenuDanger}`}>
            <span aria-hidden="true" className={`material-symbols-outlined ${styles.icon}`}>delete</span>
            <span>删除密钥</span>
          </button>
        </div>,
        document.body
      )}
    </div>
  );
}

function LiveActivityCell({ activity }) {
  if (!activity) {
    return (
      <span className="rounded-md border border-white/[.08] bg-black/[.12] px-2 py-1 text-[11px] text-text-muted" title="正在读取实时请求数据">
        —
      </span>
    );
  }

  const { requests = 0, queued = 0, limit = null, enabled = false, models = [], windowMs = 0, lastModel = null } = activity;
  const windowLabel = windowMs ? `${Math.round(windowMs / 1000)} 秒` : "滚动窗口";
  const capped = Boolean(enabled && limit);
  const atCeiling = capped && requests >= limit;
  const busy = requests > 0;
  const top = models[0] || null;

  return (
    <div className="flex min-w-0 flex-col items-start gap-1">
      <div className="flex flex-wrap items-center gap-1">
        <span
          className={`inline-flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 font-mono text-[11px] leading-none tabular-nums ${
            atCeiling
              ? "border-amber-400/25 bg-amber-400/[.10] text-amber-200"
              : busy
                ? "border-sky-400/25 bg-sky-400/[.10] text-sky-200"
                : "border-white/[.08] bg-black/[.12] text-text-muted"
          }`}
          title={[
            `最近 ${windowLabel}内该密钥已受理 ${requests} 个业务请求`,
            capped ? `限流上限 ${limit} 个/分钟` : "未设置请求限流，此处只显示实时用量",
            "仅统计携带该密钥且已通过准入的请求；被拒绝或排队超时的请求不计入",
          ].join("\n")}
        >
          {busy ? (
            <>
              {capped ? `${requests}/${limit}` : requests}
              <span className="font-sans text-[10px] opacity-70">请求</span>
            </>
          ) : (
            <span className="font-sans">暂无请求</span>
          )}
        </span>
        {queued > 0 && (
          <span
            className="inline-flex shrink-0 items-center gap-1 rounded-md border border-amber-400/25 bg-amber-400/[.10] px-1.5 py-0.5 font-mono text-[11px] leading-none tabular-nums text-amber-200"
            title={`当前有 ${queued} 个请求正在排队，等待限流窗口腾出名额`}
          >
            {queued}
            <span className="font-sans text-[10px] opacity-70">排队</span>
          </span>
        )}
      </div>
      {(top || lastModel) && (
        <span
          className="min-w-0 truncate rounded-md border border-white/[.08] bg-black/[.12] px-1.5 py-0.5 font-mono text-[10px] text-text-muted"
          title={
            models.length
              ? `最近 ${windowLabel}的模型分布：\n${models.map((m) => `${m.model} ×${m.count}`).join("\n")}`
              : `最近一次请求的模型：${lastModel}`
          }
        >
          {top ? `${shortModelLabel(top.model)} ×${top.count}` : shortModelLabel(lastModel)}
          {models.length > 1 ? ` +${models.length - 1}` : ""}
        </span>
      )}
    </div>
  );
}

function QuotaCell({ quota, onReset, resettingWindow = null }) {
  if (quota?.mode === "off") {
    return (
      <span className="rounded-md border border-white/[.08] bg-black/[.12] px-2 py-1 text-[11px] text-text-muted">
        配额关闭
      </span>
    );
  }

  if (quota?.mode === "unlimited") {
    return (
      <span className="rounded-md border border-sky-400/20 bg-sky-400/[.07] px-2 py-1 text-[11px] text-sky-200">
        无限制
      </span>
    );
  }

  if (!quota?.enabled) {
    return (
      <span className="rounded-md border border-amber-400/20 bg-amber-400/[.07] px-2 py-1 text-[11px] text-amber-200">
        请先在设置中配置额度
      </span>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-2.5">
      {quota.windows.map((window) => (
        <QuotaWindow
          key={window.id}
          window={window}
          onReset={() => onReset(window)}
          resetting={resettingWindow === window.id}
        />
      ))}
    </div>
  );
}

export default function APIPageClient({ machineId }) {
  const [keys, setKeys] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAddModal, setShowAddModal] = useState(false);
  const [newKeyName, setNewKeyName] = useState("");
  const [createdKey, setCreatedKey] = useState(null);
  const [createdKeyKind, setCreatedKeyKind] = useState("created");
  const [rotationKey, setRotationKey] = useState(null);
  const [rotatingKey, setRotatingKey] = useState(false);
  const [rotationError, setRotationError] = useState("");
  const [confirmState, setConfirmState] = useState(null);
  const [resettingKeyQuotaId, setResettingKeyQuotaId] = useState(null);
  const [taggingKey, setTaggingKey] = useState(null);
  const [tagDraft, setTagDraft] = useState([]);
  const [savingTags, setSavingTags] = useState(false);
  const [editingKey, setEditingKey] = useState(null);
  const [keyNameDraft, setKeyNameDraft] = useState("");
  const [savingKeyName, setSavingKeyName] = useState(false);
  const [keyNameError, setKeyNameError] = useState("");
  const [rateLimitKey, setRateLimitKey] = useState(null);
  const [rateLimitDraft, setRateLimitDraft] = useState({ rpmLimit: "", rpmQueueMax: "", queueTimeoutSeconds: "" });
  const [savingRateLimit, setSavingRateLimit] = useState(false);
  const [rateLimitError, setRateLimitError] = useState("");

  const [requireApiKey, setRequireApiKey] = useState(false);
  const [requireLogin, setRequireLogin] = useState(true);
  const [hasPassword, setHasPassword] = useState(true);
  const [cloudflareEndpoint, setCloudflareEndpoint] = useState("");
  const [cloudflareTunnelEnabled, setCloudflareTunnelEnabled] = useState(false);


  // API key visibility toggle state
  const [visibleKeys, setVisibleKeys] = useState(new Set());

  // Live per-key request activity, keyed by key id (see /api/keys/activity)
  const [activity, setActivity] = useState({});

  // Client-side local/remote detection (UI hint only, not a security gate)
  const [isRemoteHost, setIsRemoteHost] = useState(false);
  useEffect(() => {
    if (typeof window !== "undefined")
      setIsRemoteHost(!["localhost", "127.0.0.1", "::1"].includes(window.location.hostname));
  }, []);

  const { copied, copy } = useCopyToClipboard();





  useEffect(() => {
    fetchData();
    loadSettings();
  }, []);

  // Live activity rides its own poll, exactly like the channel page's
  // /api/providers/concurrency: refreshing a counter every couple of seconds
  // must not re-read the key list, its quotas and the settings blob each tick.
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (document.visibilityState === "hidden") return;
      try {
        const response = await fetch("/api/keys/activity", { cache: "no-store" });
        if (!response.ok) return;
        const payload = await response.json().catch(() => null);
        if (!cancelled && payload?.keys) setActivity(payload.keys);
      } catch {
        // Transient failure: keep the last known numbers rather than blanking
        // every row back to zero.
      }
    };
    load();
    const timer = window.setInterval(load, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);





  const loadSettings = async () => {
    try {
      const settingsRes = await fetch("/api/settings");
      if (settingsRes.ok) {
        const data = await settingsRes.json();
        setRequireApiKey(data.requireApiKey || false);
        setRequireLogin(data.requireLogin !== false);
        setHasPassword(data.hasPassword || false);
        setCloudflareTunnelEnabled(data.cloudflareTunnelEnabled === true);
        if (data.cloudflareTunnelConfigured === true && data.cloudflareTunnelPublicUrl) {
          setCloudflareEndpoint(data.tunnelUrl || data.cloudflareTunnelPublicUrl);
        } else {
          setCloudflareEndpoint("");
        }
      }
    } catch (error) {
      console.log("Error loading settings:", error);
    }
  };



  const handleRequireApiKey = async (value) => {
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requireApiKey: value }),
      });
      if (res.ok) setRequireApiKey(value);
    } catch (error) {
      console.log("Error updating requireApiKey:", error);
    }
  };

  const fetchData = async () => {
    try {
      const fetchKeys = async () => {
        const res = await fetch("/api/keys", { cache: "no-store" });
        if (!res.ok) return [];
        const data = await res.json();
        return data.keys || [];
      };

      let existing = await fetchKeys();
      // Auto-provision a default key for first-time users so the endpoint works out of the box.
      if (existing.length === 0) {
        try {
          const createRes = await fetch("/api/keys", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: "Default Key" }),
          });
          if (createRes.ok) existing = await fetchKeys();
        } catch { /* fall through to empty render */ }
      }
      setKeys(existing);
    } catch (error) {
      console.log("Error fetching data:", error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // Rolling quota windows expire while this page remains open. Refresh the
    // server-calculated usage periodically without showing the initial loader.
    const timer = window.setInterval(() => void fetchData(), QUOTA_REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, []);

  const handleCreateKey = async () => {
    if (!newKeyName.trim()) return;

    try {
      const res = await fetch("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newKeyName }),
      });
      const data = await res.json();

      if (res.ok) {
        setCreatedKeyKind("created");
        setCreatedKey(data.key);
        await fetchData();
        setNewKeyName("");
        setShowAddModal(false);
      }
    } catch (error) {
      console.log("Error creating key:", error);
    }
  };

  const handleSaveKeyName = async (event) => {
    event.preventDefault();
    const name = keyNameDraft.trim();
    if (!editingKey || !name || savingKeyName) return;

    setSavingKeyName(true);
    setKeyNameError("");
    try {
      const res = await fetch(`/api/keys/${editingKey.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) throw new Error("Failed to update key name");
      const data = await res.json();
      setKeys((current) => current.map((key) => (
        key.id === editingKey.id ? { ...key, name: data.key.name } : key
      )));
      setEditingKey(null);
    } catch {
      setKeyNameError("保存失败，请稍后重试");
    } finally {
      setSavingKeyName(false);
    }
  };

  const openRateLimitDialog = (key) => {
    setRateLimitKey(key);
    setRateLimitError("");
    setRateLimitDraft({
      rpmLimit: key.rpmLimit?.toString() || "",
      rpmQueueMax: key.rpmQueueMax?.toString() ?? "",
      queueTimeoutSeconds: key.queueTimeoutMs ? Math.round(key.queueTimeoutMs / 1000).toString() : "",
    });
  };

  // Empty fields are sent as null so the key falls back to the instance default.
  // Queue length uses "" -> null too: an explicit 0 means "never queue".
  const handleSaveKeyRateLimit = async (event) => {
    event.preventDefault();
    if (!rateLimitKey || savingRateLimit) return;

    setSavingRateLimit(true);
    setRateLimitError("");
    try {
      const res = await fetch(`/api/keys/${rateLimitKey.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rpmLimit: rateLimitDraft.rpmLimit === "" ? null : rateLimitDraft.rpmLimit,
          rpmQueueMax: rateLimitDraft.rpmQueueMax === "" ? null : rateLimitDraft.rpmQueueMax,
          queueTimeoutMs: rateLimitDraft.queueTimeoutSeconds
            ? Math.round(Number(rateLimitDraft.queueTimeoutSeconds) * 1000)
            : null,
        }),
      });
      if (!res.ok) throw new Error("Failed to update key rate limit");
      await fetchData();
      setRateLimitKey(null);
    } catch {
      setRateLimitError("保存失败，请稍后重试");
    } finally {
      setSavingRateLimit(false);
    }
  };

  const handleRotateKey = async () => {
    if (!rotationKey || rotatingKey) return;
    setRotatingKey(true);
    setRotationError("");
    try {
      const res = await fetch(`/api/keys/${rotationKey.id}/rotate`, { method: "POST" });
      if (!res.ok) throw new Error("Failed to rotate key");
      const data = await res.json();
      setKeys((current) => current.map((key) => (
        key.id === rotationKey.id ? { ...key, key: data.key.key } : key
      )));
      setVisibleKeys((current) => {
        const next = new Set(current);
        next.delete(rotationKey.id);
        return next;
      });
      setRotationKey(null);
      setCreatedKeyKind("rotated");
      setCreatedKey(data.key.key);
    } catch {
      setRotationError("轮换未确认成功。请先刷新列表核对当前密钥，再决定是否重试。");
    } finally {
      setRotatingKey(false);
    }
  };

  const handleDeleteKey = async (id) => {
    setConfirmState({
      title: "Delete API Key",
      message: "Delete this API key?",
      onConfirm: async () => {
        setConfirmState(null);
        try {
          const res = await fetch(`/api/keys/${id}`, { method: "DELETE" });
          if (res.ok) {
            setKeys(keys.filter((k) => k.id !== id));
            setVisibleKeys(prev => {
              const next = new Set(prev);
              next.delete(id);
              return next;
            });
          }
        } catch (error) {
          console.log("Error deleting key:", error);
        }
      }
    });
  };

  const handleSetKeyQuotaMode = async (id, quotaMode) => {
    try {
      const res = await fetch(`/api/keys/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ quotaMode }),
      });
      if (res.ok) await fetchData();
    } catch (error) {
      console.log("Error updating key quota mode:", error);
    }
  };

  const handleSaveKeyTags = async () => {
    if (!taggingKey) return;
    setSavingTags(true);
    try {
      const res = await fetch(`/api/keys/${taggingKey.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accessTags: tagDraft }),
      });
      if (res.ok) {
        await fetchData();
        setTaggingKey(null);
      }
    } finally {
      setSavingTags(false);
    }
  };

  const requestResetKeyQuota = (key, window) => {
    setConfirmState({
      title: `重置${window.label}用量`,
      message: `重置“${key.name || "该密钥"}”的${window.label}用量？\n\n历史请求记录会保留，但该窗口会从现在重新累计；另一个额度窗口不受影响。`,
      onConfirm: async () => {
        const resetId = `${key.id}:${window.id}`;
        setConfirmState(null);
        setResettingKeyQuotaId(resetId);
        try {
          const res = await fetch(`/api/keys/${key.id}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ resetQuotaWindow: window.id }),
          });
          if (res.ok) await fetchData();
        } catch (error) {
          console.log("Error resetting key quota window:", error);
        } finally {
          setResettingKeyQuotaId(null);
        }
      },
    });
  };

  const maskKey = (fullKey) => {
    if (!fullKey || fullKey.length <= 10) return fullKey || "";
    return fullKey.slice(0, 6) + "•".repeat(fullKey.length - 10) + fullKey.slice(-4);
  };

  const toggleKeyVisibility = (keyId) => {
    setVisibleKeys(prev => {
      const next = new Set(prev);
      if (next.has(keyId)) next.delete(keyId);
      else next.add(keyId);
      return next;
    });
  };

  const [baseUrl, setBaseUrl] = useState("/v1");

  // Hydration fix: Only access window on client side
  useEffect(() => {
    if (typeof window !== "undefined") {
      setBaseUrl(`${window.location.origin}/v1`);
    }
  }, []);

  if (loading) {
    return (
      <div className="overflow-hidden rounded-xl border border-border-subtle">
        <CardSkeleton />
        <CardSkeleton />
      </div>
    );
  }

  const currentEndpoint = baseUrl;
  const cloudflareApiEndpoint = cloudflareEndpoint
    ? `${cloudflareEndpoint.replace(/\/$/, "")}/v1`
    : "";
  const activeKeyCount = keys.filter((key) => key.isActive !== false).length;
  const limitedKeyCount = keys.filter((key) => key.quotaMode === "limited").length;
  const endpointCount = 1 + (cloudflareApiEndpoint ? 1 : 0);

  return (
    <div className="flex min-w-0 flex-col gap-5 px-1 sm:px-0">
      <DashboardHero
        eyebrow="Integration & access"
        title="集成与凭据"
        description="管理服务接入地址、客户端鉴权，以及每个密钥的使用状态。"
        icon="key"
      >
        <Badge variant="primary" size="md" icon="api">{endpointCount} 个服务端点</Badge>
        <Badge variant={activeKeyCount > 0 ? "success" : "default"} size="md" icon="vpn_key">{activeKeyCount} 把启用密钥</Badge>
        <Badge variant={limitedKeyCount > 0 ? "primary" : "default"} size="md" icon="data_usage">{limitedKeyCount} 把限额密钥</Badge>
      </DashboardHero>

      <section aria-labelledby="integration-heading" className={`${styles.credentials} overflow-hidden rounded-xl border border-border-subtle bg-surface/35`}>
        <div className="flex flex-col gap-3 border-b border-white/[0.065] bg-white/[0.018] px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-[#38bdf8]/10 text-[#7dd3fc]"><span className="material-symbols-outlined text-[19px]">api</span></span>
            <div className="min-w-0">
              <h2 id="integration-heading" className="text-sm font-semibold text-text-main">服务集成</h2>
              <p className="mt-0.5 text-xs text-text-muted">为 SDK、CLI 或自定义客户端提供统一 OpenAI 兼容入口。</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-text-muted">
            <span className="rounded-md border border-white/[0.08] bg-black/[0.12] px-2 py-1">{endpointCount} 个端点</span>
            <span className={`rounded-md border px-2 py-1 ${requireLogin && hasPassword ? "border-emerald-400/15 bg-emerald-400/[0.06] text-emerald-200" : "border-amber-400/15 bg-amber-400/[0.06] text-amber-200"}`}>{requireLogin && hasPassword ? "控制台受保护" : "检查控制台访问"}</span>
          </div>
        </div>
        <div className="divide-y divide-white/[0.065]">
          <div className="grid grid-cols-1 gap-3 px-4 py-4 transition-colors hover:bg-[#38bdf8]/[0.035] lg:grid-cols-[11rem_minmax(0,1fr)] lg:items-center lg:gap-6">
            <div><p className="text-sm font-medium text-text-main">本地 API</p><p className="mt-0.5 text-xs text-text-muted">当前实例的默认入口</p></div>
            <EndpointRow label="OpenAI /v1" url={currentEndpoint} copyId="local_url" copied={copied} onCopy={copy} />
          </div>
          {cloudflareApiEndpoint && (
            <div className="grid grid-cols-1 gap-3 px-4 py-4 transition-colors hover:bg-[#38bdf8]/[0.035] lg:grid-cols-[11rem_minmax(0,1fr)] lg:items-center lg:gap-6">
              <div><p className="text-sm font-medium text-text-main">Cloudflare Tunnel</p><p className="mt-0.5 text-xs text-text-muted">{cloudflareTunnelEnabled ? "已启用的公共入口" : "已配置，当前未启用"}</p></div>
              <EndpointRow label="Public /v1" url={cloudflareApiEndpoint} copyId="cloudflare_url" copied={copied} onCopy={copy} badge="CF" />
            </div>
          )}
        </div>
      </section>

      <section id="require-api-key" aria-labelledby="credentials-heading" className={`${styles.credentials} overflow-hidden rounded-xl border border-border-subtle bg-surface/35`}>
        <div className="flex flex-col gap-3 border-b border-white/[0.065] bg-white/[0.018] px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-violet-400/10 text-violet-300"><span className="material-symbols-outlined text-[19px]">key</span></span>
            <div className="min-w-0">
              <h2 id="credentials-heading" className="text-sm font-semibold text-text-main">访问凭据</h2>
              <p className="mt-0.5 text-xs text-text-muted">远程 API 请求必须携带有效 Bearer / x-api-key 凭据；仅本地请求可按下方开关省略。</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-text-muted">
            <span className="rounded-md border border-white/[0.08] bg-black/[0.12] px-2 py-1">{keys.length} 个密钥</span>
            <span className="rounded-md border border-emerald-400/15 bg-emerald-400/[0.06] px-2 py-1 text-emerald-200">{activeKeyCount} 个启用</span>
            <Button icon="add" size="sm" onClick={() => setShowAddModal(true)}>新增</Button>
          </div>
        </div>

        <div className="flex items-center justify-between gap-4 border-b border-white/[0.065] bg-black/[0.08] px-4 py-3">
          <div className="min-w-0"><p className="text-sm font-medium text-text-main">强制 API 密钥验证</p><p className="mt-0.5 text-xs text-text-muted">关闭后仅本地请求可不带密钥；远程请求仍必须携带有效密钥。</p></div>
          <Toggle checked={requireApiKey} onChange={() => handleRequireApiKey(!requireApiKey)} aria-label="强制 API 密钥验证" />
        </div>

        {isRemoteHost && !requireApiKey && <div className="border-b border-white/[0.065] px-4 py-3"><SecurityWarning message="当前端点正通过远程主机访问，但 API 密钥验证未开启。" /></div>}

        {keys.length === 0 ? (
          <div className="flex min-h-64 flex-col items-center justify-center px-6 text-center">
            <span className="material-symbols-outlined mb-3 text-[34px] text-[#647688]">vpn_key</span>
            <h3 className="text-base font-semibold text-text-main">还没有访问密钥</h3>
            <p className="mt-1 max-w-sm text-sm text-text-muted">创建第一把密钥，为外部应用分配独立、可随时停用的访问凭据。</p>
            <Button icon="add" className="mt-5" onClick={() => setShowAddModal(true)}>新增密钥</Button>
          </div>
        ) : (
          <>
            <div className={`${styles.header} border-b border-white/[0.065] px-4 py-2 text-[10px] font-mono uppercase tracking-[0.15em] text-[#647688]`}>
              <span>密钥信息</span>
              <span>额度使用</span>
              <span title="滚动 60 秒内已受理的业务请求数（不是累计总数）。不含被拒绝、排队超时的请求，也不含 /v1/models 等元数据端点；服务重启后清零。">限流策略 / 实时请求</span>
              <span className="text-right">操作 / 最近访问</span>
            </div>
            <div className="divide-y divide-white/[0.065]">
              {keys.map((key) => (
                <div key={key.id} className={`${styles.row} px-4 py-3 transition-colors hover:bg-[#38bdf8]/[0.035] ${key.isActive === false ? "opacity-55" : ""}`}>
                  <div className={styles.info}>
                    <div className="flex min-w-0 items-center gap-1.5">
                      <p className="truncate text-sm font-semibold text-text-main">{key.name}</p>
                      <button
                        type="button"
                        onClick={() => {
                          setEditingKey(key);
                          setKeyNameDraft(key.name || "");
                          setKeyNameError("");
                        }}
                        title="编辑用户名"
                        aria-label={`编辑用户名：${key.name}`}
                        className="flex size-6 shrink-0 items-center justify-center rounded text-text-muted transition-colors hover:bg-white/[.07] hover:text-[#7dd3fc] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40"
                      >
                        <span className={`material-symbols-outlined ${styles.icon}`} aria-hidden="true">edit</span>
                      </button>
                      {key.isActive === false && <span className="rounded border border-amber-400/20 bg-amber-400/[.08] px-1.5 py-0.5 text-[10px] text-amber-200">已暂停</span>}
                      {key.quota?.exceededWindow && <span className="rounded border border-rose-400/25 bg-rose-400/10 px-1.5 py-0.5 text-[10px] text-rose-200">额度已满</span>}
                    </div>
                    <div className="mt-0.5 flex min-w-0 items-center gap-1">
                      <code className="truncate font-mono text-[11px] text-text-muted">{visibleKeys.has(key.id) ? key.key : maskKey(key.key)}</code>
                      <button onClick={() => toggleKeyVisibility(key.id)} className="flex size-6 shrink-0 items-center justify-center rounded text-text-muted transition-colors hover:bg-white/[.07] hover:text-[#7dd3fc]" title={visibleKeys.has(key.id) ? "隐藏密钥" : "显示密钥"} aria-label={visibleKeys.has(key.id) ? "隐藏密钥" : "显示密钥"}><span aria-hidden="true" className={`material-symbols-outlined ${styles.icon}`}>{visibleKeys.has(key.id) ? "visibility_off" : "visibility"}</span></button>
                      <button onClick={() => copy(key.key, key.id)} className="flex size-6 shrink-0 items-center justify-center rounded text-text-muted transition-colors hover:bg-white/[.07] hover:text-[#7dd3fc]" title="复制密钥" aria-label="复制密钥"><span aria-hidden="true" className={`material-symbols-outlined ${styles.icon}`}>{copied === key.id ? "check" : "content_copy"}</span></button>
                    </div>
                    <p className="mt-1 text-[11px] text-text-muted">创建于 {new Date(key.createdAt).toLocaleDateString("zh-CN")}</p>
                    {key.accessTags?.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1">
                        {key.accessTags.map((tag) => <span key={tag} className="rounded border border-violet-400/20 bg-violet-400/[0.08] px-1.5 py-0.5 font-mono text-[10px] text-violet-200">{tag}</span>)}
                      </div>
                    )}
                  </div>
                  <div className={styles.quota}>
                    <div className={styles.quotaLayout}>
                      <QuotaCell
                        quota={key.quota}
                        resettingWindow={resettingKeyQuotaId?.startsWith(`${key.id}:`)
                          ? resettingKeyQuotaId.split(":").pop()
                          : null}
                        onReset={(window) => requestResetKeyQuota(key, window)}
                      />
                      <SegmentedControl
                        className={styles.quotaModeControl}
                        size="xs"
                        value={key.quotaMode || "unlimited"}
                        onChange={(mode) => handleSetKeyQuotaMode(key.id, mode)}
                        options={[
                          { value: "off", label: "关闭" },
                          { value: "limited", label: "限额" },
                          { value: "unlimited", label: "无限制" },
                        ]}
                      />
                    </div>
                  </div>
                  <div className={styles.live}>
                    <span className={styles.mobileLabel}>限流策略</span>
                    <RateLimitPolicyCell activity={activity[key.id]} />
                    <div className={styles.liveActivity}>
                      <span className={styles.liveLabel}>实时</span>
                      <LiveActivityCell activity={activity[key.id]} />
                    </div>
                  </div>
                  <div className={styles.actions}>
                    <div className={styles.actionButtons}>
                      <KeyActionMenu
                        onRotate={() => { setRotationKey(key); setRotationError(""); }}
                        onTags={() => { setTaggingKey(key); setTagDraft(key.accessTags || []); }}
                        onRateLimit={() => openRateLimitDialog(key)}
                        onDelete={() => handleDeleteKey(key.id)}
                      />
                    </div>
                    <div className={styles.lastAccess}>
                      <span className={styles.mobileLabel}>最近访问</span>
                      <p className="truncate text-xs font-medium text-text-main">{formatLastAccess(key.lastUsedAt)}</p>
                      <p className="mt-0.5 truncate text-[10px] text-text-muted">{key.lastUsedAt ? new Date(key.lastUsedAt).toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }) : "首次成功验证后开始记录"}</p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </section>

      <Modal isOpen={Boolean(taggingKey)} title={`配置密钥权限 · ${taggingKey?.name || ""}`} onClose={() => { if (!savingTags) setTaggingKey(null); }}>
        <div className="flex flex-col gap-5">
          <AccessTagsEditor value={tagDraft} onChange={setTagDraft} hint="密钥标签仅决定它可以看到和调用哪些受限模型与模型组合；未设置标签的模型和组合对所有密钥开放。" />
          <div className="flex gap-2">
            <Button onClick={handleSaveKeyTags} loading={savingTags} fullWidth>保存标签</Button>
            <Button variant="ghost" onClick={() => setTaggingKey(null)} disabled={savingTags} fullWidth>取消</Button>
          </div>
        </div>
      </Modal>

      {/* Add Key Modal */}
      <Modal
        isOpen={showAddModal}
        title="创建 API 密钥"
        onClose={() => {
          setShowAddModal(false);
          setNewKeyName("");
        }}
      >
        <div className="flex flex-col gap-4">
          <Input
            label="密钥名称"
            value={newKeyName}
            onChange={(e) => setNewKeyName(e.target.value)}
            placeholder="例如：生产环境"
          />
          <div className="flex gap-2">
            <Button onClick={handleCreateKey} fullWidth disabled={!newKeyName.trim()}>
              Create
            </Button>
            <Button
              onClick={() => {
                setShowAddModal(false);
                setNewKeyName("");
              }}
              variant="ghost"
              fullWidth
            >
              Cancel
            </Button>
          </div>
        </div>
      </Modal>

      <Modal
        isOpen={!!editingKey}
        title="编辑用户名"
        size="sm"
        onClose={() => { if (!savingKeyName) setEditingKey(null); }}
        closeOnOverlay={!savingKeyName}
      >
        <form onSubmit={handleSaveKeyName} className="flex flex-col gap-4">
          <Input
            label="用户名"
            aria-label="用户名"
            value={keyNameDraft}
            onChange={(event) => {
              setKeyNameDraft(event.target.value);
              setKeyNameError("");
            }}
            autoFocus
            disabled={savingKeyName}
            placeholder="请输入用户名"
            hint="仅修改显示名称，不影响现有密钥的使用。"
          />
          {keyNameError && <p role="alert" className="text-xs text-red-500">{keyNameError}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" disabled={savingKeyName} onClick={() => setEditingKey(null)}>
              取消
            </Button>
            <Button type="submit" loading={savingKeyName} disabled={!keyNameDraft.trim() || savingKeyName}>
              保存
            </Button>
          </div>
        </form>
      </Modal>

      <Modal
        isOpen={!!rateLimitKey}
        title={rateLimitKey ? `请求限流 · ${rateLimitKey.name || "未命名密钥"}` : "请求限流"}
        onClose={() => { if (!savingRateLimit) setRateLimitKey(null); }}
        closeOnOverlay={!savingRateLimit}
      >
        <form onSubmit={handleSaveKeyRateLimit} className="flex flex-col gap-4">
          <p className="text-xs text-text-muted">
            三个字段留空即继承「设置 · API Key 配额」里的全局规则。队列长度填 0 表示不排队；超出每分钟上限且无法及时腾出位置的请求会返回 429。
          </p>
          <Input
            label="每分钟请求数上限 (x)"
            type="number"
            min="1"
            placeholder="继承全局"
            value={rateLimitDraft.rpmLimit}
            onChange={(event) => setRateLimitDraft((prev) => ({ ...prev, rpmLimit: event.target.value }))}
            disabled={savingRateLimit}
          />
          <Input
            label="等待队列长度 (y)"
            type="number"
            min="0"
            placeholder="继承全局"
            value={rateLimitDraft.rpmQueueMax}
            onChange={(event) => setRateLimitDraft((prev) => ({ ...prev, rpmQueueMax: event.target.value }))}
            disabled={savingRateLimit}
          />
          <Input
            label="队列最大等待 (秒)"
            type="number"
            min="1"
            placeholder="继承全局"
            value={rateLimitDraft.queueTimeoutSeconds}
            onChange={(event) => setRateLimitDraft((prev) => ({ ...prev, queueTimeoutSeconds: event.target.value }))}
            disabled={savingRateLimit}
          />
          {rateLimitError && <p role="alert" className="text-xs text-red-500">{rateLimitError}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" disabled={savingRateLimit} onClick={() => setRateLimitKey(null)}>
              取消
            </Button>
            <Button type="submit" loading={savingRateLimit}>
              保存
            </Button>
          </div>
        </form>
      </Modal>

      <Modal
        isOpen={!!rotationKey}
        title="轮换 API 密钥"
        size="sm"
        onClose={() => { if (!rotatingKey) setRotationKey(null); }}
        closeOnOverlay={!rotatingKey}
      >
        <div className="flex flex-col gap-4">
          <p className="break-words text-sm text-text-muted">确定要为「{rotationKey?.name}」重新生成密钥吗？</p>
          <div className="rounded-lg border border-amber-400/20 bg-amber-400/[.08] p-3 text-xs leading-6 text-amber-600 dark:text-amber-200">
            旧密钥将立即失效，使用它的应用需要更换为新密钥。用户名、标签、额度设置和已有用量保持不变。
          </div>
          {rotationError && <p role="alert" className="text-xs text-red-500">{rotationError}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" disabled={rotatingKey} onClick={() => setRotationKey(null)}>取消</Button>
            <Button variant="danger" loading={rotatingKey} onClick={handleRotateKey}>确认轮换</Button>
          </div>
        </div>
      </Modal>

      {/* Created / Rotated Key Modal */}
      <Modal
        isOpen={!!createdKey}
        title={createdKeyKind === "rotated" ? "API 密钥已轮换" : "API 密钥已创建"}
        onClose={() => setCreatedKey(null)}
      >
        <div className="flex flex-col gap-4">
          <div className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg p-4">
            <p className="text-sm text-yellow-800 dark:text-yellow-200 mb-2 font-medium">
              请立即保存此密钥
            </p>
            <p className="text-sm text-yellow-700 dark:text-yellow-300">
              {createdKeyKind === "rotated"
                ? "旧密钥已失效，请复制新密钥并更新所有使用它的应用。"
                : "请将密钥存放在安全的位置，不要分享给无关人员。"}
            </p>
          </div>
          <div className="flex gap-2">
            <Input
              value={createdKey || ""}
              readOnly
              className="flex-1 font-mono text-sm"
            />
            <Button
              variant="secondary"
              icon={copied === "created_key" ? "check" : "content_copy"}
              onClick={() => copy(createdKey, "created_key")}
            >
              {copied === "created_key" ? "Copied!" : "Copy"}
            </Button>
          </div>
          <Button onClick={() => setCreatedKey(null)} fullWidth>
            Done
          </Button>
        </div>
      </Modal>

      {/* Confirm Modal */}
      <ConfirmModal
        isOpen={!!confirmState}
        onClose={() => setConfirmState(null)}
        onConfirm={confirmState?.onConfirm}
        title={confirmState?.title || "Confirm"}
        message={confirmState?.message}
        variant="danger"
      />
    </div>
  );
}


APIPageClient.propTypes = {
  machineId: PropTypes.string.isRequired,
};
