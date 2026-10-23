"use client";

import { useEffect, useRef, useState } from "react";
import Button from "@/shared/components/Button";
import Toggle from "@/shared/components/Toggle";
import { useNotificationStore } from "@/store/notificationStore";

const STATUS_LABELS = {
  success: "签到成功",
  already_checked_in: "今日已签到",
  ineligible: "不满足签到条件",
  ended: "签到活动已结束",
  own_app: "请在官方应用签到",
  error: "签到失败",
};

function formatAttempt(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function hasCheckin(data) {
  // A failed or malformed GET must never turn into a default-false save.
  return data?.checkin && typeof data.checkin.enabled === "boolean";
}

function responseMessage(data, fallback) {
  if (typeof data?.message === "string" && data.message) return data.message;
  return typeof data?.error === "string" && data.error ? data.error : fallback;
}

async function requestCheckin(endpoint, method, signal, enabled) {
  const response = await fetch(endpoint, {
    method,
    signal,
    cache: "no-store",
    ...(method !== "GET" && {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(method === "PATCH" ? { enabled } : {}),
    }),
  });
  const data = await response.json();
  return { response, data };
}

function CheckinControls({ connection, onRefreshQuota }) {
  const endpoint = `/api/providers/${encodeURIComponent(connection.id)}/checkin`;
  const [checkin, setCheckin] = useState(null);
  const [loading, setLoading] = useState(true);
  const [operation, setOperation] = useState(null);
  const [error, setError] = useState("");
  const [loadAttempt, setLoadAttempt] = useState(0);
  const requestContext = useRef(null);
  const notifySuccess = useNotificationStore((state) => state.success);
  const notifyError = useNotificationStore((state) => state.error);
  const notifyWarning = useNotificationStore((state) => state.warning);

  useEffect(() => {
    const context = { active: true, busy: true, controller: new AbortController() };
    requestContext.current = context;

    async function load() {
      try {
        const { response, data } = await requestCheckin(endpoint, "GET", context.controller.signal);
        if (!response.ok) throw new Error(responseMessage(data, "加载签到设置失败，请重试"));
        if (!hasCheckin(data)) throw new Error("签到设置响应无效，请重试");
        if (context.active) setCheckin(data.checkin);
      } catch (err) {
        if (context.active) {
          setError(err instanceof SyntaxError ? "签到设置响应无效，请重试" : err.message || "加载签到设置失败，请重试");
        }
      } finally {
        if (context.active) {
          context.busy = false;
          setLoading(false);
        }
      }
    }
    load();

    return () => {
      context.active = false;
      context.controller.abort();
    };
  }, [endpoint, loadAttempt]);

  function retryLoad() {
    const context = requestContext.current;
    if (!context?.active || context.busy) return;
    context.busy = true;
    setLoading(true);
    setError("");
    setLoadAttempt((attempt) => attempt + 1);
  }

  async function mutate(method, enabled) {
    const context = requestContext.current;
    if (!context?.active || context.busy || !checkin) return;
    if (method === "POST" && connection.isActive === false) return;

    // The ref also blocks a second click before React commits disabled controls.
    context.busy = true;
    setOperation(method);
    setError("");
    try {
      const { response, data } = await requestCheckin(endpoint, method, context.controller.signal, enabled);
      if (!context.active) return;
      // Failed manual attempts can still carry the latest persisted status.
      if (method === "POST" && hasCheckin(data)) setCheckin(data.checkin);
      if (!response.ok || (method === "POST" && data?.ok !== true)) {
        throw new Error(responseMessage(data, method === "PATCH" ? "保存自动签到设置失败" : "签到失败，请重试"));
      }
      if (!hasCheckin(data)) throw new Error("签到响应无效，请重新加载设置");
      setCheckin(data.checkin);
      notifySuccess(responseMessage(data, method === "PATCH" ? (enabled ? "已开启自动签到" : "已关闭自动签到") : "签到成功"));
      if (method === "POST") {
        try {
          await onRefreshQuota?.(connection);
        } catch {
          if (context.active) notifyWarning("签到成功，但配额刷新失败，请手动刷新配额");
        }
      }
    } catch (err) {
      if (context.active) {
        const message = err instanceof SyntaxError ? "签到响应无效，请重试" : err.message || "签到请求失败，请重试";
        setError(message);
        notifyError(message);
      }
    } finally {
      if (context.active) {
        context.busy = false;
        setOperation(null);
      }
    }
  }

  const busy = loading || operation !== null;
  const attemptTime = formatAttempt(checkin?.lastAttemptAt);
  const statusLabel = STATUS_LABELS[checkin?.status] || "尚未签到";
  const message = typeof checkin?.message === "string" ? checkin.message : "";
  const reward = typeof checkin?.reward === "number" && Number.isFinite(checkin.reward) ? checkin.reward : null;

  return (
    <div className="mt-2 min-w-0 space-y-1 text-xs text-text-muted" aria-label="WorkBuddy 每日签到" aria-busy={busy}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="shrink-0">自动签到</span>
        <Toggle
          size="sm"
          checked={checkin?.enabled === true}
          disabled={busy || !checkin}
          ariaLabel="WorkBuddy 自动签到"
          onChange={(enabled) => mutate("PATCH", enabled)}
        />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={busy || !checkin || connection.isActive === false}
          loading={operation === "POST"}
          title={connection.isActive === false ? "账号已停用，请先启用账号" : "立即执行 WorkBuddy 今日签到，无需开启自动签到"}
          onClick={() => mutate("POST")}
        >
          {operation === "POST" ? "签到中…" : "立即签到"}
        </Button>
        <span className="min-w-0 break-words" role="status" aria-live="polite">
          {loading ? "加载签到设置…" : operation === "PATCH" ? "保存设置中…" : checkin ? (
            <>
              <span className={checkin.status === "error" ? "text-red-400" : undefined}>{statusLabel}</span>
              {attemptTime && <span> · 最近尝试 {attemptTime}（北京时间）</span>}
              {checkin.lastSuccessDate && <span> · 最近成功 {checkin.lastSuccessDate}</span>}
              {reward !== null && <span> · 奖励 {reward}</span>}
              {message && <span> · {message}</span>}
            </>
          ) : "签到设置未加载"}
        </span>
        {!loading && !checkin && (
          <Button type="button" variant="ghost" size="sm" onClick={retryLoad}>重新加载</Button>
        )}
      </div>
      {error && <p role="alert" className="break-words text-red-400">{error}</p>}
      <p className="text-[11px]">按北京时间每日签到；仅在服务运行且账号启用时自动执行。{!connection.providerSpecificData?.codebuddyUid && "旧版授权缺少签到 UID，请通过浏览器重新授权。"}{connection.isActive === false && "账号已停用，无法立即签到，仍可调整自动签到开关。"}</p>
    </div>
  );
}

export default function CodeBuddyCheckin({ connection, onRefreshQuota }) {
  if (connection?.provider !== "codebuddy-cn" || connection?.authType !== "oauth") return null;
  if (!connection.id) return null;

  // Remount on a refreshed connection: abort old work and never show/save another
  // account's state. The API, not providerSpecificData, is authoritative.
  return (
    <CheckinControls
      key={JSON.stringify([connection.id, connection.updatedAt ?? null])}
      connection={connection}
      onRefreshQuota={onRefreshQuota}
    />
  );
}
