"use client";

import { useState, useEffect } from "react";
import PropTypes from "prop-types";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/shared/utils/cn";
import { APP_CONFIG, UPDATER_CONFIG } from "@/shared/constants/config";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import Button from "./Button";
import { ConfirmModal } from "./Modal";
import useSettingsStore from "@/store/settingsStore";
import useProviderStore from "@/store/providerStore";

const channelItems = [
  { href: "/dashboard/providers", label: "渠道管理", icon: "hub" },
];

const operationItems = [
  { href: "/dashboard/combos", label: "路由策略", icon: "layers" },
  { href: "/dashboard/usage", label: "使用看板", icon: "bar_chart" },
];

const systemItems = [
  { href: "/dashboard/endpoint", label: "集成与凭据", icon: "key" },
  { href: "/dashboard/open-platform", label: "开放平台", icon: "api" },
  { href: "/dashboard/profile", label: "设置", icon: "settings" },
];

const debugItems = [
  { href: "/dashboard/console-log", label: "控制台日志", icon: "terminal" },
  { href: "/dashboard/chat-debug", label: "对话调试", icon: "forum" },
  { href: "/dashboard/translator", label: "翻译器", icon: "translate" },
];

/* 菜单项 — geek console 紧凑行：图标 + 标签，激活态青色左指示条 */
function MenuLink({ href, icon, label, active, collapsed, onClose, indent = false }) {
  return (
    <Link
      href={href}
      onClick={onClose}
      title={collapsed ? label : undefined}
      className={cn(
        "relative flex items-center gap-2.5 h-9 rounded-[6px] transition-colors group",
        indent ? "pl-8 pr-3" : "px-3",
        collapsed && "lg:justify-center lg:px-0",
        active
          ? "bg-[#38bdf8]/10 text-[#38bdf8]"
          : "text-[#9aa9b8] hover:bg-[#16202c] hover:text-[#d7e1ea]"
      )}
    >
      {active && (
        <span
          aria-hidden="true"
          className={cn(
            "absolute left-0 top-1.5 bottom-1.5 w-[2px] rounded-full bg-[#38bdf8]",
            collapsed && "lg:left-0.5"
          )}
        />
      )}
      <span
        className={cn(
          "material-symbols-outlined text-[17px] shrink-0",
          active ? "fill-1" : "group-hover:text-[#38bdf8] transition-colors"
        )}
      >
        {icon}
      </span>
      <span className={cn("text-[13px] font-medium truncate", collapsed && "lg:hidden")}>
        {label}
      </span>
    </Link>
  );
}

MenuLink.propTypes = {
  href: PropTypes.string.isRequired,
  icon: PropTypes.string.isRequired,
  label: PropTypes.string.isRequired,
  active: PropTypes.bool,
  collapsed: PropTypes.bool,
  onClose: PropTypes.func,
  indent: PropTypes.bool,
};

/* 分组标题 — 细mono分隔，折叠态退化为细线 */
function MenuSection({ title, collapsed, children }) {
  return (
    <div className="pt-3 mt-1 space-y-0.5">
      <div className={cn("flex items-center gap-2 px-3 mb-1.5", collapsed && "lg:justify-center lg:px-0")}>
        <span
          className={cn(
            "text-[10px] font-mono font-semibold uppercase tracking-[0.16em] text-[#5b6b7a]",
            collapsed && "lg:hidden"
          )}
        >
          {title}
        </span>
        <span aria-hidden="true" className={cn("h-px flex-1 bg-[#1e2a36]", collapsed && "lg:w-4")} />
      </div>
      {children}
    </div>
  );
}

MenuSection.propTypes = {
  title: PropTypes.string.isRequired,
  collapsed: PropTypes.bool,
  children: PropTypes.node,
};

export default function Sidebar({ onClose }) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const [isDisconnected, setIsDisconnected] = useState(false);
  const [updateInfo, setUpdateInfo] = useState(null);
  const [showUpdateModal, setShowUpdateModal] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);
  const [shutdownCountdown, setShutdownCountdown] = useState(0);
  const [enableTranslator, setEnableTranslator] = useState(false);
  const fetchSettings = useSettingsStore((state) => state.fetchSettings);
  const fetchProviders = useProviderStore((state) => state.fetchProviders);
  const { copied, copy } = useCopyToClipboard(2000);

  const INSTALL_CMD = UPDATER_CONFIG.installCmdLatest;

  useEffect(() => {
    fetchSettings()
      .then((settings) => setEnableTranslator(settings?.enableTranslator === true))
      .catch(() => {});
    // Warm the provider store while the dashboard shell is already loading.
    // Provider, quota, media and chat pages can then render from the same
    // 60-second client cache instead of starting a new request on navigation.
    fetchProviders().catch(() => {});
  }, [fetchProviders, fetchSettings]);

  // Lazy check for new npm version on mount
  useEffect(() => {
    fetch("/api/version")
      .then(res => res.json())
      .then(data => { if (data.hasUpdate) setUpdateInfo(data); })
      .catch(() => {});
  }, []);

  const isActive = (href) => pathname.startsWith(href);

  // Open manual update panel (no countdown yet — user must click Copy to trigger shutdown)
  const handleUpdate = () => {
    setShowUpdateModal(false);
    setIsUpdating(true);
  };

  // Triggered by Copy button inside ManualUpdatePanel: copy + countdown + shutdown
  const handleCopyAndShutdown = async () => {
    try { await navigator.clipboard.writeText(INSTALL_CMD); } catch { /* clipboard blocked */ }
    copy(INSTALL_CMD);
    let remaining = UPDATER_CONFIG.shutdownCountdownSec;
    setShutdownCountdown(remaining);
    const timer = setInterval(() => {
      remaining -= 1;
      setShutdownCountdown(remaining);
      if (remaining <= 0) {
        clearInterval(timer);
        fetch("/api/version/shutdown", { method: "POST" }).catch(() => {});
        setIsDisconnected(true);
      }
    }, 1000);
  };

  const handleCancelUpdate = () => {
    setIsUpdating(false);
    setShutdownCountdown(0);
  };

  // Note: legacy updater poll removed. New flow: copy install cmd + shutdown server,
  // user runs the command manually in another terminal.

  return (
    <>
      <aside
        className={cn(
          "flex flex-col w-48 shrink-0 border-r border-[#1e2a36] bg-[#0d1620] transition-[width] duration-300 min-h-full",
          collapsed && "lg:w-14"
        )}
      >
        {/* Logo 行 — 44px，终端式标识 + 折叠按钮 */}
        <div className="h-11 flex items-center gap-2 px-3 border-b border-[#1e2a36]">
          <Link href="/dashboard" className="flex items-center gap-2 min-w-0" title={APP_CONFIG.name}>
            <span
              aria-hidden="true"
              className="select-none shrink-0 font-mono text-[13px] font-bold text-[#38bdf8] bg-[#38bdf8]/10 border border-[#38bdf8]/25 rounded-[5px] px-1.5 py-0.5 leading-none"
            >
              &gt;_
            </span>
            <span className={cn("flex items-center min-w-0", collapsed && "lg:hidden")}>
              <span className="text-[13px] font-semibold tracking-tight text-[#d7e1ea] leading-none truncate">
                {APP_CONFIG.name}
              </span>
            </span>
          </Link>
          <button
            type="button"
            onClick={() => setCollapsed((v) => !v)}
            className="hidden lg:flex ml-auto shrink-0 size-6 items-center justify-center rounded text-[#5b6b7a] hover:text-[#38bdf8] hover:bg-[#16202c] transition-colors cursor-pointer"
            aria-label={collapsed ? "展开侧边栏" : "折叠侧边栏"}
            title={collapsed ? "展开" : "折叠"}
          >
            <span className="material-symbols-outlined text-[15px]">
              {collapsed ? "chevron_right" : "chevron_left"}
            </span>
          </button>
        </div>

        {/* 更新提示（深色适配） */}
        {updateInfo && (
          <div className="mx-2 mt-2 flex flex-col gap-1 rounded-[6px] border border-emerald-500/20 bg-emerald-500/5 p-1.5">
            <span className="text-[11px] font-semibold text-emerald-400">
              ↑ New version: v{updateInfo.latestVersion}
            </span>
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => setShowUpdateModal(true)}
                className="px-1.5 py-0.5 rounded bg-emerald-600 hover:bg-emerald-500 text-white text-[10px] font-semibold transition-colors cursor-pointer"
              >
                Update
              </button>
              <button
                onClick={() => copy(INSTALL_CMD)}
                title="Copy install command"
                className="flex-1 min-w-0 text-left hover:opacity-80 transition-opacity cursor-pointer"
              >
                <code className="block text-[9px] text-emerald-400/70 font-mono truncate">
                  {copied ? "✓ copied!" : INSTALL_CMD}
                </code>
              </button>
            </div>
          </div>
        )}

        {/* Navigation — group business capabilities by user task, and keep infrastructure settings separate. */}
        <nav className="flex-1 px-2 py-2 space-y-0.5 overflow-y-auto overflow-x-hidden custom-scrollbar">
          <MenuSection title="业务运营" collapsed={collapsed}>
            {channelItems.map((item) => (
              <MenuLink
                key={item.href}
                href={item.href}
                icon={item.icon}
                label={item.label}
                active={isActive(item.href)}
                collapsed={collapsed}
                onClose={onClose}
              />
            ))}

            <MenuLink
              href="/dashboard/media-providers"
              icon="perm_media"
              label="媒体服务"
              active={isActive("/dashboard/media-providers")}
              collapsed={collapsed}
              onClose={onClose}
            />

            {operationItems.map((item) => (
              <MenuLink
                key={item.href}
                href={item.href}
                icon={item.icon}
                label={item.label}
                active={isActive(item.href)}
                collapsed={collapsed}
                onClose={onClose}
              />
            ))}
          </MenuSection>

          <MenuSection title="系统设置" collapsed={collapsed}>
            {systemItems.map((item) => (
              <MenuLink
                key={item.href}
                href={item.href}
                icon={item.icon}
                label={item.label}
                active={isActive(item.href)}
                collapsed={collapsed}
                onClose={onClose}
              />
            ))}
          </MenuSection>

          <MenuSection title="开发工具" collapsed={collapsed}>
            {debugItems.map((item) => {
              const show = item.href !== "/dashboard/translator" || enableTranslator;
              return show ? (
                <MenuLink
                  key={item.href}
                  href={item.href}
                  icon={item.icon}
                  label={item.label}
                  active={isActive(item.href)}
                  collapsed={collapsed}
                  onClose={onClose}
                />
              ) : null;
            })}
          </MenuSection>
        </nav>
      </aside>

      {/* Update Confirmation Modal */}
      <ConfirmModal
        isOpen={showUpdateModal}
        onClose={() => setShowUpdateModal(false)}
        onConfirm={handleUpdate}
        title="Update Spring Mouse"
        message={`Show install command for v${updateInfo?.latestVersion || ""}? You can copy it and shutdown to install manually.`}
        confirmText="Show Command"
        cancelText="Cancel"
        variant="primary"
      />

      {/* Disconnected / Updating Overlay */}
      {(isDisconnected || isUpdating) && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-6">
          {isUpdating ? (
            <ManualUpdatePanel
              latestVersion={updateInfo?.latestVersion}
              installCmd={INSTALL_CMD}
              copied={copied}
              onCopyAndShutdown={handleCopyAndShutdown}
              onCancel={handleCancelUpdate}
              countdown={shutdownCountdown}
              isDisconnected={isDisconnected}
            />
          ) : (
            <div className="text-center p-8">
              <div className="flex items-center justify-center size-16 rounded-full bg-red-500/20 text-red-500 mx-auto mb-4">
                <span className="material-symbols-outlined text-[32px]">power_off</span>
              </div>
              <h2 className="text-xl font-semibold text-white mb-2">Server Disconnected</h2>
              <p className="text-[#94a5b5] mb-6">The proxy server has been stopped.</p>
              <Button variant="secondary" onClick={() => globalThis.location.reload()}>
                Reload Page
              </Button>
            </div>
          )}
        </div>
      )}
    </>
  );
}

Sidebar.propTypes = {
  onClose: PropTypes.func,
};

function ManualUpdatePanel({ latestVersion, installCmd, copied, onCopyAndShutdown, onCancel, countdown, isDisconnected }) {
  const isCountingDown = countdown > 0;
  return (
    <div className="w-full max-w-lg rounded-xl bg-neutral-900/95 border border-white/10 p-6 text-white">
      <div className="flex items-center gap-3 mb-4">
        <div className="flex items-center justify-center size-11 rounded-full bg-amber-500/20 text-amber-400">
          <span className="material-symbols-outlined text-[24px]">content_copy</span>
        </div>
        <div>
          <h2 className="text-lg font-semibold">Update Spring Mouse{latestVersion ? ` to v${latestVersion}` : ""}</h2>
          <p className="text-xs text-white/60">
            {isDisconnected
              ? "Server stopped. Paste the command into a terminal to install."
              : isCountingDown
                ? `Command copied. Server will stop in ${countdown}s...`
                : "Click the button below to copy the install command and shutdown."}
          </p>
        </div>
      </div>

      <p className="text-sm text-white/80 mb-2">Install command:</p>
      <div className="w-full px-3 py-2 rounded bg-white/5 mb-4">
        <code className="text-xs font-mono text-amber-400 break-all">{installCmd}</code>
      </div>

      <ol className="text-xs text-white/70 space-y-1 list-decimal list-inside mb-4">
        <li>Click <strong>Copy & Shutdown</strong> below.</li>
        <li>Paste the command into your terminal and press Enter.</li>
        <li>Run <code className="px-1 rounded bg-white/10 text-emerald-400">spring-mouse</code> again after install.</li>
      </ol>

      {isDisconnected ? (
        <Button variant="secondary" fullWidth onClick={() => globalThis.location.reload()}>
          Reload Page
        </Button>
      ) : (
        <div className="flex gap-2">
          <Button variant="secondary" onClick={onCancel} disabled={isCountingDown}>
            Cancel
          </Button>
          <Button variant="primary" fullWidth onClick={onCopyAndShutdown} disabled={isCountingDown}>
            {copied ? "✓ Copied — shutting down..." : isCountingDown ? `Shutting down in ${countdown}s` : "Copy & Shutdown"}
          </Button>
        </div>
      )}
    </div>
  );
}

ManualUpdatePanel.propTypes = {
  latestVersion: PropTypes.string,
  installCmd: PropTypes.string.isRequired,
  copied: PropTypes.bool,
  onCopyAndShutdown: PropTypes.func.isRequired,
  onCancel: PropTypes.func.isRequired,
  countdown: PropTypes.number,
  isDisconnected: PropTypes.bool,
};
