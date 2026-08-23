"use client";

import { useMemo } from "react";
import { usePathname } from "next/navigation";
import PropTypes from "prop-types";
import ProviderIcon from "@/shared/components/ProviderIcon";
import { useHeaderSearchStore } from "@/store/headerSearchStore";
import { OAUTH_PROVIDERS, APIKEY_PROVIDERS } from "@/shared/constants/config";
import { MEDIA_PROVIDER_KINDS, AI_PROVIDERS } from "@/shared/constants/providers";
import { getProviderIconSrc } from "@/shared/utils/providerIcon";
import { translate } from "@/i18n/runtime";

const getPageInfo = (pathname) => {
  if (!pathname) return { title: "", description: "", breadcrumbs: [] };

  if (pathname === "/dashboard/media-providers")
    return {
      title: "媒体服务",
      description: "按能力统一管理媒体服务商、模型与连接配置",
      icon: "perm_media",
      breadcrumbs: [],
    };

  // Media provider detail: /dashboard/media-providers/[kind]/[id]
  const mediaDetailMatch = pathname.match(/\/media-providers\/([^/]+)\/([^/]+)$/);
  if (mediaDetailMatch) {
    const kindId = mediaDetailMatch[1];
    const providerId = mediaDetailMatch[2];
    const kindConfig = MEDIA_PROVIDER_KINDS.find((k) => k.id === kindId);
    const provider = AI_PROVIDERS[providerId];
    return {
      title: provider?.name || providerId,
      description: "",
      breadcrumbs: [
        { label: "媒体服务", href: `/dashboard/media-providers/${kindId}` },
        { label: kindConfig?.label || kindId, href: `/dashboard/media-providers/${kindId}` },
        { label: provider?.name || providerId, image: getProviderIconSrc(providerId) },
      ],
    };
  }

  // Media provider kind: /dashboard/media-providers/[kind]
  const mediaKindMatch = pathname.match(/\/media-providers\/([^/]+)$/);
  if (mediaKindMatch) {
    const kindId = mediaKindMatch[1];
    const kindConfig = MEDIA_PROVIDER_KINDS.find((k) => k.id === kindId);
    return {
      title: kindConfig?.label || kindId,
      description: `管理${kindConfig?.label || kindId}服务与可用模型`,
      icon: kindConfig?.icon || "perm_media",
      breadcrumbs: [],
    };
  }

  // Provider detail page: /dashboard/providers/[id]
  const providerMatch = pathname.match(/\/providers\/([^/]+)$/);
  if (providerMatch) {
    const providerId = providerMatch[1];
    const providerInfo =
      OAUTH_PROVIDERS[providerId] || APIKEY_PROVIDERS[providerId];
    if (providerInfo) {
      return {
        title: providerInfo.name,
        description: "",
        breadcrumbs: [
          { label: "渠道管理", href: "/dashboard/providers" },
          {
            label: providerInfo.name,
            image: getProviderIconSrc(providerInfo.id),
          },
        ],
      };
    }
  }

  if (pathname.includes("/providers") && !pathname.includes("/media-providers"))
    return {
      title: "渠道管理",
      description: "集中管理渠道连接、认证与可用能力",
      icon: "dns",
      breadcrumbs: [],
    };
  if (pathname.includes("/combos"))
    return {
      title: "Combos",
      description: "Model combos with fallback",
      icon: "layers",
      breadcrumbs: [],
    };
  if (pathname === "/dashboard")
    return {
      title: "首页",
      description: "查看当前使用概览、运行状态与近期趋势",
      icon: "dashboard",
      breadcrumbs: [],
    };
  if (pathname.includes("/usage"))
    return {
      title: "使用看板",
      description:
        "按 API 密钥、提供商、模型、来源 IP 与时段查看使用统计",
      icon: "bar_chart",
      breadcrumbs: [],
    };
  if (pathname.includes("/auth-files"))
    return {
      title: "Auth Files",
      description: "Map provider credentials stored in the local database",
      icon: "vpn_key",
      breadcrumbs: [],
    };
  if (pathname.includes("/quota"))
    return {
      title: "Quota Tracker",
      description: "Track and manage your API quota limits",
      icon: "data_usage",
      breadcrumbs: [],
    };
  if (pathname.includes("/mitm"))
    return {
      title: "MITM Proxy",
      description: "Intercept CLI tool traffic and route through Spring Mouse",
      icon: "security",
      breadcrumbs: [],
    };
  if (pathname.includes("/endpoint"))
    return {
      title: "集成与凭据",
      description: "管理服务端点、访问密钥与调用安全策略",
      icon: "key",
      breadcrumbs: [],
    };
  if (pathname.includes("/profile"))
    return {
      title: "Settings",
      description: "Manage your preferences",
      icon: "settings",
      breadcrumbs: [],
    };
  if (pathname.includes("/translator"))
    return {
      title: "Translator",
      description: "Debug translation flow between formats",
      icon: "translate",
      breadcrumbs: [],
    };
  if (pathname.includes("/console-log"))
    return {
      title: "Console Log",
      description: "Live server console output",
      icon: "monitor",
      breadcrumbs: [],
    };
  return { title: "", description: "", breadcrumbs: [] };
};

export default function Header({ onMenuClick, showMenuButton = true }) {
  const pathname = usePathname();
  // Memoize page info to prevent unnecessary recalculations
  const pageInfo = useMemo(() => getPageInfo(pathname), [pathname]);
  const { title, description, icon, breadcrumbs } = pageInfo;

  return (
    <header className="geek-topbar shrink-0 flex items-center justify-between gap-3 px-4 h-11 border-b border-border-subtle bg-surface z-20">
      {/* Mobile menu button */}
      <div className="flex items-center gap-3 lg:hidden shrink-0">
        {showMenuButton && (
          <button
            onClick={onMenuClick}
            className="text-text-main hover:text-primary transition-colors"
          >
            <span className="material-symbols-outlined">menu</span>
          </button>
        )}
      </div>

      {/* 终端路径 + 页面上下文（geek navbar 风格） */}
      <div className="flex items-center gap-2.5 min-w-0 flex-1 font-mono text-[12px]">
        <span className="shrink-0 text-[#38bdf8]">spring-mouse@router</span>
        <span className="shrink-0 text-[#5b6b7a]">:</span>
        <span className="shrink-0 text-[#94a5b5] hidden md:inline truncate">{pathname || "~"}</span>
        <span className="shrink-0 text-[#5b6b7a] hidden md:inline">$</span>
        <span className="shrink-0 hidden md:inline text-[#5b6b7a]">open</span>
        {/* 页面标题（末位面包屑/图标） */}
        <span className="flex items-center gap-2 min-w-0">
          {breadcrumbs.length > 0 ? (
            (() => {
              const last = breadcrumbs[breadcrumbs.length - 1];
              return (
                <>
                  {last.image && (
                    <ProviderIcon
                      src={last.image}
                      alt={last.label}
                      size={20}
                      className="object-contain rounded max-w-[20px] max-h-[20px] shrink-0"
                      fallbackText={last.label.slice(0, 2).toUpperCase()}
                    />
                  )}
                  <h1 className="font-sans text-[14px] font-semibold text-[#d7e1ea] tracking-tight truncate">
                    {translate(last.label)}
                  </h1>
                </>
              );
            })()
          ) : title ? (
            <h1 className="font-sans text-[14px] font-semibold text-[#d7e1ea] tracking-tight truncate">
              {translate(title)}
            </h1>
          ) : null}
        </span>
      </div>

      {/* Right actions */}
      <div className="flex items-center gap-1 shrink-0">
        <HeaderSearch />
      </div>
    </header>
  );
}

function HeaderSearch() {
  const visible = useHeaderSearchStore((s) => s.visible);
  const query = useHeaderSearchStore((s) => s.query);
  const placeholder = useHeaderSearchStore((s) => s.placeholder);
  const setQuery = useHeaderSearchStore((s) => s.setQuery);

  if (!visible) return null;

  return (
    <div className="relative w-[160px] sm:w-[220px]">
      <span className="material-symbols-outlined absolute left-2 top-1/2 -translate-y-1/2 text-text-muted text-[16px] pointer-events-none">
        search
      </span>
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={placeholder}
        className="w-full h-8 pl-7 pr-7 rounded-[6px] border border-[#223140] bg-[#0d1620] text-[#d7e1ea] placeholder-[#5b6b7a] text-[13px] focus:outline-none focus:border-[#38bdf8]/50 transition-colors"
      />
      {query && (
        <button
          type="button"
          onClick={() => setQuery("")}
          className="absolute right-1 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-main p-0.5 rounded"
          aria-label="Clear search"
        >
          <span className="material-symbols-outlined text-[16px]">close</span>
        </button>
      )}
    </div>
  );
}

Header.propTypes = {
  onMenuClick: PropTypes.func,
  showMenuButton: PropTypes.bool,
};
