"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Badge, Card, Drawer } from "@/shared/components";
import { getProvidersByKind } from "@/shared/constants/providers";
import MediaProviderDetailPanel from "./components/MediaProviderDetailPanel";

const MEDIA_GROUPS = [
  {
    id: "generation",
    label: "生成能力",
    description: "将文本或提示词转化为可交付的视觉内容。",
    icon: "auto_awesome",
    accent: "text-violet-500 bg-violet-500/10 border-violet-500/20",
    items: [
      { id: "image", label: "图像生成", description: "图片、插画与视觉资产", icon: "brush" },
      { id: "video", label: "视频生成", description: "视频生成、编辑与延展", icon: "movie" },
    ],
  },
  {
    id: "voice",
    label: "语音能力",
    description: "覆盖语音合成、识别与音频交互的基础服务。",
    icon: "graphic_eq",
    accent: "text-cyan-500 bg-cyan-500/10 border-cyan-500/20",
    items: [
      { id: "tts", label: "语音合成", description: "文本转自然语音", icon: "record_voice_over" },
      { id: "stt", label: "语音识别", description: "音频转文本与转写", icon: "mic" },
    ],
  },
  {
    id: "knowledge",
    label: "知识能力",
    description: "支撑语义检索、向量化和知识库构建。",
    icon: "account_tree",
    accent: "text-emerald-500 bg-emerald-500/10 border-emerald-500/20",
    items: [
      { id: "embedding", label: "嵌入生成", description: "文本向量化与相似度检索", icon: "data_array" },
    ],
  },
  {
    id: "network",
    label: "网络能力",
    description: "让模型安全地检索和获取外部网页内容。",
    icon: "public",
    accent: "text-amber-500 bg-amber-500/10 border-amber-500/20",
    items: [
      { id: "web", kinds: ["webSearch", "webFetch"], label: "网页抓取与搜索", description: "网页搜索、抓取与内容获取", icon: "travel_explore" },
    ],
  },
];

function getItemKinds(item) {
  return item.kinds || [item.id];
}

function getItemProviders(item) {
  const seen = new Set();
  return getItemKinds(item)
    .flatMap((kind) => getProvidersByKind(kind).map((provider) => ({ provider, kind })))
    .filter(({ provider }) => {
      if (seen.has(provider.id)) return false;
      seen.add(provider.id);
      return true;
    });
}

function configuredStats(item, connections) {
  const providerIds = new Set(getItemProviders(item).map(({ provider }) => provider.id));
  const matchingConnections = connections.filter((connection) => providerIds.has(connection.provider));
  const configuredProviders = new Set(matchingConnections.map((connection) => connection.provider)).size;
  const activeConnections = matchingConnections.filter((connection) => connection.isActive !== false).length;

  return { configuredProviders, activeConnections };
}

function ProviderCard({ provider, kind, connections, onOpen }) {
  const providerConnections = connections.filter((connection) => connection.provider === provider.id);
  const activeConnections = providerConnections.filter((connection) => connection.isActive !== false).length;
  const configured = providerConnections.length > 0;

  return (
    <button
      type="button"
      onClick={() => onOpen({ kind, providerId: provider.id })}
      className="group flex min-h-[76px] w-full items-center gap-3 rounded-xl border border-border-subtle bg-bg/20 px-3.5 py-3 text-left transition-all duration-150 hover:border-brand-500/35 hover:bg-brand-500/[0.035]"
    >
      <span
        className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border-subtle bg-surface-2 font-mono text-xs font-semibold text-text-muted"
        style={{ color: provider.color || undefined }}
      >
        {provider.textIcon || provider.name.slice(0, 2).toUpperCase()}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold text-text-main">{provider.name}</span>
        <span className="mt-0.5 block truncate text-xs text-text-muted">
          {configured ? `${activeConnections} 条启用连接` : "尚未接入"}
        </span>
      </span>
      <span className="material-symbols-outlined text-[17px] text-text-muted transition-all group-hover:translate-x-0.5 group-hover:text-brand-500">tune</span>
    </button>
  );
}

function CapabilityPanel({ item, connections, loading, onOpenProvider }) {
  const providers = getItemProviders(item);
  const stats = configuredStats(item, connections);

  return (
    <div className="rounded-xl border border-border-subtle bg-surface/55 p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-brand-500/10 text-brand-600 dark:text-brand-300">
            <span className="material-symbols-outlined text-[19px]">{item.icon}</span>
          </span>
          <div>
            <h3 className="text-sm font-semibold text-text-main">{item.label}</h3>
            <p className="mt-0.5 text-xs leading-5 text-text-muted">{item.description}</p>
          </div>
        </div>
        {loading ? (
          <span className="h-5 w-14 animate-pulse rounded-full bg-surface-2" />
        ) : stats.configuredProviders > 0 ? (
          <Badge variant="success" size="sm" dot>{stats.configuredProviders} 个已接入</Badge>
        ) : (
          <Badge variant="default" size="sm">未配置</Badge>
        )}
      </div>

      <div className="mt-4 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
        {providers.map(({ provider, kind }) => (
          <ProviderCard key={provider.id} provider={provider} kind={kind} connections={connections} onOpen={onOpenProvider} />
        ))}
      </div>
    </div>
  );
}

function getGroupStats(group, connections) {
  return group.items.reduce(
    (total, item) => {
      const itemStats = configuredStats(item, connections);
      return {
        configuredCapabilities: total.configuredCapabilities + Number(itemStats.configuredProviders > 0),
        activeConnections: total.activeConnections + itemStats.activeConnections,
      };
    },
    { configuredCapabilities: 0, activeConnections: 0 }
  );
}

function MediaProvidersOverviewContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [connections, setConnections] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeGroupId, setActiveGroupId] = useState("generation");
  const selectedKind = searchParams.get("kind");
  const selectedProviderId = searchParams.get("provider");
  const isDrawerOpen = Boolean(selectedKind && selectedProviderId);

  const refreshConnections = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/providers", { cache: "no-store" });
      const data = response.ok ? await response.json() : { connections: [] };
      setConnections(data.connections || []);
    } catch {
      setConnections([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshConnections();
  }, [refreshConnections]);

  useEffect(() => {
    if (!selectedKind) return;
    const parentGroup = MEDIA_GROUPS.find((group) => group.items.some((item) => getItemKinds(item).includes(selectedKind)));
    if (!parentGroup) return;
    setActiveGroupId(parentGroup.id);
  }, [selectedKind]);

  const summary = useMemo(() => {
    const capabilities = MEDIA_GROUPS.flatMap((group) => group.items);
    const configuredCapabilities = capabilities.filter((item) => configuredStats(item, connections).configuredProviders > 0).length;
    const mediaProviderIds = new Set(capabilities.flatMap((item) => getItemProviders(item).map(({ provider }) => provider.id)));
    const activeConnections = connections.filter((connection) => mediaProviderIds.has(connection.provider) && connection.isActive !== false).length;

    return { capabilities: capabilities.length, configuredCapabilities, activeConnections };
  }, [connections]);

  const activeGroup = MEDIA_GROUPS.find((group) => group.id === activeGroupId) || MEDIA_GROUPS[0];
  const activeGroupStats = getGroupStats(activeGroup, connections);

  const openProviderDrawer = ({ kind, providerId }) => {
    router.push(`/dashboard/media-providers?kind=${encodeURIComponent(kind)}&provider=${encodeURIComponent(providerId)}`, { scroll: false });
  };

  const closeProviderDrawer = () => {
    router.replace("/dashboard/media-providers", { scroll: false });
    refreshConnections();
  };



  return (
    <div className="flex flex-col gap-6">
      <section className="relative overflow-hidden rounded-[18px] border border-brand-500/15 bg-[linear-gradient(135deg,rgba(14,165,233,0.10),rgba(99,102,241,0.07)_45%,transparent_75%)] p-5 sm:p-7">
        <div aria-hidden="true" className="absolute -right-8 -top-10 text-brand-500/[0.06]">
          <span className="material-symbols-outlined text-[180px]">perm_media</span>
        </div>
        <div className="relative max-w-2xl">
          <p className="font-mono text-[11px] font-semibold uppercase tracking-[0.16em] text-brand-600 dark:text-brand-300">MEDIA SERVICE CENTER</p>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight text-text-main sm:text-3xl">统一管理媒体能力</h1>
          <p className="mt-3 max-w-xl text-sm leading-6 text-text-muted">在左侧选择能力分组，右侧集中查看服务商与连接状态；服务商配置在当前页面的抽屉中完成。</p>

          <div className="mt-6 flex flex-wrap gap-2.5">
            <Badge variant="primary" size="md" icon="apps">{summary.capabilities} 项能力</Badge>
            <Badge variant={summary.configuredCapabilities > 0 ? "success" : "default"} size="md" icon="link">{loading ? "读取接入状态" : `${summary.configuredCapabilities} 项已接入`}</Badge>
            <Badge variant="default" size="md" icon="cable">{loading ? "—" : `${summary.activeConnections} 条启用连接`}</Badge>
          </div>
        </div>
      </section>

      <div className="grid items-start gap-4 lg:grid-cols-[14rem_minmax(0,1fr)] lg:gap-6">
        <aside className="rounded-[16px] border border-border-subtle bg-surface p-2.5 shadow-[var(--shadow-soft)] lg:sticky lg:top-4">
          <p className="px-2.5 pb-2 pt-1 font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-text-muted">能力分组</p>
          <div className="grid gap-1 sm:grid-cols-2 lg:block">
            {MEDIA_GROUPS.map((group) => {
              const groupStats = getGroupStats(group, connections);
              const active = group.id === activeGroup.id;

              return (
                <button
                  key={group.id}
                  type="button"
                  onClick={() => setActiveGroupId(group.id)}
                  className={`group flex min-w-0 items-center gap-3 rounded-xl px-2.5 py-2.5 text-left transition-colors ${active ? "bg-brand-500/10 text-brand-600 dark:text-brand-300" : "text-text-muted hover:bg-surface-2 hover:text-text-main"}`}
                >
                  <span className={`flex size-8 shrink-0 items-center justify-center rounded-lg border ${active ? group.accent : "border-border-subtle bg-bg text-text-muted"}`}>
                    <span className="material-symbols-outlined text-[17px]">{group.icon}</span>
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{group.label}</span>
                    <span className="mt-0.5 block truncate text-[11px] text-text-muted">
                      {loading ? "读取状态中" : `${groupStats.configuredCapabilities}/${group.items.length} 项已接入`}
                    </span>
                  </span>
                  <span className={`material-symbols-outlined text-[17px] transition-transform ${active ? "translate-x-0.5" : "opacity-0 group-hover:opacity-100"}`}>chevron_right</span>
                </button>
              );
            })}
          </div>
        </aside>

        <section className="min-w-0 rounded-[16px] border border-border-subtle bg-surface p-4 shadow-[var(--shadow-soft)] sm:p-5">
          <div className="mb-5 flex flex-wrap items-start justify-between gap-3 border-b border-border-subtle pb-4">
            <div className="flex min-w-0 items-start gap-3">
              <span className={`flex size-10 shrink-0 items-center justify-center rounded-xl border ${activeGroup.accent}`}>
                <span className="material-symbols-outlined text-[20px]">{activeGroup.icon}</span>
              </span>
              <div>
                <h2 className="text-base font-semibold text-text-main">{activeGroup.label}</h2>
                <p className="mt-1 text-sm leading-5 text-text-muted">{activeGroup.description}</p>
              </div>
            </div>
            {loading ? (
              <span className="h-6 w-24 animate-pulse rounded-full bg-surface-2" />
            ) : (
              <Badge variant={activeGroupStats.configuredCapabilities > 0 ? "success" : "default"} size="md" icon="link">
                {activeGroupStats.configuredCapabilities}/{activeGroup.items.length} 项已接入
              </Badge>
            )}
          </div>

          <div className="grid gap-4">
            {activeGroup.items.map((item) => (
              <CapabilityPanel key={item.id} item={item} connections={connections} loading={loading} onOpenProvider={openProviderDrawer} />
            ))}
          </div>
        </section>
      </div>

      <Drawer isOpen={isDrawerOpen} onClose={closeProviderDrawer} title="服务商配置" width="2xl">
        {isDrawerOpen && (
          <MediaProviderDetailPanel
            key={`${selectedKind}:${selectedProviderId}`}
            kind={selectedKind}
            providerId={selectedProviderId}
            onClose={closeProviderDrawer}
          />
        )}
      </Drawer>
    </div>
  );
}

export default function MediaProvidersOverviewPage() {
  return (
    <Suspense fallback={<div className="py-12 text-center text-sm text-text-muted">正在加载媒体服务…</div>}>
      <MediaProvidersOverviewContent />
    </Suspense>
  );
}
