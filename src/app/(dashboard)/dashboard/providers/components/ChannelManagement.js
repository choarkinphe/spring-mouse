"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  APIKEY_PROVIDERS,
  FREE_PROVIDERS,
  FREE_TIER_PROVIDERS,
  OAUTH_PROVIDERS,
  USAGE_APIKEY_PROVIDERS,
  USAGE_SUPPORTED_PROVIDERS,
} from "@/shared/constants/providers";
import { Badge, Button, ConfirmModal, Modal, ModuleSkeleton, CursorAuthModal, DashboardHero, GitLabAuthModal, IFlowCookieModal, KiroOAuthWrapper, OAuthModal, Toggle, Tooltip } from "@/shared/components";
import Input from "@/shared/components/Input";
import Drawer from "@/shared/components/Drawer";
import ProviderIcon from "@/shared/components/ProviderIcon";
import { getProviderIconSrc } from "@/shared/utils/providerIcon";
import { normalizeCustomChannelIconSrc } from "@/shared/constants/customChannelIcons";
import { cn } from "@/shared/utils/cn";
import { parseQuotaData, formatQuotaBalance, formatResetTime, getRemainingPercentage } from "../../usage/components/ProviderLimits/utils";
import AddCompatibleModal from "./AddCompatibleModal";
import ProviderDetailClient from "../[id]/ProviderDetailClient";

const CATEGORY_OPTIONS = [
  { id: "oauth", label: "OAuth", providers: OAUTH_PROVIDERS },
  { id: "free", label: "免费套餐", providers: { ...FREE_PROVIDERS, ...FREE_TIER_PROVIDERS } },
  { id: "apikey", label: "API Key", providers: APIKEY_PROVIDERS },
];

const PROVIDER_CONCURRENCY_DEFAULTS = {
  codex: {
    providerMaxConcurrentStreams: 3,
    maxConcurrentStreams: 1,
    hardConcurrencyEnabled: true,
  },
};

function getEffectiveProviderStrategy(providerId, strategy = {}) {
  return { ...(PROVIDER_CONCURRENCY_DEFAULTS[providerId] || {}), ...strategy };
}

function canTrackQuota(connection) {
  const isApiKey = connection.authType === "apikey" || connection.authType === "api_key";
  return USAGE_SUPPORTED_PROVIDERS.includes(connection.provider) && (
    connection.authType === "oauth" || (isApiKey && USAGE_APIKEY_PROVIDERS.includes(connection.provider))
  );
}

function getConnectionName(connection) {
  return connection.displayName?.trim() || connection.name?.trim() || connection.email?.trim() || "未命名配置";
}

function getProviderName(providerId) {
  return CATEGORY_OPTIONS
    .map((category) => category.providers[providerId])
    .find(Boolean)?.name || providerId;
}

function getProviderColor(providerId) {
  return CATEGORY_OPTIONS
    .map((category) => category.providers[providerId])
    .find(Boolean)?.color || "#38bdf8";
}

function getChannelName(providerId, connections) {
  const configuredName = getProviderName(providerId);
  if (configuredName !== providerId) return configuredName;
  return connections[0]?.providerSpecificData?.nodeName || connections[0]?.name || providerId;
}

function getChannelIconSrc(providerId, connections = []) {
  const customIcon = connections.find((connection) => connection.providerSpecificData?.nodeIcon)?.providerSpecificData?.nodeIcon;
  return normalizeCustomChannelIconSrc(customIcon) || getProviderIconSrc(providerId);
}

function hasActiveModelLock(connection) {
  const now = Date.now();
  return Object.entries(connection || {}).some(([key, value]) => {
    if (!key.startsWith("modelLock_") || !value) return false;
    const at = new Date(value).getTime();
    return Number.isFinite(at) && at > now;
  });
}

function getAccountStatus(connection) {
  if (connection.isActive === false) return { label: "已停用", className: "border-white/10 text-text-muted" };
  if (connection.testStatus === "limited") return { label: "限流", className: "border-amber-400/25 bg-amber-400/10 text-amber-200" };
  if (connection.testStatus === "degraded") return { label: "过载", className: "border-amber-400/25 bg-amber-400/10 text-amber-200" };
  if (["error", "expired"].includes(connection.testStatus)) return { label: "异常", className: "border-rose-400/25 bg-rose-400/10 text-rose-300" };
  if (connection.testStatus === "unavailable" && hasActiveModelLock(connection)) {
    const code = Number(connection.errorCode ?? connection.lastUpstreamStatus);
    if (code === 429) return { label: "限流", className: "border-amber-400/25 bg-amber-400/10 text-amber-200" };
    if (code >= 500) return { label: "过载", className: "border-amber-400/25 bg-amber-400/10 text-amber-200" };
    return { label: "异常", className: "border-rose-400/25 bg-rose-400/10 text-rose-300" };
  }
  if (["active", "success", "unavailable"].includes(connection.testStatus)) return { label: "可用", className: "border-emerald-400/25 bg-emerald-400/10 text-emerald-300" };
  return { label: "待检测", className: "border-amber-400/25 bg-amber-400/10 text-amber-200" };
}

function getUpstreamErrorTitle(connection) {
  const error = connection?.lastUpstreamError;
  if (!error) return "";
  const source = connection.lastUpstreamSource === "sse" ? "上游 SSE" : `上游 HTTP ${connection.lastUpstreamStatus ?? ""}`.trim();
  const raw = connection.lastUpstreamRaw && connection.lastUpstreamRaw !== error ? `\n${connection.lastUpstreamRaw}` : "";
  return `${source}\n${error}${raw}`;
}

function getQuotaTone(percentage) {
  if (percentage > 70) return "bg-emerald-400";
  if (percentage >= 30) return "bg-amber-400";
  return "bg-rose-400";
}

function getErrorMessage(value, fallback) {
  if (typeof value === "string" && value.trim()) return value;
  if (!value || typeof value !== "object") return fallback;

  for (const candidate of [value.message, value.detail, value.error, value.description]) {
    if (typeof candidate === "string" && candidate.trim()) return candidate;
  }

  return fallback;
}

function getResetCreditCount(resetCredits) {
  const count = Number(resetCredits?.availableCount);
  return Number.isFinite(count) ? Math.max(0, count) : 0;
}

function ChannelQuota({ quotas, loading }) {
  if (loading) {
    return <div className="h-10 w-full max-w-[32rem] animate-pulse rounded-lg bg-white/[0.045]" />;
  }

  if (!quotas?.length) {
    return <div className="h-10" aria-label="暂无配额信息" />;
  }

  return (
    <div className="grid w-full max-w-[38rem] grid-cols-1 gap-2 sm:grid-cols-2">
      {quotas.slice(0, 4).map((quota) => {
        const remaining = getRemainingPercentage(quota);
        const balance = formatQuotaBalance(quota);
        const reset = formatResetTime(quota.resetAt);
        return (
          <div key={quota.modelKey || quota.name} className="min-w-0">
            <div className="mb-1 flex items-center gap-2 text-[11px] leading-none">
              <span className="min-w-0 flex-1 truncate text-[#b9c7d5]">{quota.name}</span>
              {quota.unlimited ? (
                <span className="shrink-0 text-[#7dd3fc]">不限额</span>
              ) : (
                <>
                  {balance && <span className="shrink-0 font-mono text-[#e4edf5]">{balance}</span>}
                  <span className="shrink-0 font-mono text-[#e4edf5]">{remaining}%</span>
                </>
              )}
              {reset !== "-" && <span className="shrink-0 text-[#647688]">{reset}</span>}
            </div>
            {!quota.unlimited && (
              <div className="h-1 overflow-hidden rounded-full bg-white/[0.09]">
                <div className={cn("h-full rounded-full", getQuotaTone(remaining))} style={{ width: `${Math.min(remaining, 100)}%` }} />
              </div>
            )}
          </div>
        );
      })}
      {quotas.length > 4 && <span className="text-[11px] text-[#647688]">+{quotas.length - 4} 项配额</span>}
    </div>
  );
}

function getSetupMethods(provider, category) {
  if (provider.noAuth) return ["none"];
  if (Array.isArray(provider.authModes) && provider.authModes.length > 0) return provider.authModes;
  return [category === "oauth" ? "oauth" : "apikey"];
}

function ProviderConfigurationDrawer({ isOpen, provider, category, onClose, onConnectionCreated }) {
  const methods = getSetupMethods(provider, category);
  const [authMethod, setAuthMethod] = useState(methods[0]);
  const [apiKey, setApiKey] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [priority, setPriority] = useState("1");
  const [defaultModel, setDefaultModel] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [showOAuth, setShowOAuth] = useState(false);
  const [showIFlowCookie, setShowIFlowCookie] = useState(false);

  const handleApiKeySubmit = async (event) => {
    event.preventDefault();
    if (!apiKey.trim() && provider.id !== "ollama-local") {
      setError("请输入 API Key");
      return;
    }

    setSubmitting(true);
    setError("");
    try {
      const response = await fetch("/api/providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: provider.id,
          apiKey: apiKey.trim(),
          name: displayName.trim() || provider.name,
          displayName: displayName.trim() || undefined,
          priority: Math.max(1, Number(priority) || 1),
          defaultModel: defaultModel.trim() || undefined,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "创建渠道失败");
      await onConnectionCreated();
      onClose();
    } catch (requestError) {
      setError(requestError.message || "创建渠道失败");
    } finally {
      setSubmitting(false);
    }
  };

  const handleOAuthSuccess = async () => {
    setShowOAuth(false);
    setShowIFlowCookie(false);
    await onConnectionCreated();
    onClose();
  };

  const renderOAuthModal = () => {
    const commonProps = {
      isOpen: showOAuth,
      providerInfo: provider,
      onSuccess: handleOAuthSuccess,
      onClose: () => setShowOAuth(false),
    };

    if (provider.id === "kiro") return <KiroOAuthWrapper {...commonProps} />;
    if (provider.id === "cursor") return <CursorAuthModal isOpen={showOAuth} onSuccess={handleOAuthSuccess} onClose={() => setShowOAuth(false)} />;
    if (provider.id === "gitlab") return <GitLabAuthModal {...commonProps} />;
    return <OAuthModal {...commonProps} provider={provider.id} />;
  };

  return (
    <>
      <Drawer isOpen={isOpen} onClose={onClose} title={`添加 ${provider.name}`} width="lg" lockScroll={false}>
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
          <div className="flex items-center gap-3 rounded-xl border border-[#38bdf8]/20 bg-[#38bdf8]/[0.045] p-4">
            <span className="flex size-11 shrink-0 items-center justify-center rounded-xl" style={{ backgroundColor: `${provider.color || "#38bdf8"}20` }}>
              <ProviderIcon src={getProviderIconSrc(provider.id)} alt={provider.name} size={32} className="max-h-8 max-w-8 rounded-lg object-contain" fallbackText={provider.name.slice(0, 2).toUpperCase()} fallbackColor={provider.color} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-base font-semibold text-text-main">{provider.name}</span>
              <span className="mt-0.5 block text-sm text-text-muted">选择认证方式并完成渠道接入</span>
            </span>
          </div>

          {methods.length > 1 && (
            <div className="grid grid-cols-2 gap-2">
              {methods.map((method) => (
                <button key={method} type="button" onClick={() => { setAuthMethod(method); setError(""); }} className={cn("rounded-lg border px-3 py-2.5 text-sm font-medium transition-colors", authMethod === method ? "border-[#38bdf8]/55 bg-[#38bdf8]/[0.08] text-[#7dd3fc]" : "border-border bg-bg text-text-muted hover:text-text-main")}>
                  {method === "oauth" ? "OAuth 授权" : "API Key"}
                </button>
              ))}
            </div>
          )}

          {authMethod === "oauth" && (
            <div className="rounded-xl border border-border-subtle bg-bg/30 p-5">
              <span className="material-symbols-outlined text-[26px] text-[#7dd3fc]">verified_user</span>
              <h3 className="mt-3 font-semibold text-text-main">通过 OAuth 授权</h3>
              <p className="mt-1 text-sm text-text-muted">将在当前窗口发起提供商的授权流程，完成后自动回到渠道管理。</p>
              <Button icon="login" className="mt-5" onClick={() => provider.id === "iflow" ? setShowIFlowCookie(true) : setShowOAuth(true)}>
                {provider.id === "iflow" ? "使用 Cookie 认证" : "开始授权"}
              </Button>
            </div>
          )}

          {authMethod === "apikey" && (
            <form onSubmit={handleApiKeySubmit} className="rounded-xl border border-border-subtle bg-bg/30 p-5">
              <div className="grid gap-4">
                <label className="grid gap-1.5 text-sm font-medium text-text-main">
                  渠道名称
                  <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder={`${provider.name} - 默认配置`} className="h-10 rounded-lg border border-border bg-surface px-3 text-sm font-normal outline-none placeholder:text-text-muted focus:border-[#38bdf8]/60" />
                </label>
                <label className="grid gap-1.5 text-sm font-medium text-text-main">
                  API Key
                  <input value={apiKey} type="password" autoComplete="off" onChange={(event) => setApiKey(event.target.value)} placeholder={provider.id === "ollama-local" ? "本地服务无需填写" : "粘贴 API Key"} className="h-10 rounded-lg border border-border bg-surface px-3 text-sm font-normal outline-none placeholder:text-text-muted focus:border-[#38bdf8]/60" />
                </label>

                <button type="button" onClick={() => setShowAdvanced((value) => !value)} className="flex w-fit items-center gap-1 text-sm text-text-muted transition-colors hover:text-[#7dd3fc]">
                  <span className="material-symbols-outlined text-[17px]">tune</span>
                  高级配置
                  <span className="material-symbols-outlined text-[17px]">{showAdvanced ? "expand_less" : "expand_more"}</span>
                </button>

                {showAdvanced && (
                  <div className="grid gap-4 border-l border-[#38bdf8]/25 pl-4 sm:grid-cols-2">
                    <label className="grid gap-1.5 text-sm font-medium text-text-main">
                      优先级
                      <input value={priority} type="number" min="1" onChange={(event) => setPriority(event.target.value)} className="h-10 rounded-lg border border-border bg-surface px-3 text-sm font-normal outline-none focus:border-[#38bdf8]/60" />
                    </label>
                    <label className="grid gap-1.5 text-sm font-medium text-text-main">
                      默认模型
                      <input value={defaultModel} onChange={(event) => setDefaultModel(event.target.value)} placeholder="可选" className="h-10 rounded-lg border border-border bg-surface px-3 text-sm font-normal outline-none placeholder:text-text-muted focus:border-[#38bdf8]/60" />
                    </label>
                  </div>
                )}

                {error && <p className="rounded-lg border border-red-400/20 bg-red-400/10 px-3 py-2 text-sm text-red-300">{error}</p>}
                <div className="flex justify-end pt-1">
                  <Button type="submit" loading={submitting} icon="add">创建渠道</Button>
                </div>
              </div>
            </form>
          )}

          {authMethod === "none" && (
            <div className="rounded-xl border border-border-subtle bg-bg/30 p-5">
              <h3 className="font-semibold text-text-main">无需密钥的渠道</h3>
              <p className="mt-1 text-sm text-text-muted">该提供商无需填写密钥；如需调整更多参数，可在此抽屉中继续展开高级选项。</p>
              <button type="button" onClick={() => setShowAdvanced((value) => !value)} className="mt-4 flex items-center gap-1 text-sm font-medium text-[#7dd3fc] hover:text-[#bae6fd]">
                高级配置 <span className="material-symbols-outlined text-[17px]">{showAdvanced ? "expand_less" : "expand_more"}</span>
              </button>
              {showAdvanced && <p className="mt-3 rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-muted">当前提供商不需要额外的认证参数。</p>}
            </div>
          )}
        </div>
      </Drawer>
      {renderOAuthModal()}
      {provider.id === "iflow" && <IFlowCookieModal isOpen={showIFlowCookie} onSuccess={handleOAuthSuccess} onClose={() => setShowIFlowCookie(false)} />}
    </>
  );
}

function ProviderPickerDrawer({ isOpen, onClose, onConnectionCreated }) {
  const [category, setCategory] = useState("oauth");
  const [query, setQuery] = useState("");
  const [selectedProvider, setSelectedProvider] = useState(null);
  const [selectedCategory, setSelectedCategory] = useState("oauth");
  const [compatibleVariant, setCompatibleVariant] = useState(null);

  const activeCategory = CATEGORY_OPTIONS.find((item) => item.id === category) || CATEGORY_OPTIONS[0];
  const providers = useMemo(() => Object.values(activeCategory.providers)
    .filter((provider) => !provider.hidden && (provider.serviceKinds ?? ["llm"]).includes("llm"))
    .filter((provider) => provider.name.toLowerCase().includes(query.trim().toLowerCase()))
    .sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999) || a.name.localeCompare(b.name)), [activeCategory, query]);

  const handleClose = () => {
    setSelectedProvider(null);
    setCompatibleVariant(null);
    onClose();
  };

  const handleCompatibleCreated = (node) => {
    setCompatibleVariant(null);
    setSelectedProvider({
      id: node.id,
      name: node.name,
      color: node.type === "anthropic-compatible" ? "#D97757" : "#10A37F",
      textIcon: node.type === "anthropic-compatible" ? "AC" : "OC",
      apiType: node.apiType,
      authModes: ["apikey"],
    });
    setSelectedCategory("apikey");
  };

  return (
    <>
      <Drawer isOpen={isOpen} onClose={handleClose} title="新增渠道" width="xl">
        <div className="flex flex-col gap-5">
          <div>
            <p className="text-sm text-text-muted">选择一个已支持的提供商；选择后会在上层抽屉中继续完成认证配置。</p>
          </div>

          <div className="rounded-xl border border-border-subtle bg-bg/30 p-4">
            <p className="mb-3 text-xs font-mono uppercase tracking-[0.16em] text-[#647688]">自定义兼容渠道</p>
            <div className="grid gap-2 sm:grid-cols-2">
              <Button variant="secondary" icon="add" onClick={() => setCompatibleVariant("openai")}>新增 OpenAI 兼容渠道</Button>
              <Button variant="secondary" icon="add" onClick={() => setCompatibleVariant("anthropic")}>新增 Anthropic 兼容渠道</Button>
            </div>
          </div>

          <div>
            <div className="flex gap-2 border-b border-border-subtle">
              {CATEGORY_OPTIONS.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setCategory(item.id)}
                  className={cn(
                    "relative px-2.5 pb-3 text-sm transition-colors",
                    category === item.id ? "text-[#7dd3fc]" : "text-text-muted hover:text-text-main",
                  )}
                >
                  {item.label}
                  {category === item.id && <span className="absolute inset-x-2.5 bottom-0 h-px bg-[#38bdf8]" />}
                </button>
              ))}
            </div>
          </div>

          <label className="relative block">
            <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-[18px] text-text-muted">search</span>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索提供商"
              className="h-10 w-full rounded-lg border border-border bg-bg pl-10 pr-3 text-sm outline-none transition-colors placeholder:text-text-muted focus:border-[#38bdf8]/60"
            />
          </label>

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {providers.map((provider) => (
              <button
                key={provider.id}
                type="button"
                onClick={() => { setSelectedProvider(provider); setSelectedCategory(category); }}
                className="group flex min-w-0 items-center gap-3 rounded-xl border border-border-subtle bg-bg/35 p-3 text-left transition-colors hover:border-[#38bdf8]/40 hover:bg-[#38bdf8]/[0.055]"
              >
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg" style={{ backgroundColor: `${provider.color || "#38bdf8"}20` }}>
                  <ProviderIcon
                    src={getProviderIconSrc(provider.id)}
                    alt={provider.name}
                    size={28}
                    className="max-h-7 max-w-7 rounded-md object-contain"
                    fallbackText={provider.textIcon || provider.name.slice(0, 2).toUpperCase()}
                    fallbackColor={provider.color}
                  />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-text-main">{provider.name}</span>
                  <span className="mt-0.5 block text-xs text-text-muted">选择并配置</span>
                </span>
                <span className="material-symbols-outlined text-[18px] text-text-muted transition-transform group-hover:translate-x-0.5 group-hover:text-[#7dd3fc]">arrow_forward</span>
              </button>
            ))}
          </div>

          {providers.length === 0 && <p className="py-8 text-center text-sm text-text-muted">没有匹配的提供商</p>}

        </div>
      </Drawer>

      {selectedProvider && (
        <ProviderConfigurationDrawer
          key={selectedProvider.id}
          isOpen={true}
          provider={selectedProvider}
          category={selectedCategory}
          onClose={() => setSelectedProvider(null)}
          onConnectionCreated={onConnectionCreated}
        />
      )}
      <AddCompatibleModal
        variant="openai"
        isOpen={compatibleVariant === "openai"}
        nested
        onClose={() => setCompatibleVariant(null)}
        onCreated={handleCompatibleCreated}
      />
      <AddCompatibleModal
        variant="anthropic"
        isOpen={compatibleVariant === "anthropic"}
        nested
        onClose={() => setCompatibleVariant(null)}
        onCreated={handleCompatibleCreated}
      />
    </>
  );
}

function ChannelRow({ connection, quotas, quotaLoading, resetCreditCount, resetting, resetError, isFirst, isLast, reordering, onRefreshQuota, onResetCodexLimit, onToggle, onMoveUp, onMoveDown }) {
  const providerName = getProviderName(connection.provider);
  const providerColor = getProviderColor(connection.provider);
  const quotaAvailable = canTrackQuota(connection);
  const isCodex = connection.provider === "codex";
  const status = getAccountStatus(connection);
  const canReorder = !(isFirst && isLast);

  return (
    <div className={cn("group grid min-w-0 grid-cols-1 gap-4 px-4 py-4 transition-colors hover:bg-[#38bdf8]/[0.035] lg:grid-cols-[minmax(18rem,0.85fr)_minmax(25rem,1.45fr)_8rem] lg:items-center lg:gap-6", !(connection.isActive ?? true) && "opacity-55")}>
      <div className="flex min-w-0 items-center gap-3">
        {canReorder && (
          <div className="flex shrink-0 flex-col" aria-label="调整账号顺序">
            <button
              type="button"
              onClick={onMoveUp}
              disabled={isFirst || reordering}
              aria-label={`上移 ${getConnectionName(connection)}`}
              className={cn("rounded p-0.5 text-text-muted transition-colors hover:bg-white/[0.07] hover:text-[#7dd3fc]", (isFirst || reordering) && "cursor-not-allowed opacity-25 hover:bg-transparent hover:text-text-muted")}
            >
              <span className="material-symbols-outlined text-[16px]">keyboard_arrow_up</span>
            </button>
            <button
              type="button"
              onClick={onMoveDown}
              disabled={isLast || reordering}
              aria-label={`下移 ${getConnectionName(connection)}`}
              className={cn("rounded p-0.5 text-text-muted transition-colors hover:bg-white/[0.07] hover:text-[#7dd3fc]", (isLast || reordering) && "cursor-not-allowed opacity-25 hover:bg-transparent hover:text-text-muted")}
            >
              <span className="material-symbols-outlined text-[16px]">keyboard_arrow_down</span>
            </button>
          </div>
        )}
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl" style={{ backgroundColor: `${providerColor}20` }}>
          <ProviderIcon
            src={normalizeCustomChannelIconSrc(connection.providerSpecificData?.nodeIcon) || getProviderIconSrc(connection.provider)}
            alt={providerName}
            size={32}
            className="max-h-8 max-w-8 rounded-lg object-contain"
            fallbackText={providerName.slice(0, 2).toUpperCase()}
            fallbackColor={providerColor}
          />
        </span>
        <span className="min-w-0">
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-semibold text-text-main">{getConnectionName(connection)}</span>
            <span className={cn("shrink-0 rounded border px-1.5 py-0.5 text-[10px]", status.className)}>{status.label}</span>
          </span>
          <span className="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-text-muted">
            <span className="truncate">{providerName}</span>
            <span className="text-[#506070]">/</span>
            <span>{connection.authType === "oauth" ? "OAuth" : "API Key"}</span>
            {connection.email && <><span className="text-[#506070]">·</span><span className="truncate">{connection.email}</span></>}
          </span>
          {connection.accessTags?.length > 0 && (
            <span className="mt-1.5 flex flex-wrap gap-1">
              {connection.accessTags.map((tag) => <span key={tag} className="rounded border border-violet-400/20 bg-violet-400/[0.08] px-1.5 py-0.5 font-mono text-[9px] text-violet-200">{tag}</span>)}
            </span>
          )}
        </span>
      </div>

      <div className="min-w-0 lg:border-l lg:border-white/[0.065] lg:pl-6">
        <ChannelQuota quotas={quotas} loading={quotaLoading} />
        {connection.lastUpstreamError && connection.isActive !== false ? (
          <div className="mt-2 flex min-w-0 items-center gap-1.5 text-xs text-rose-400" title={getUpstreamErrorTitle(connection)}>
            <span className="material-symbols-outlined shrink-0 text-[15px]">error</span>
            <span className="truncate">
              {connection.lastUpstreamSource === "sse" ? "上游 SSE · " : `上游 HTTP ${connection.lastUpstreamStatus ?? ""} · `}
              {connection.lastUpstreamError}
            </span>
          </div>
        ) : (
          <div className="mt-2 text-xs text-[#647688]">暂无渠道方返回错误</div>
        )}
      </div>

      <div className="flex items-center justify-end gap-1 border-t border-white/[0.065] pt-3 lg:border-0 lg:pt-0">
        {isCodex && (
          <Tooltip text={resetCreditCount > 0 ? `使用 1 张额度重置券（剩余 ${resetCreditCount} 张）` : "暂无可用的 Codex 重置券"}>
            <button
              type="button"
              onClick={() => onResetCodexLimit(connection)}
              disabled={resetCreditCount <= 0 || quotaLoading || resetting}
              aria-label={resetCreditCount > 0 ? `使用 1 张 Codex 重置券，剩余 ${resetCreditCount} 张` : "暂无可用的 Codex 重置券"}
              className={cn(
                "flex h-8 min-w-10 items-center justify-center gap-1 rounded-lg border px-2 text-[11px] font-medium tabular-nums transition-colors disabled:cursor-not-allowed disabled:opacity-50",
                resetCreditCount > 0
                  ? "border-[#38bdf8]/35 bg-[#38bdf8]/[0.08] text-[#7dd3fc] hover:bg-[#38bdf8]/[0.14]"
                  : "border-white/[0.08] bg-white/[0.025] text-text-muted",
              )}
            >
              <span className={cn("material-symbols-outlined text-[17px]", resetting && "animate-spin")}>
                {resetting ? "progress_activity" : "restart_alt"}
              </span>
              <span>{resetCreditCount}</span>
            </button>
          </Tooltip>
        )}
        {quotaAvailable && (
          <Tooltip text="刷新配额">
            <button type="button" onClick={() => onRefreshQuota(connection)} disabled={quotaLoading} aria-label="刷新配额" className="flex size-8 items-center justify-center rounded-lg text-text-muted transition-colors hover:bg-white/[0.07] hover:text-[#7dd3fc] disabled:cursor-not-allowed disabled:opacity-50">
              <span className={cn("material-symbols-outlined text-[18px]", quotaLoading && "animate-spin")}>refresh</span>
            </button>
          </Tooltip>
        )}
        <div className="ml-2 pl-2 border-l border-white/[0.08]">
          <Toggle size="sm" checked={connection.isActive ?? true} onChange={(isActive) => onToggle(connection, isActive)} title={(connection.isActive ?? true) ? "停用渠道" : "启用渠道"} />
        </div>
      </div>
    </div>
  );
}

function ChannelGroup({ group, quotaData, quotaLoading, resetCreditsByConnection, resettingConnectionId, resetErrors, providerStrategies, modelCounts, reordering, onRefreshQuota, onResetCodexLimit, onToggle, onMoveConnection, onOpenAccountConfig, onConfigureStrategy, onSetRoundRobin, onSetRoundRobinLimit }) {
  const activeCount = group.connections.filter((connection) => connection.isActive !== false).length;
  const quotaCount = group.connections.filter((connection) => quotaData[connection.id]?.length > 0).length;
  const channelName = getChannelName(group.provider, group.connections);
  const channelColor = getProviderColor(group.provider);
  const routing = getEffectiveProviderStrategy(group.provider, providerStrategies[group.provider]);
  const roundRobinEnabled = routing.fallbackStrategy === "round-robin";
  const stickyLimit = routing.stickyRoundRobinLimit || 1;
  const modelCount = modelCounts[group.provider] || 0;
  const hardConcurrency = Number.isFinite(Number(routing.providerMaxConcurrentStreams));
  const breakerEnabled = routing.enableModelBreaker !== false;

  return (
    <section className="relative overflow-visible rounded-xl border border-border-subtle bg-surface/35">
      <div className="rounded-t-[11px] flex flex-col gap-3 border-b border-white/[0.065] bg-white/[0.018] px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg" style={{ backgroundColor: `${channelColor}20` }}>
            <ProviderIcon
              src={getChannelIconSrc(group.provider, group.connections)}
              alt={channelName}
              size={28}
              className="max-h-7 max-w-7 rounded-md object-contain"
              fallbackText={channelName.slice(0, 2).toUpperCase()}
              fallbackColor={channelColor}
            />
          </span>
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold text-text-main">{channelName}</h2>
            <p className="mt-0.5 truncate text-xs text-text-muted">{group.provider}</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-text-muted">
          <span className="rounded-md border border-white/[0.08] bg-black/[0.12] px-2 py-1">{group.connections.length} 个账号</span>
          <span className="rounded-md border border-emerald-400/15 bg-emerald-400/[0.06] px-2 py-1 text-emerald-200">{activeCount} 个启用</span>
          <span className="rounded-md border border-violet-400/15 bg-violet-400/[0.06] px-2 py-1 text-violet-200">{modelCount} 个模型</span>
          {quotaCount > 0 && <span className="rounded-md border border-[#38bdf8]/15 bg-[#38bdf8]/[0.06] px-2 py-1 text-[#bae6fd]">{quotaCount} 个有配额</span>}

          <span className="hidden h-5 w-px bg-white/[0.08] sm:block" aria-hidden="true" />

          {group.connections.length > 1 && (
            <div className="flex items-center gap-1.5 rounded-lg border border-white/[0.08] bg-black/[0.12] px-2 py-1.5">
              <span className="text-[11px] font-medium text-[#b9c7d5]">用户粘滞均衡</span>
              <Tooltip text="同一 API Key 会优先复用上次命中的账号；新 API Key 自动分配到下一个账号。">
                <span>
                  <Toggle
                    size="sm"
                    checked={roundRobinEnabled}
                    onChange={(enabled) => onSetRoundRobin(group.provider, enabled, stickyLimit)}
                    aria-label={`${channelName} 用户粘滞均衡`}
                  />
                </span>
              </Tooltip>
            </div>
          )}

          <Tooltip text={hardConcurrency ? `渠道总并发 ${routing.providerMaxConcurrentStreams} · 单账号 ${routing.maxConcurrentStreams || 1}` : "未启用渠道级硬并发"}>
            <span className={cn("rounded-md border px-2 py-1", hardConcurrency ? "border-[#38bdf8]/15 bg-[#38bdf8]/[0.06] text-[#bae6fd]" : "border-white/[0.08] bg-black/[0.12]")}>
              {hardConcurrency ? `并发 ${routing.providerMaxConcurrentStreams}` : "软并发"}
            </span>
          </Tooltip>
          <Tooltip text={breakerEnabled ? `模型熔断：${routing.breakerThreshold || 3} 次失败后冷却 ${routing.breakerCooldownSeconds || Math.round((routing.breakerCooldownMs || 60000) / 1000)} 秒` : "模型熔断已关闭"}>
            <span className={cn("rounded-md border px-2 py-1", breakerEnabled ? "border-violet-400/15 bg-violet-400/[0.06] text-violet-200" : "border-white/[0.08] bg-black/[0.12] text-text-muted")}>
              {breakerEnabled ? "熔断" : "熔断关"}
            </span>
          </Tooltip>

          <Tooltip text="账号配置">
            <button type="button" onClick={() => onOpenAccountConfig(group.provider)} aria-label={`${channelName} 账号配置`} className="flex size-8 items-center justify-center rounded-lg text-text-muted transition-colors hover:bg-white/[0.07] hover:text-[#7dd3fc]">
              <span className="material-symbols-outlined text-[18px]">manage_accounts</span>
            </button>
          </Tooltip>

          <Tooltip text="并发与熔断策略">
            <button type="button" onClick={() => onConfigureStrategy(group.provider)} aria-label={`${channelName} 并发与熔断策略`} className="flex size-8 items-center justify-center rounded-lg text-text-muted transition-colors hover:bg-white/[0.07] hover:text-[#7dd3fc]">
              <span className="material-symbols-outlined text-[18px]">settings</span>
            </button>
          </Tooltip>

        </div>
      </div>
      <div className="hidden grid-cols-[minmax(18rem,0.85fr)_minmax(25rem,1.45fr)_8rem] gap-6 border-b border-white/[0.065] px-4 py-2 text-[10px] font-mono uppercase tracking-[0.15em] text-[#647688] lg:grid">
        <span>账号配置</span>
        <span className="border-l border-white/[0.065] pl-6">配额</span>
        <span className="text-center">操作</span>
      </div>
      <div className="divide-y divide-white/[0.065]">
        {group.connections.map((connection, index) => (
          <ChannelRow
            key={connection.id}
            connection={connection}
            quotas={quotaData[connection.id]}
            quotaLoading={quotaLoading[connection.id]}
            resetCreditCount={resetCreditsByConnection[connection.id] || 0}
            resetting={resettingConnectionId === connection.id}
            resetError={resetErrors[connection.id]}
            isFirst={index === 0}
            isLast={index === group.connections.length - 1}
            reordering={reordering}
            onRefreshQuota={onRefreshQuota}
            onResetCodexLimit={onResetCodexLimit}
            onToggle={onToggle}
            onMoveUp={() => onMoveConnection(group.connections, index, index - 1)}
            onMoveDown={() => onMoveConnection(group.connections, index, index + 1)}
          />
        ))}
      </div>
    </section>
  );
}

function ChannelDetailDrawer({ providerId, onClose, onUpdated }) {
  return (
    <Drawer isOpen={Boolean(providerId)} onClose={onClose} title="渠道详情" width="2xl">
      {providerId && (
        <ProviderDetailClient
          providerId={providerId}
          embedded
          onClose={onClose}
          onUpdated={onUpdated}
        />
      )}
    </Drawer>
  );
}

function ChannelOrderModal({ isOpen, groups, saving, error, onClose, onSave }) {
  const [orderedProviderIds, setOrderedProviderIds] = useState([]);

  useEffect(() => {
    if (isOpen) setOrderedProviderIds(groups.map((group) => group.provider));
  }, [isOpen, groups]);

  const moveProvider = (index, offset) => {
    const targetIndex = index + offset;
    if (targetIndex < 0 || targetIndex >= orderedProviderIds.length) return;
    setOrderedProviderIds((current) => {
      const next = [...current];
      [next[index], next[targetIndex]] = [next[targetIndex], next[index]];
      return next;
    });
  };

  const groupsByProvider = new Map(groups.map((group) => [group.provider, group]));
  const orderedGroups = orderedProviderIds.map((providerId) => groupsByProvider.get(providerId)).filter(Boolean);

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="自定义渠道排序" size="lg" closeOnOverlay={!saving}>
      <div className="flex flex-col gap-4">
        <div className="flex items-start gap-3 rounded-xl border border-[#38bdf8]/15 bg-[#38bdf8]/[0.045] px-4 py-3">
          <span className="material-symbols-outlined mt-0.5 text-[19px] text-[#7dd3fc]">swap_vert</span>
          <div>
            <p className="text-sm font-medium text-text-main">调整渠道在管理列表中的展示顺序</p>
            <p className="mt-1 text-xs leading-5 text-text-muted">使用右侧箭头移动渠道。新添加且尚未排序的渠道会按名称排列在已配置渠道之后。</p>
          </div>
        </div>

        <div className="overflow-hidden rounded-xl border border-border-subtle bg-bg/25">
          {orderedGroups.map((group, index) => {
            const channelName = getChannelName(group.provider, group.connections);
            const channelColor = getProviderColor(group.provider);
            return (
              <div key={group.provider} className="flex min-w-0 items-center gap-3 border-b border-white/[0.06] px-3 py-2.5 last:border-b-0">
                <span className="w-7 shrink-0 text-center font-mono text-xs text-[#647688]">{String(index + 1).padStart(2, "0")}</span>
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg" style={{ backgroundColor: `${channelColor}20` }}>
                  <ProviderIcon
                    src={getChannelIconSrc(group.provider, group.connections)}
                    alt={channelName}
                    size={27}
                    className="max-h-[27px] max-w-[27px] rounded-md object-contain"
                    fallbackText={channelName.slice(0, 2).toUpperCase()}
                    fallbackColor={channelColor}
                  />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-text-main">{channelName}</span>
                  <span className="mt-0.5 block truncate font-mono text-[10px] text-text-muted">{group.provider}</span>
                </span>
                <span className="rounded-md border border-white/[0.07] bg-black/[0.1] px-2 py-1 text-[10px] text-text-muted">{group.connections.length} 个账号</span>
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    onClick={() => moveProvider(index, -1)}
                    disabled={index === 0 || saving}
                    aria-label={`上移 ${channelName}`}
                    className={cn("flex size-8 items-center justify-center rounded-lg text-text-muted transition-colors hover:bg-white/[0.07] hover:text-[#7dd3fc]", (index === 0 || saving) && "cursor-not-allowed opacity-25 hover:bg-transparent hover:text-text-muted")}
                  >
                    <span className="material-symbols-outlined text-[18px]">keyboard_arrow_up</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => moveProvider(index, 1)}
                    disabled={index === orderedGroups.length - 1 || saving}
                    aria-label={`下移 ${channelName}`}
                    className={cn("flex size-8 items-center justify-center rounded-lg text-text-muted transition-colors hover:bg-white/[0.07] hover:text-[#7dd3fc]", (index === orderedGroups.length - 1 || saving) && "cursor-not-allowed opacity-25 hover:bg-transparent hover:text-text-muted")}
                  >
                    <span className="material-symbols-outlined text-[18px]">keyboard_arrow_down</span>
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        {error && <p className="text-sm text-rose-400">{error}</p>}

        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
          <Button variant="ghost" onClick={() => onSave([])} disabled={saving}>恢复名称排序</Button>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose} disabled={saving}>取消</Button>
            <Button onClick={() => onSave(orderedProviderIds)} loading={saving}>保存排序</Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

const STRATEGY_DEFAULTS = {
  providerMaxConcurrentStreams: 3,
  maxConcurrentStreams: 1,
  queueTimeoutSeconds: 60,
  maxQueueSize: 50,
  breakerThreshold: 3,
  breakerWindowSeconds: 120,
  breakerCooldownSeconds: 60,
};

function channelStrategyForm(strategy = {}) {
  const toSeconds = (ms, fallback) => Math.max(1, Math.round((Number(ms) || fallback * 1000) / 1000));
  return {
    providerMaxConcurrentStreams: Number(strategy.providerMaxConcurrentStreams) || STRATEGY_DEFAULTS.providerMaxConcurrentStreams,
    maxConcurrentStreams: Number(strategy.maxConcurrentStreams) || STRATEGY_DEFAULTS.maxConcurrentStreams,
    queueTimeoutSeconds: toSeconds(strategy.queueTimeoutMs, STRATEGY_DEFAULTS.queueTimeoutSeconds),
    maxQueueSize: Number(strategy.maxQueueSize) || STRATEGY_DEFAULTS.maxQueueSize,
    breakerThreshold: Number(strategy.breakerThreshold) || STRATEGY_DEFAULTS.breakerThreshold,
    breakerWindowSeconds: toSeconds(strategy.breakerWindowMs, STRATEGY_DEFAULTS.breakerWindowSeconds),
    breakerCooldownSeconds: toSeconds(strategy.breakerCooldownMs, STRATEGY_DEFAULTS.breakerCooldownSeconds),
  };
}

function ChannelStrategyModal({ providerId, strategy = {}, saving, error, onClose, onSave }) {
  const [form, setForm] = useState(() => channelStrategyForm(strategy));
  const [hardEnabled, setHardEnabled] = useState(() => Number.isFinite(Number(strategy.providerMaxConcurrentStreams)));
  const [breakerEnabled, setBreakerEnabled] = useState(() => strategy.enableModelBreaker !== false);

  const updateNumber = (key, value) => {
    setForm((current) => ({ ...current, [key]: value === "" ? "" : Math.max(0, Number.parseInt(value, 10) || 0) }));
  };

  const submit = () => {
    const providerLimit = Math.max(1, Number(form.providerMaxConcurrentStreams) || 1);
    const accountLimit = Math.max(1, Number(form.maxConcurrentStreams) || 1);
    if (accountLimit > providerLimit) return;
    onSave(providerId, {
      ...(strategy.fallbackStrategy === "round-robin" ? { fallbackStrategy: "round-robin" } : {}),
      ...(Number.isFinite(Number(strategy.stickyRoundRobinLimit)) ? { stickyRoundRobinLimit: Number(strategy.stickyRoundRobinLimit) } : {}),
      hardConcurrencyEnabled: hardEnabled,
      providerMaxConcurrentStreams: hardEnabled ? providerLimit : null,
      maxConcurrentStreams: accountLimit,
      queueTimeoutMs: Math.max(1, Number(form.queueTimeoutSeconds) || 1) * 1000,
      maxQueueSize: Math.max(1, Number(form.maxQueueSize) || 1),
      enableModelBreaker: breakerEnabled,
      breakerThreshold: Math.max(1, Number(form.breakerThreshold) || 1),
      breakerWindowMs: Math.max(5, Number(form.breakerWindowSeconds) || 5) * 1000,
      breakerCooldownMs: Math.max(1, Number(form.breakerCooldownSeconds) || 1) * 1000,
    });
  };

  const numberField = (key, label, min, max, hint) => (
    <Input
      key={key}
      label={label}
      type="number"
      min={min}
      max={max}
      value={String(form[key] ?? "")}
      onChange={(event) => updateNumber(key, event.target.value)}
      hint={hint}
    />
  );

  return (
    <Modal
      isOpen={Boolean(providerId)}
      onClose={onClose}
      title="并发与熔断策略"
      size="lg"
      footer={(
        <div className="flex w-full items-center justify-between gap-3">
          <Button variant="ghost" onClick={onClose} disabled={saving}>取消</Button>
          <Button onClick={submit} loading={saving}>保存策略</Button>
        </div>
      )}
    >
      <div className="flex flex-col gap-5">
        <section className="rounded-lg border border-white/[0.07] bg-white/[0.02] p-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium text-text-main">渠道硬并发</p>
              <p className="mt-1 text-xs text-text-muted">超出总并发或账号并发后请求排队；关闭后恢复旧的软负载策略。</p>
            </div>
            <Toggle size="sm" checked={hardEnabled} onChange={setHardEnabled} />
          </div>
          <div className={cn("mt-3 grid gap-3 sm:grid-cols-2", !hardEnabled && "opacity-50 pointer-events-none")}>
            {numberField("providerMaxConcurrentStreams", "渠道总并发", 1, 1000, "该渠道所有账号同时进入上游的最大权重请求数。")}
            {numberField("maxConcurrentStreams", "单账号并发", 1, 1000, "单个账号同时处理的最大权重请求数；账号单独配置优先。")}
            {numberField("queueTimeoutSeconds", "排队超时（秒）", 1, 3600, "超时后返回 429，并携带 Retry-After。")}
            {numberField("maxQueueSize", "最大排队数", 1, 1000, "队列满时新请求立即返回限流错误。")}
          </div>
        </section>

        <section className="rounded-lg border border-white/[0.07] bg-white/[0.02] p-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium text-text-main">模型熔断</p>
              <p className="mt-1 text-xs text-text-muted">同一渠道同一模型连续失败后，暂停扫描所有账号并整体冷却。</p>
            </div>
            <Toggle size="sm" checked={breakerEnabled} onChange={setBreakerEnabled} />
          </div>
          <div className={cn("mt-3 grid gap-3 sm:grid-cols-2", !breakerEnabled && "opacity-50 pointer-events-none")}>
            {numberField("breakerThreshold", "连续失败阈值", 1, 100, "达到次数后打开熔断。")}
            {numberField("breakerWindowSeconds", "失败统计窗口（秒）", 5, 3600, "窗口外的失败不连续计数。")}
            {numberField("breakerCooldownSeconds", "熔断冷却（秒）", 1, 3600, "冷却结束后恢复尝试。")}
          </div>
        </section>

        <p className="text-xs text-text-muted">
          权重规则：约每 100 条消息占 1 个并发额度，约每 20 个工具占 1 个额度，超长字符串输入按 10 万字符约等于 1 个额度，最大权重为 8。
        </p>
        {error && <p className="text-xs text-rose-400">{error}</p>}
      </div>
    </Modal>
  );
}

export default function ChannelManagement({ initialDetailProviderId = null }) {
  const router = useRouter();
  const [connections, setConnections] = useState([]);
  const [providerStrategies, setProviderStrategies] = useState({});
  const [providerChannelOrder, setProviderChannelOrder] = useState([]);
  const [channelOrderModalOpen, setChannelOrderModalOpen] = useState(false);
  const [savingChannelOrder, setSavingChannelOrder] = useState(false);
  const [channelOrderError, setChannelOrderError] = useState("");
  const [modelCounts, setModelCounts] = useState({});
  const [quotaData, setQuotaData] = useState({});
  const [quotaLoading, setQuotaLoading] = useState({});
  const [resetCreditsByConnection, setResetCreditsByConnection] = useState({});
  const [resettingConnectionId, setResettingConnectionId] = useState(null);
  const [resetConfirmConnection, setResetConfirmConnection] = useState(null);
  const [resetErrors, setResetErrors] = useState({});
  const [loading, setLoading] = useState(true);
  const [reorderingProviderId, setReorderingProviderId] = useState(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [detailProviderId, setDetailProviderId] = useState(initialDetailProviderId);
  const [strategyProviderId, setStrategyProviderId] = useState(null);
  const [strategySaving, setStrategySaving] = useState(false);
  const [strategyError, setStrategyError] = useState("");

  const fetchConnections = useCallback(async () => {
    setLoading(true);
    try {
      const [response, settingsResponse] = await Promise.all([
        fetch("/api/providers?includeModelCounts=1", { cache: "no-store" }),
        fetch("/api/settings", { cache: "no-store" }),
      ]);
      if (!response.ok) throw new Error("Failed to fetch channels");
      const [data, settingsData] = await Promise.all([
        response.json(),
        settingsResponse.ok ? settingsResponse.json() : Promise.resolve({}),
      ]);
      setConnections(data.connections || []);
      setProviderStrategies(settingsData.providerStrategies || {});
      setProviderChannelOrder(Array.isArray(settingsData.providerChannelOrder) ? settingsData.providerChannelOrder : []);
      setModelCounts(data.modelCounts || {});
      return data.connections || [];
    } catch (error) {
      console.error("Failed to fetch channels:", error);
      setConnections([]);
      return [];
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshQuota = useCallback(async (connection, force = false) => {
    if (!canTrackQuota(connection)) return;
    setQuotaLoading((current) => ({ ...current, [connection.id]: true }));
    try {
      const response = await fetch(`/api/usage/${connection.id}${force ? "?force=1" : ""}`);
      const data = await response.json().catch(() => ({}));
      if (response.ok && !data.error) {
        setQuotaData((current) => ({ ...current, [connection.id]: parseQuotaData(connection.provider, data) }));
      }

      if (connection.provider === "codex") {
        // The usage route includes reset credits, but when an upstream usage
        // request fails (for example, 429) use the dedicated endpoint only
        // after the first request finishes. This prevents competing OAuth and
        // upstream requests for the same account from making the UI flaky.
        let resetCredits = data.resetCredits;
        if (!resetCredits) {
          const resetCreditsResponse = await fetch(
            `/api/usage/${connection.id}/codex-reset-credits`,
            { cache: "no-store" },
          );
          const resetCreditsData = await resetCreditsResponse.json().catch(() => ({}));
          if (!resetCreditsResponse.ok) {
            throw new Error(getErrorMessage(resetCreditsData.error || resetCreditsData.message, "无法读取 Codex 重置券"));
          }
          resetCredits = resetCreditsData;
        }

        setResetCreditsByConnection((current) => ({
          ...current,
          [connection.id]: getResetCreditCount(resetCredits),
        }));
        setResetErrors((current) => ({ ...current, [connection.id]: null }));
      }
    } catch (error) {
      console.error("Failed to refresh quota:", error);
      if (connection.provider === "codex") {
        setResetErrors((current) => ({
          ...current,
          [connection.id]: getErrorMessage(error, "无法读取 Codex 用量或重置券"),
        }));
      }
    } finally {
      setQuotaLoading((current) => ({ ...current, [connection.id]: false }));
    }
  }, []);

  const handleResetCodexLimit = useCallback(async (connection) => {
    if (connection.provider !== "codex" || resettingConnectionId) return;
    setResettingConnectionId(connection.id);
    setResetErrors((current) => ({ ...current, [connection.id]: null }));
    try {
      const response = await fetch(`/api/usage/${connection.id}/codex-reset-credits`, { method: "POST" });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(getErrorMessage(result.error || result.message, "重置 Codex 额度失败"));
      }
      await refreshQuota(connection, true);
    } catch (error) {
      setResetErrors((current) => ({ ...current, [connection.id]: getErrorMessage(error, "重置 Codex 额度失败") }));
    } finally {
      setResettingConnectionId(null);
    }
  }, [refreshQuota, resettingConnectionId]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      fetchConnections().then(async (items) => {
        const trackedConnections = items.filter(canTrackQuota);
        const nonCodexConnections = trackedConnections.filter((connection) => connection.provider !== "codex");
        const codexConnections = trackedConnections.filter((connection) => connection.provider === "codex");

        // Other providers remain concurrent. Codex is synchronized one account
        // at a time to avoid competing OAuth token refreshes on initial load.
        await Promise.all(nonCodexConnections.map((connection) => refreshQuota(connection)));
        for (const connection of codexConnections) {
          await refreshQuota(connection);
        }
      });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [fetchConnections, refreshQuota]);

  const openChannelDetail = (providerId) => {
    setDetailProviderId(providerId);
    router.replace(`/dashboard/providers?channel=${encodeURIComponent(providerId)}`, { scroll: false });
  };

  const closeChannelDetail = () => {
    setDetailProviderId(null);
    router.replace("/dashboard/providers", { scroll: false });
  };

  const handleToggle = async (connection, isActive) => {
    setConnections((items) => items.map((item) => item.id === connection.id ? { ...item, isActive } : item));
    try {
      const response = await fetch(`/api/providers/${connection.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive }),
      });
      if (!response.ok) throw new Error("Failed to update channel");
    } catch (error) {
      console.error("Failed to update channel:", error);
      setConnections((items) => items.map((item) => item.id === connection.id ? { ...item, isActive: connection.isActive } : item));
    }
  };

  const handleMoveConnection = async (orderedConnections, sourceIndex, targetIndex) => {
    if (targetIndex < 0 || targetIndex >= orderedConnections.length || reorderingProviderId) return;

    const movingConnection = orderedConnections[sourceIndex];
    const displacedConnection = orderedConnections[targetIndex];
    const sourcePriority = sourceIndex + 1;
    const targetPriority = targetIndex + 1;

    setReorderingProviderId(movingConnection.provider);
    setConnections((items) => items.map((item) => {
      if (item.id === movingConnection.id) return { ...item, priority: targetPriority };
      if (item.id === displacedConnection.id) return { ...item, priority: sourcePriority };
      return item;
    }));

    try {
      const displacedResponse = await fetch(`/api/providers/${displacedConnection.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ priority: sourcePriority }),
      });
      if (!displacedResponse.ok) throw new Error("Failed to update displaced account priority");

      const movingResponse = await fetch(`/api/providers/${movingConnection.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ priority: targetPriority }),
      });
      if (!movingResponse.ok) throw new Error("Failed to update account priority");
    } catch (error) {
      console.error("Failed to reorder channel accounts:", error);
      await fetchConnections();
    } finally {
      setReorderingProviderId(null);
    }
  };

  const saveProviderStrategySettings = async (providerId, strategy) => {
    const previous = providerStrategies;
    const updated = { ...previous, [providerId]: strategy };
    setProviderStrategies(updated);
    try {
      const response = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerStrategies: updated }),
      });
      if (!response.ok) throw new Error("Failed to update provider strategy");
      return true;
    } catch (error) {
      console.error("Failed to update provider strategy:", error);
      setProviderStrategies(previous);
      return false;
    }
  };

  const saveProviderStrategy = async (providerId, strategy) => {
    setStrategySaving(true);
    setStrategyError("");
    const saved = await saveProviderStrategySettings(providerId, strategy);
    setStrategySaving(false);
    if (saved) setStrategyProviderId(null);
    else setStrategyError("保存策略失败，请稍后重试");
  };

  const saveProviderRouting = async (providerId, enabled, stickyLimit) => {
    const previous = providerStrategies;
    const current = previous[providerId] || {};
    const updated = { ...previous };
    const next = {
      ...current,
      fallbackStrategy: enabled ? "round-robin" : undefined,
      stickyRoundRobinLimit: enabled ? Math.max(1, Number.parseInt(stickyLimit, 10) || 1) : undefined,
    };
    if (!enabled) {
      delete next.fallbackStrategy;
      delete next.stickyRoundRobinLimit;
    }
    if (Object.keys(next).length > 0) updated[providerId] = next;
    else delete updated[providerId];

    setProviderStrategies(updated);
    try {
      const response = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerStrategies: updated }),
      });
      if (!response.ok) throw new Error("Failed to update account routing");
    } catch (error) {
      console.error("Failed to update account routing:", error);
      setProviderStrategies(previous);
    }
  };

  const handleSetRoundRobin = (providerId, enabled, stickyLimit) => {
    saveProviderRouting(providerId, enabled, stickyLimit);
  };

  const handleSetRoundRobinLimit = (providerId, stickyLimit) => {
    saveProviderRouting(providerId, true, stickyLimit);
  };

  const saveProviderChannelOrder = async (nextOrder) => {
    const normalizedOrder = [...new Set(nextOrder.filter((providerId) => typeof providerId === "string" && providerId))];
    const previousOrder = providerChannelOrder;
    setProviderChannelOrder(normalizedOrder);
    setSavingChannelOrder(true);
    setChannelOrderError("");
    try {
      const response = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerChannelOrder: normalizedOrder }),
      });
      if (!response.ok) throw new Error("保存渠道排序失败");
      setChannelOrderModalOpen(false);
      return true;
    } catch (error) {
      console.error("Failed to save provider channel order:", error);
      setProviderChannelOrder(previousOrder);
      setChannelOrderError(error instanceof Error ? error.message : "保存渠道排序失败");
      return false;
    } finally {
      setSavingChannelOrder(false);
    }
  };

  const channelGroups = useMemo(() => {
    const groups = new Map();
    connections.forEach((connection) => {
      const group = groups.get(connection.provider) || { provider: connection.provider, connections: [] };
      group.connections.push(connection);
      groups.set(connection.provider, group);
    });
    const orderIndex = new Map(providerChannelOrder.map((providerId, index) => [providerId, index]));
    return Array.from(groups.values())
      .map((group) => ({
        ...group,
        connections: [...group.connections].sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999) || getConnectionName(a).localeCompare(getConnectionName(b))),
      }))
      .sort((a, b) => {
        const aIndex = orderIndex.has(a.provider) ? orderIndex.get(a.provider) : Number.MAX_SAFE_INTEGER;
        const bIndex = orderIndex.has(b.provider) ? orderIndex.get(b.provider) : Number.MAX_SAFE_INTEGER;
        return aIndex - bIndex || getChannelName(a.provider, a.connections).localeCompare(getChannelName(b.provider, b.connections));
      });
  }, [connections, providerChannelOrder]);

  const activeConnectionCount = connections.filter((connection) => connection.isActive !== false).length;

  return (
    <div className="flex min-w-0 flex-col gap-5 px-1 sm:px-0">
      <DashboardHero
        eyebrow="Provider connections"
        title="渠道管理"
        description="集中查看每个渠道的连接状态、可用模型与配额信息。"
        icon="hub"
        action={(
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              icon="swap_vert"
              onClick={() => {
                setChannelOrderError("");
                setChannelOrderModalOpen(true);
              }}
              disabled={loading || channelGroups.length < 2}
            >
              渠道排序
            </Button>
            <Button icon="add" onClick={() => setPickerOpen(true)}>新增渠道</Button>
          </div>
        )}
      >
        <Badge variant="primary" size="md" icon="hub">{channelGroups.length} 个渠道</Badge>
        <Badge variant={activeConnectionCount > 0 ? "success" : "default"} size="md" icon="link">{loading ? "读取连接状态" : `${activeConnectionCount} 条启用连接`}</Badge>
        <Badge variant="default" size="md" icon="database">{loading ? "—" : `${connections.length} 个账号配置`}</Badge>
      </DashboardHero>

      {loading ? (
        <div className="grid min-w-0 grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.45fr)_minmax(20rem,0.75fr)]">
          <ModuleSkeleton title="正在读取渠道连接" icon="hub" lines={6} className="min-h-[320px]" />
          <div className="flex flex-col gap-4">
            <ModuleSkeleton title="正在同步渠道状态" icon="sync" lines={4} className="min-h-[150px]" />
            <ModuleSkeleton title="正在预载渠道额度" icon="account_balance_wallet" lines={4} className="min-h-[150px]" />
          </div>
        </div>
      ) : connections.length === 0 ? (
        <div className="flex min-h-64 flex-col items-center justify-center rounded-xl border border-dashed border-border bg-bg/20 px-6 text-center">
          <span className="material-symbols-outlined mb-3 text-[34px] text-[#647688]">hub</span>
          <h2 className="text-base font-semibold text-text-main">还没有配置渠道</h2>
          <p className="mt-1 max-w-sm text-sm text-text-muted">添加一个提供商并完成认证后，渠道和配额信息会显示在这里。</p>
          <Button icon="add" className="mt-5" onClick={() => setPickerOpen(true)}>新增渠道</Button>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {channelGroups.map((group) => (
            <ChannelGroup
              key={group.provider}
              group={group}
              quotaData={quotaData}
              quotaLoading={quotaLoading}
              resetCreditsByConnection={resetCreditsByConnection}
              resettingConnectionId={resettingConnectionId}
              resetErrors={resetErrors}
              providerStrategies={providerStrategies}
              modelCounts={modelCounts}
              reordering={Boolean(reorderingProviderId)}
              onRefreshQuota={(item) => refreshQuota(item, true)}
              onResetCodexLimit={(connection) => setResetConfirmConnection(connection)}
              onToggle={handleToggle}
              onMoveConnection={handleMoveConnection}
              onOpenAccountConfig={openChannelDetail}
              onConfigureStrategy={(providerId) => {
                setStrategyError("");
                setStrategyProviderId(providerId);
              }}
              onSetRoundRobin={handleSetRoundRobin}
              onSetRoundRobinLimit={handleSetRoundRobinLimit}
            />
          ))}
        </div>
      )}

      <ChannelStrategyModal
        providerId={strategyProviderId}
        strategy={getEffectiveProviderStrategy(strategyProviderId, providerStrategies[strategyProviderId])}
        saving={strategySaving}
        error={strategyError}
        onClose={() => setStrategyProviderId(null)}
        onSave={saveProviderStrategy}
      />

      <ChannelOrderModal
        isOpen={channelOrderModalOpen}
        groups={channelGroups}
        saving={savingChannelOrder}
        error={channelOrderError}
        onClose={() => {
          if (!savingChannelOrder) setChannelOrderModalOpen(false);
        }}
        onSave={saveProviderChannelOrder}
      />

      <ConfirmModal
        isOpen={Boolean(resetConfirmConnection)}
        onClose={() => {
          if (!resettingConnectionId) setResetConfirmConnection(null);
        }}
        onConfirm={async () => {
          const connection = resetConfirmConnection;
          if (!connection) return;
          await handleResetCodexLimit(connection);
          setResetConfirmConnection(null);
        }}
        title="使用 Codex 重置券？"
        message={`将为 ${getConnectionName(resetConfirmConnection || {})} 使用 1 张额度重置券，同时恢复 5 小时和每周额度。此操作无法撤销。`}
        confirmText="立即重置"
        cancelText="取消"
        variant="primary"
        loading={Boolean(resettingConnectionId)}
      />

      <ProviderPickerDrawer
        isOpen={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onConnectionCreated={fetchConnections}
      />
      <ChannelDetailDrawer
        providerId={detailProviderId}
        onClose={closeChannelDetail}
        onUpdated={fetchConnections}
      />
    </div>
  );
}
