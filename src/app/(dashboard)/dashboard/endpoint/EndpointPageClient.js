"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import PropTypes from "prop-types";
import { Badge, Button, DashboardHero, Input, Modal, CardSkeleton, ConfirmModal, SegmentedControl, Toggle } from "@/shared/components";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import EndpointRow from "./components/EndpointRow";
import SecurityWarning from "./components/SecurityWarning";

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
        <span className={`material-symbols-outlined text-[15px] ${resetting ? "animate-spin" : ""}`}>
          {resetting ? "progress_activity" : "restart_alt"}
        </span>
      </button>
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
  const [confirmState, setConfirmState] = useState(null);
  const [resettingKeyQuotaId, setResettingKeyQuotaId] = useState(null);

  const [requireApiKey, setRequireApiKey] = useState(false);
  const [requireLogin, setRequireLogin] = useState(true);
  const [hasPassword, setHasPassword] = useState(true);
  const [cloudflareEndpoint, setCloudflareEndpoint] = useState("");
  const [cloudflareTunnelEnabled, setCloudflareTunnelEnabled] = useState(false);


  // API key visibility toggle state
  const [visibleKeys, setVisibleKeys] = useState(new Set());

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
        setCreatedKey(data.key);
        await fetchData();
        setNewKeyName("");
        setShowAddModal(false);
      }
    } catch (error) {
      console.log("Error creating key:", error);
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

      <section aria-labelledby="integration-heading" className="overflow-hidden rounded-xl border border-border-subtle bg-surface/35">
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

      <section id="require-api-key" aria-labelledby="credentials-heading" className="overflow-hidden rounded-xl border border-border-subtle bg-surface/35">
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
            <div className="hidden grid-cols-[minmax(16rem,1fr)_minmax(18rem,1.2fr)_minmax(11rem,0.75fr)_12.5rem] gap-5 border-b border-white/[0.065] px-4 py-2 text-[10px] font-mono uppercase tracking-[0.15em] text-[#647688] lg:grid"><span>密钥信息</span><span className="border-l border-white/[0.065] pl-5">额度使用</span><span className="border-l border-white/[0.065] pl-5">最近访问</span><span className="text-center">状态与操作</span></div>
            <div className="divide-y divide-white/[0.065]">
              {keys.map((key) => (
                <div key={key.id} className={`group grid min-w-0 grid-cols-1 gap-3 px-4 py-4 transition-colors hover:bg-[#38bdf8]/[0.035] lg:grid-cols-[minmax(16rem,1fr)_minmax(18rem,1.2fr)_minmax(11rem,0.75fr)_12.5rem] lg:items-center lg:gap-5 ${key.isActive === false ? "opacity-55" : ""}`}>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="truncate text-sm font-semibold text-text-main">{key.name}</p>
                      {key.isActive === false && <span className="rounded border border-amber-400/20 bg-amber-400/[.08] px-1.5 py-0.5 text-[10px] text-amber-200">已暂停</span>}
                      {key.quota?.exceededWindow && <span className="rounded border border-rose-400/25 bg-rose-400/10 px-1.5 py-0.5 text-[10px] text-rose-200">额度已满</span>}
                    </div>
                    <div className="mt-1 flex min-w-0 items-center gap-1.5">
                      <code className="truncate font-mono text-[11px] text-text-muted">{visibleKeys.has(key.id) ? key.key : maskKey(key.key)}</code>
                      <button onClick={() => toggleKeyVisibility(key.id)} className="flex size-6 shrink-0 items-center justify-center rounded text-text-muted transition-colors hover:bg-white/[.07] hover:text-[#7dd3fc]" title={visibleKeys.has(key.id) ? "隐藏密钥" : "显示密钥"} aria-label={visibleKeys.has(key.id) ? "隐藏密钥" : "显示密钥"}><span className="material-symbols-outlined text-[15px]">{visibleKeys.has(key.id) ? "visibility_off" : "visibility"}</span></button>
                      <button onClick={() => copy(key.key, key.id)} className="flex size-6 shrink-0 items-center justify-center rounded text-text-muted transition-colors hover:bg-white/[.07] hover:text-[#7dd3fc]" title="复制密钥" aria-label="复制密钥"><span className="material-symbols-outlined text-[15px]">{copied === key.id ? "check" : "content_copy"}</span></button>
                    </div>
                    <p className="mt-1 text-[11px] text-text-muted">创建于 {new Date(key.createdAt).toLocaleDateString("zh-CN")}</p>
                  </div>
                  <div className="border-t border-white/[0.065] pt-3 lg:border-l lg:border-t-0 lg:pl-5 lg:pt-0"><QuotaCell
                    quota={key.quota}
                    resettingWindow={resettingKeyQuotaId?.startsWith(`${key.id}:`)
                      ? resettingKeyQuotaId.split(":").pop()
                      : null}
                    onReset={(window) => requestResetKeyQuota(key, window)}
                  /></div>
                  <div className="border-t border-white/[0.065] pt-3 lg:border-l lg:border-t-0 lg:pl-5 lg:pt-0">
                    <p className="text-sm font-medium text-text-main">{formatLastAccess(key.lastUsedAt)}</p>
                    <p className="mt-0.5 text-[11px] text-text-muted">{key.lastUsedAt ? new Date(key.lastUsedAt).toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }) : "首次成功验证后开始记录"}</p>
                  </div>
                  <div className="flex flex-wrap items-center justify-end gap-3 border-t border-white/[0.065] pt-3 lg:border-0 lg:pt-0">
                    <SegmentedControl
                      size="xs"
                      value={key.quotaMode || "unlimited"}
                      onChange={(mode) => handleSetKeyQuotaMode(key.id, mode)}
                      options={[
                        { value: "off", label: "关闭" },
                        { value: "limited", label: "限额" },
                        { value: "unlimited", label: "无限制" },
                      ]}
                    />
                    <button onClick={() => handleDeleteKey(key.id)} className="flex size-8 items-center justify-center rounded-lg text-text-muted transition-colors hover:bg-red-500/10 hover:text-red-400" title="删除密钥" aria-label="删除密钥"><span className="material-symbols-outlined text-[18px]">delete</span></button>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </section>

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

      {/* Created Key Modal */}
      <Modal
        isOpen={!!createdKey}
        title="API 密钥已创建"
        onClose={() => setCreatedKey(null)}
      >
        <div className="flex flex-col gap-4">
          <div className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg p-4">
            <p className="text-sm text-yellow-800 dark:text-yellow-200 mb-2 font-medium">
              请立即保存此密钥
            </p>
            <p className="text-sm text-yellow-700 dark:text-yellow-300">
              完成此窗口后无法再次完整查看。请存放在安全的位置。
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
