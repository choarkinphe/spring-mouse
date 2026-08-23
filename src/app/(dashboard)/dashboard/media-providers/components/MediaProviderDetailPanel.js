"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AddCustomEmbeddingModal, Badge, Button, Card, ProviderInfoCard } from "@/shared/components";
import ProviderIcon from "@/shared/components/ProviderIcon";
import { AI_PROVIDERS, MEDIA_PROVIDER_KINDS, isCustomEmbeddingProvider } from "@/shared/constants/providers";
import ConnectionsCard from "@/app/(dashboard)/dashboard/providers/components/ConnectionsCard";
import ModelsCard from "@/app/(dashboard)/dashboard/providers/components/ModelsCard";
import { KIND_EXAMPLE_CONFIG } from "../[kind]/[id]/components/exampleShared";
import { EmbeddingExampleCard } from "../[kind]/[id]/components/EmbeddingExampleCard";
import { GenericExampleCard } from "../[kind]/[id]/components/GenericExampleCard";
import { SttExampleCard } from "../[kind]/[id]/components/SttExampleCard";
import { TtsExampleCard } from "../[kind]/[id]/components/TtsExampleCard";

export default function MediaProviderDetailPanel({ kind, providerId, onClose }) {
  const router = useRouter();
  const kindConfig = MEDIA_PROVIDER_KINDS.find((item) => item.id === kind);
  const isCustom = isCustomEmbeddingProvider(providerId) && kind === "embedding";
  const [customNode, setCustomNode] = useState(null);
  const [customLoading, setCustomLoading] = useState(isCustom);
  const [showEditModal, setShowEditModal] = useState(false);

  useEffect(() => {
    if (!isCustom) return undefined;

    let cancelled = false;
    fetch("/api/provider-nodes", { cache: "no-store" })
      .then((response) => response.json())
      .then((data) => {
        if (cancelled) return;
        setCustomNode((data.nodes || []).find((node) => node.id === providerId) || null);
        setCustomLoading(false);
      })
      .catch(() => {
        if (!cancelled) setCustomLoading(false);
      });

    return () => { cancelled = true; };
  }, [isCustom, providerId]);

  const handleDeleteCustom = async () => {
    if (!confirm("Delete this Custom Embedding node?")) return;

    try {
      const response = await fetch(`/api/provider-nodes/${providerId}`, { method: "DELETE" });
      if (response.ok) {
        if (onClose) onClose();
        else router.replace("/dashboard/media-providers");
      }
    } catch (error) {
      console.log("Error deleting custom embedding node:", error);
    }
  };

  if (!kindConfig) {
    return <div className="py-12 text-center text-sm text-text-muted">不支持的媒体能力。</div>;
  }

  const builtInProvider = AI_PROVIDERS[providerId];
  const provider = isCustom
    ? (customNode ? { id: providerId, name: customNode.name || "Custom Embedding", color: "#6366F1", textIcon: "CE" } : null)
    : builtInProvider;

  if (isCustom && customLoading) {
    return <div className="py-12 text-center text-sm text-text-muted">正在加载服务商配置…</div>;
  }

  if (!provider || (!isCustom && !(provider.serviceKinds ?? ["llm"]).includes(kind))) {
    return <div className="py-12 text-center text-sm text-text-muted">未找到此媒体服务商。</div>;
  }

  const kinds = isCustom ? ["embedding"] : (provider.serviceKinds ?? ["llm"]);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-4">
        <div className="flex size-12 shrink-0 items-center justify-center rounded-xl" style={{ backgroundColor: `${provider.color || "#64748b"}18` }}>
          <ProviderIcon
            src={`/providers/${provider.id}.png`}
            alt={provider.name}
            size={48}
            className="max-h-[48px] max-w-[48px] rounded-lg object-contain"
            fallbackText={provider.textIcon || provider.id.slice(0, 2).toUpperCase()}
            fallbackColor={provider.color}
          />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 sm:gap-3">
            <h2 className="truncate text-2xl font-semibold tracking-tight text-text-main">{provider.name}</h2>
            {!isCustom && provider.notice?.apiKeyUrl && (
              <a
                href={provider.notice.apiKeyUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
              >
                <span className="material-symbols-outlined text-sm">open_in_new</span>
                获取 API Key
              </a>
            )}
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {isCustom && <Badge variant="default" size="sm">Custom · {customNode?.prefix}</Badge>}
            {kinds.map((item) => (
              <Badge key={item} variant={item === kind ? "primary" : "default"} size="sm">{item.toUpperCase()}</Badge>
            ))}
          </div>
        </div>
        {isCustom && (
          <div className="flex w-full gap-2 sm:w-auto">
            <Button size="sm" variant="secondary" icon="edit" onClick={() => setShowEditModal(true)}>编辑</Button>
            <Button size="sm" variant="secondary" icon="delete" onClick={handleDeleteCustom}>删除</Button>
          </div>
        )}
      </div>

      {!isCustom && provider.kindNotice?.[kind] && (
        <div className="flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-amber-700 dark:text-amber-400">
          <span className="material-symbols-outlined mt-0.5 text-[20px]">warning</span>
          <p className="text-sm">{provider.kindNotice[kind]}</p>
        </div>
      )}

      {!isCustom && provider.notice?.text && !provider.deprecated && (
        <div className="flex flex-col gap-2 rounded-lg border border-blue-500/30 bg-blue-500/10 px-3 py-2 sm:flex-row sm:items-center">
          <span className="material-symbols-outlined shrink-0 text-[16px] text-blue-500">info</span>
          <p className="min-w-0 flex-1 text-xs leading-relaxed text-blue-600 dark:text-blue-400">{provider.notice.text}</p>
          {provider.notice.apiKeyUrl && (
            <a
              href={provider.notice.apiKeyUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex justify-center rounded bg-blue-500 px-2 py-1 text-xs font-medium text-white transition-colors hover:bg-blue-600 sm:py-0.5"
            >
              获取 API Key →
            </a>
          )}
        </div>
      )}

      {!isCustom && provider.noAuth ? (
        <Card>
          <div className="py-8 text-center text-sm text-text-muted">此提供商无需凭据配置，可直接使用。</div>
        </Card>
      ) : (
        <ConnectionsCard providerId={providerId} isOAuth={false} />
      )}

      {kind !== "tts" && kind !== "webSearch" && kind !== "webFetch" && (
        <ModelsCard
          providerId={providerId}
          kindFilter={kind}
          providerAliasOverride={isCustom ? customNode?.prefix : undefined}
        />
      )}

      {!isCustom && (provider.searchConfig || provider.fetchConfig || provider.ttsConfig || provider.sttConfig || provider.embeddingConfig || provider.searchViaChat) && (
        <ProviderInfoCard
          config={
            kind === "webFetch" ? provider.fetchConfig
              : kind === "tts" ? provider.ttsConfig
              : kind === "stt" ? provider.sttConfig
              : kind === "embedding" ? provider.embeddingConfig
              : provider.searchConfig || { mode: "chat-completions", defaultModel: provider.searchViaChat?.defaultModel, pricingUrl: provider.searchViaChat?.pricingUrl, freeTier: provider.searchViaChat?.freeTier }
          }
          provider={provider}
          title={`${kindConfig.label} Config`}
        />
      )}

      {kind === "embedding" && <EmbeddingExampleCard providerId={providerId} customAlias={customNode?.prefix} />}
      {kind === "tts" && <TtsExampleCard providerId={providerId} />}
      {kind === "stt" && !isCustom && <SttExampleCard providerId={providerId} />}
      {!isCustom && KIND_EXAMPLE_CONFIG[kind] && <GenericExampleCard providerId={providerId} kind={kind} />}

      {isCustom && (
        <AddCustomEmbeddingModal
          isOpen={showEditModal}
          node={customNode}
          onClose={() => setShowEditModal(false)}
          onSaved={(updated) => {
            setCustomNode(updated);
            setShowEditModal(false);
          }}
        />
      )}
    </div>
  );
}
