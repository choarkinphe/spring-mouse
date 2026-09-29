"use client";

import { useState, useEffect, useRef, useMemo } from "react";
import Image from "next/image";
import { Badge, Card, Button, DashboardHero, Drawer, SegmentedControl, Select, Toggle, Input } from "@/shared/components";
import Modal from "@/shared/components/Modal";
import { APP_CONFIG } from "@/shared/constants/config";
import { DESTINATION_TYPES, DESTINATION_TYPE_ORDER } from "@/shared/constants/backupDestinations";
import TokenSaverClient from "../token-saver/TokenSaverClient";

// The destination picker, built from the SAME table the server validates with
// (src/shared/constants/backupDestinations.js) — so a type can never be offered
// here that the API would reject, and each type's fields are rendered from one
// source instead of being hand-written per scheme. That table has no node
// imports, which is why it can be shared with this client component.
const DESTINATION_TYPE_OPTIONS = DESTINATION_TYPE_ORDER.map((value) => ({
  value,
  label: DESTINATION_TYPES[value].label,
}));

// What a blank drawer looks like for a given type: every config field starts
// empty (booleans off) and every secret field empty.
function emptyDestinationDraft(type = "file") {
  const spec = DESTINATION_TYPES[type] ?? DESTINATION_TYPES.file;
  const config = {};
  for (const field of spec.configFields) config[field.key] = field.type === "boolean" ? false : "";
  const secret = {};
  for (const field of spec.secretFields) secret[field.key] = "";
  return { type, label: "", config, secret };
}

// The settings page is one long scroll. This is its table of contents: the rail
// on the left jumps to a zone and highlights whichever one is in view. The ids
// are load-bearing — /dashboard/token-saver redirects to #token-saver and the
// pxpipe page links to it too, so those three ids must not be renamed.
const SETTINGS_ZONES = [
  { id: "zone-access", index: "01", title: "访问与安全", icon: "shield" },
  { id: "zone-network", index: "02", title: "网络与可观测性", icon: "lan" },
  { id: "api-key-quota", index: "03", title: "API Key 配额", icon: "data_usage" },
  { id: "token-saver", index: "04", title: "Token 节省", icon: "savings" },
  { id: "zone-data", index: "05", title: "数据维护", icon: "inventory_2" },
];

function SettingsZone({ id, index, title, description, children }) {
  return (
    <section id={id} className="scroll-mt-6 flex flex-col gap-4">
      <div>
        <div className="flex items-center gap-2">
          <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-[#38bdf8]">{index}</span>
          <h2 className="text-base font-semibold text-text-main">{title}</h2>
        </div>
        <p className="mt-1 text-xs leading-5 text-text-muted">{description}</p>
      </div>
      {/* The zone owns the vertical rhythm between its cards. Previously each zone
          had to add its own gap, and the one that forgot (数据维护) rendered its
          two cards flush against each other. Stacking here makes that impossible. */}
      <div className="min-w-0 flex flex-col gap-4">{children}</div>
    </section>
  );
}

// Sticky section rail, mirroring the master-detail rail on the routing and media
// pages (combos/page.js, media-providers/page.js) so the shell behaves the same.
// Below lg it collapses into a horizontal, scrollable chip strip.
function SettingsNav({ activeId, onSelect }) {
  return (
    <aside aria-label="设置分区" className="min-w-0 lg:sticky lg:top-4">
      <p className="hidden px-2.5 pb-2 font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-text-muted lg:block">
        设置分区
      </p>
      <div className="custom-scrollbar flex gap-1.5 overflow-x-auto pb-1 lg:flex-col lg:overflow-visible lg:pb-0">
        {SETTINGS_ZONES.map((zone) => {
          const active = zone.id === activeId;
          return (
            <button
              key={zone.id}
              type="button"
              onClick={() => onSelect(zone.id)}
              aria-current={active ? "true" : undefined}
              className={`group flex shrink-0 items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition-colors lg:w-full ${active ? "bg-[#38bdf8]/10 text-[#7dd3fc]" : "text-text-muted hover:bg-surface-2 hover:text-text-main"}`}
            >
              <span className={`material-symbols-outlined text-[17px] leading-none ${active ? "text-[#38bdf8]" : "text-text-muted group-hover:text-text-main"}`}>{zone.icon}</span>
              <span className="min-w-0 flex-1 truncate font-medium">{zone.title}</span>
              <span className="hidden shrink-0 font-mono text-[10px] tabular-nums text-[#647688] lg:block">{zone.index}</span>
            </button>
          );
        })}
      </div>
    </aside>
  );
}

export default function ProfilePage() {
  const [settings, setSettings] = useState({});
  const [loading, setLoading] = useState(true);
  // Which zone the rail highlights. Purely presentational — no data depends on it.
  const [activeZone, setActiveZone] = useState(SETTINGS_ZONES[0].id);
  const [passwords, setPasswords] = useState({ current: "", new: "", confirm: "" });
  const [passStatus, setPassStatus] = useState({ type: "", message: "" });
  const [passLoading, setPassLoading] = useState(false);
  const [passwordDrawerOpen, setPasswordDrawerOpen] = useState(false);
  const [totpDialog, setTotpDialog] = useState({ open: false, mode: "setup", password: "", code: "", setup: null });
  const [totpStatus, setTotpStatus] = useState({ type: "", message: "" });
  const [totpLoading, setTotpLoading] = useState(false);
  const [ipAccessForm, setIpAccessForm] = useState({ enabled: false, mode: "allowlist", rules: "" });
  const [ipAccessStatus, setIpAccessStatus] = useState({ type: "", message: "" });
  const [ipAccessLoading, setIpAccessLoading] = useState(false);
  const [ipAccessDrawerOpen, setIpAccessDrawerOpen] = useState(false);
  const [dbLoading, setDbLoading] = useState(false);
  const [dbStatus, setDbStatus] = useState({ type: "", message: "" });
  const [dbAuth, setDbAuth] = useState({ open: false, mode: "", password: "" });
  const pendingImportRef = useRef(null);
  const importFileRef = useRef(null);
  // Anchor for locating the scroll container the zone rail listens on.
  const pageRef = useRef(null);
  const [proxyForm, setProxyForm] = useState({
    outboundProxyEnabled: false,
    outboundProxyUrl: "",
    outboundNoProxy: "",
  });
  const [proxyStatus, setProxyStatus] = useState({ type: "", message: "" });
  const [proxyLoading, setProxyLoading] = useState(false);
  const [proxyTestLoading, setProxyTestLoading] = useState(false);
  const [cloudflareTunnelForm, setCloudflareTunnelForm] = useState({ publicUrl: "" });
  const [cloudflareTunnelToken, setCloudflareTunnelToken] = useState("");
  const [cloudflareTunnelStatus, setCloudflareTunnelStatus] = useState(null);
  const [cloudflareTunnelMessage, setCloudflareTunnelMessage] = useState({ type: "", message: "" });
  const [cloudflareTunnelLoading, setCloudflareTunnelLoading] = useState(false);
  const [apiKeyQuotaForm, setApiKeyQuotaForm] = useState({ fiveHourTokenLimitM: "", weeklyTokenLimitM: "" });
  const [apiKeyQuotaStatus, setApiKeyQuotaStatus] = useState({ type: "", message: "" });
  const [apiKeyQuotaLoading, setApiKeyQuotaLoading] = useState(false);
  // Retention windows. Kept as strings so the field can be cleared while typing.
  const [retentionForm, setRetentionForm] = useState({ usage: "", requestDetails: "" });
  const [retentionStatus, setRetentionStatus] = useState({ type: "", message: "" });
  const [retentionLoading, setRetentionLoading] = useState(false);
  const [apiKeyRateLimitForm, setApiKeyRateLimitForm] = useState({ rpmLimit: "", rpmQueueMax: "", queueTimeoutSeconds: "" });
  const [apiKeyRateLimitStatus, setApiKeyRateLimitStatus] = useState({ type: "", message: "" });
  const [apiKeyRateLimitLoading, setApiKeyRateLimitLoading] = useState(false);
  // Off-host replication. The destination list lives on the server; the client
  // only ever receives a secret-free projection (`backupDestinations`, each entry
  // with a derived `displayUrl` and a `hasCredentials` flag). The drawer holds a
  // DRAFT — a full destination built from the shared type table — so switching
  // type rebuilds its fields from the same spec the API validates against.
  const [backupEnabled, setBackupEnabled] = useState(false);
  const [destinations, setDestinations] = useState([]);
  const [activeDestinationId, setActiveDestinationId] = useState(null);
  const [destinationDrawer, setDestinationDrawer] = useState({ open: false, editingId: null, draft: emptyDestinationDraft("file") });
  const [backupStatus, setBackupStatus] = useState(null);
  const [backupMessage, setBackupMessage] = useState({ type: "", message: "" });
  const [backupLoading, setBackupLoading] = useState(false);
  // Which half of the merged backup card is showing. "continuous" is the
  // litestream replica (default), "portable" is the JSON export/import that can
  // be carried to another server — the two mechanisms the card unifies.
  const [backupView, setBackupView] = useState("continuous");

  useEffect(() => {
    fetch("/api/settings")
      .then((res) => res.json())
      .then((data) => {
        setSettings(data);
        setBackupEnabled(data?.backupEnabled === true);
        setDestinations(Array.isArray(data?.backupDestinations) ? data.backupDestinations : []);
        setActiveDestinationId(data?.backupActiveDestinationId ?? null);
        setProxyForm({
          outboundProxyEnabled: data?.outboundProxyEnabled === true,
          outboundProxyUrl: data?.outboundProxyUrl || "",
          outboundNoProxy: data?.outboundNoProxy || "",
        });
        setCloudflareTunnelForm({ publicUrl: data?.cloudflareTunnelPublicUrl || "" });
        setApiKeyQuotaForm({
          fiveHourTokenLimitM: data?.apiKeyQuotaRules?.fiveHourTokenLimitM?.toString() || "",
          weeklyTokenLimitM: data?.apiKeyQuotaRules?.weeklyTokenLimitM?.toString() || "",
        });
        setRetentionForm({
          usage: data?.usageRetentionDays?.toString() ?? "",
          requestDetails: data?.requestDetailsRetentionDays?.toString() ?? "",
        });
        setApiKeyRateLimitForm({
          rpmLimit: data?.apiKeyRateLimitRules?.rpmLimit?.toString() || "",
          rpmQueueMax: data?.apiKeyRateLimitRules?.rpmQueueMax?.toString() ?? "",
          queueTimeoutSeconds: data?.apiKeyRateLimitRules?.queueTimeoutMs
            ? Math.round(data.apiKeyRateLimitRules.queueTimeoutMs / 1000).toString()
            : "",
        });
        const ipAccessMode = data?.ipAccessMode === "blocklist" ? "blocklist" : "allowlist";
        setIpAccessForm({
          enabled: data?.ipAccessEnabled === true,
          mode: ipAccessMode,
          rules: (ipAccessMode === "blocklist" ? (data?.ipBlocklist || []) : (data?.ipAllowlist || [])).join("\n"),
        });
        setLoading(false);
      })
      .catch((err) => {
        console.error("Failed to fetch settings:", err);
        setLoading(false);
      });
  }, []);

  // Highlight the zone currently in view. The scroll container is the dashboard
  // shell's overflow-y-auto <main> child (DashboardLayout.js), not window, so the
  // listener goes on the nearest scrollable ancestor of this page. A zone counts
  // as current once its top has passed the top of the viewport, so the last such
  // zone wins as you scroll down.
  useEffect(() => {
    const root = pageRef.current;
    if (!root) return;
    let container = root.parentElement;
    while (container && container !== document.body) {
      const overflowY = getComputedStyle(container).overflowY;
      if (overflowY === "auto" || overflowY === "scroll") break;
      container = container.parentElement;
    }
    const scroller = container && container !== document.body ? container : window;

    const onScroll = () => {
      const threshold = (scroller === window ? 0 : scroller.getBoundingClientRect().top) + 96;
      let current = SETTINGS_ZONES[0].id;
      for (const zone of SETTINGS_ZONES) {
        const el = document.getElementById(zone.id);
        if (el && el.getBoundingClientRect().top <= threshold) current = zone.id;
      }
      setActiveZone(current);
    };

    onScroll();
    scroller.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, []);

  const jumpToZone = (id) => {
    setActiveZone(id);
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  useEffect(() => {
    let cancelled = false;
    fetch("/api/tunnel/status", { cache: "no-store" })
      .then((res) => res.json().then((data) => ({ ok: res.ok, data })))
      .then(({ ok, data }) => {
        if (cancelled) return;
        if (ok) setCloudflareTunnelStatus(data);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Replication status. Polled rather than fetched once because the whole point
  // of showing it is to notice when the replicator has DIED — a single fetch on
  // page load would only ever show the state at that moment. GET is read-only
  // and cheap (no child process is spawned by it).
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetch("/api/settings/backup", { cache: "no-store" })
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
          if (!cancelled && data) setBackupStatus(data);
        })
        .catch(() => {});
    };
    load();
    const timer = setInterval(load, 15000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const updateOutboundProxy = async (e) => {
    e.preventDefault();
    if (settings.outboundProxyEnabled !== true) return;
    setProxyLoading(true);
    setProxyStatus({ type: "", message: "" });

    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          outboundProxyUrl: proxyForm.outboundProxyUrl,
          outboundNoProxy: proxyForm.outboundNoProxy,
        }),
      });

      const data = await res.json();
      if (res.ok) {
        setSettings((prev) => ({ ...prev, ...data }));
        setProxyStatus({ type: "success", message: "Proxy settings applied" });
      } else {
        setProxyStatus({ type: "error", message: data.error || "Failed to update proxy settings" });
      }
    } catch (err) {
      setProxyStatus({ type: "error", message: "An error occurred" });
    } finally {
      setProxyLoading(false);
    }
  };

  const testOutboundProxy = async () => {
    if (settings.outboundProxyEnabled !== true) return;

    const proxyUrl = (proxyForm.outboundProxyUrl || "").trim();
    if (!proxyUrl) {
      setProxyStatus({ type: "error", message: "Please enter a Proxy URL to test" });
      return;
    }

    setProxyTestLoading(true);
    setProxyStatus({ type: "", message: "" });

    try {
      const res = await fetch("/api/settings/proxy-test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ proxyUrl }),
      });

      const data = await res.json();
      if (res.ok && data?.ok) {
        setProxyStatus({
          type: "success",
          message: `Proxy test OK (${data.status}) in ${data.elapsedMs}ms`,
        });
      } else {
        setProxyStatus({
          type: "error",
          message: data?.error || "Proxy test failed",
        });
      }
    } catch (err) {
      setProxyStatus({ type: "error", message: "An error occurred" });
    } finally {
      setProxyTestLoading(false);
    }
  };

  const updateOutboundProxyEnabled = async (outboundProxyEnabled) => {
    setProxyLoading(true);
    setProxyStatus({ type: "", message: "" });

    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ outboundProxyEnabled }),
      });

      const data = await res.json();
      if (res.ok) {
        setSettings((prev) => ({ ...prev, ...data }));
        setProxyForm((prev) => ({ ...prev, outboundProxyEnabled: data?.outboundProxyEnabled === true }));
        setProxyStatus({
          type: "success",
          message: outboundProxyEnabled ? "Proxy enabled" : "Proxy disabled",
        });
      } else {
        setProxyStatus({ type: "error", message: data.error || "Failed to update proxy settings" });
      }
    } catch (err) {
      setProxyStatus({ type: "error", message: "An error occurred" });
    } finally {
      setProxyLoading(false);
    }
  };

  const fetchCloudflareTunnelStatus = async () => {
    try {
      const res = await fetch("/api/tunnel/status", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "无法读取 Cloudflare 通道状态");
      setCloudflareTunnelStatus(data);
      return data;
    } catch (error) {
      setCloudflareTunnelMessage({ type: "error", message: error.message || "无法读取 Cloudflare 通道状态" });
      return null;
    }
  };

  const buildCloudflareTunnelPatch = () => {
    const patch = {
      cloudflareTunnelPublicUrl: cloudflareTunnelForm.publicUrl.trim(),
    };
    if (cloudflareTunnelToken.trim()) patch.cloudflareTunnelToken = cloudflareTunnelToken.trim();
    return patch;
  };

  const saveCloudflareTunnelConfig = async () => {
    setCloudflareTunnelLoading(true);
    setCloudflareTunnelMessage({ type: "", message: "" });
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildCloudflareTunnelPatch()),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "保存 Cloudflare 配置失败");
      setSettings((prev) => ({ ...prev, ...data }));
      setCloudflareTunnelToken("");
      setCloudflareTunnelMessage({ type: "success", message: "Cloudflare 通道配置已保存" });
    } catch (error) {
      setCloudflareTunnelMessage({ type: "error", message: error.message || "保存 Cloudflare 配置失败" });
    } finally {
      setCloudflareTunnelLoading(false);
    }
  };

  const toggleCloudflareTunnel = async (enable) => {
    setCloudflareTunnelLoading(true);
    setCloudflareTunnelMessage({ type: "", message: "" });
    try {
      if (enable) {
        if (!cloudflareTunnelForm.publicUrl.trim()) {
          throw new Error("请填写 Cloudflare 公网访问地址");
        }
        if (!cloudflareTunnelToken.trim() && !settings.cloudflareTunnelConfigured) {
          throw new Error("请填写 Cloudflare Tunnel Token");
        }

        const saveRes = await fetch("/api/settings", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(buildCloudflareTunnelPatch()),
        });
        const saved = await saveRes.json();
        if (!saveRes.ok) throw new Error(saved.error || "保存 Cloudflare 配置失败");
        setSettings((prev) => ({ ...prev, ...saved }));

        const res = await fetch("/api/tunnel/enable", { method: "POST" });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "启动 Cloudflare 通道失败");
        setCloudflareTunnelStatus(data.tunnel);
        setSettings((prev) => ({ ...prev, ...(data.settings || {}) }));
        setCloudflareTunnelToken("");
        setCloudflareTunnelMessage({
          type: "success",
          message: data.tunnel?.connected
            ? `Cloudflare 通道已连接：${data.tunnel.publicUrl}`
            : "cloudflared 已启动，正在连接 Cloudflare Edge",
        });
      } else {
        const res = await fetch("/api/tunnel/disable", { method: "POST" });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "关闭 Cloudflare 通道失败");
        setCloudflareTunnelStatus(data.tunnel);
        setSettings((prev) => ({ ...prev, ...(data.settings || {}) }));
        setCloudflareTunnelMessage({ type: "success", message: "Cloudflare 通道已关闭" });
      }
    } catch (error) {
      setCloudflareTunnelMessage({ type: "error", message: error.message || "Cloudflare 通道操作失败" });
    } finally {
      setCloudflareTunnelLoading(false);
    }
  };

  const handlePasswordChange = async (e) => {
    e.preventDefault();
    if (passwords.new !== passwords.confirm) {
      setPassStatus({ type: "error", message: "Passwords do not match" });
      return;
    }

    setPassLoading(true);
    setPassStatus({ type: "", message: "" });

    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          currentPassword: passwords.current,
          newPassword: passwords.new,
        }),
      });

      const data = await res.json();

      if (res.ok) {
        setPassStatus({ type: "success", message: "Password updated successfully" });
        setSettings((prev) => ({ ...prev, hasPassword: true }));
        setPasswords({ current: "", new: "", confirm: "" });
        setPasswordDrawerOpen(false);
      } else {
        setPassStatus({ type: "error", message: data.error || "Failed to update password" });
      }
    } catch (err) {
      setPassStatus({ type: "error", message: "An error occurred" });
    } finally {
      setPassLoading(false);
    }
  };


  const openTotpDialog = (mode) => {
    setTotpStatus({ type: "", message: "" });
    setTotpDialog({ open: true, mode, password: "", code: "", setup: null });
  };

  const closeTotpDialog = () => {
    if (totpLoading) return;
    setTotpDialog({ open: false, mode: "setup", password: "", code: "", setup: null });
    setTotpStatus({ type: "", message: "" });
  };

  const startTotpSetup = async (event) => {
    event.preventDefault();
    setTotpLoading(true);
    setTotpStatus({ type: "", message: "" });
    try {
      const res = await fetch("/api/auth/totp/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: totpDialog.password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to start two-factor setup");
      setSettings((prev) => ({ ...prev, totpSetupPending: true }));
      setTotpDialog((prev) => ({ ...prev, code: "", setup: data }));
    } catch (error) {
      setTotpStatus({ type: "error", message: error.message || "An error occurred" });
    } finally {
      setTotpLoading(false);
    }
  };

  const enableTotp = async (event) => {
    event.preventDefault();
    setTotpLoading(true);
    setTotpStatus({ type: "", message: "" });
    try {
      const res = await fetch("/api/auth/totp/enable", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: totpDialog.code }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Invalid verification code");
      await reloadSettings();
      setTotpDialog({ open: false, mode: "setup", password: "", code: "", setup: null });
      setTotpStatus({ type: "success", message: "Microsoft Authenticator 二次认证已启用" });
    } catch (error) {
      setTotpStatus({ type: "error", message: error.message || "An error occurred" });
    } finally {
      setTotpLoading(false);
    }
  };

  const disableTotp = async (event) => {
    event.preventDefault();
    setTotpLoading(true);
    setTotpStatus({ type: "", message: "" });
    try {
      const res = await fetch("/api/auth/totp/disable", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: totpDialog.password, code: totpDialog.code }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to disable two-factor authentication");
      await reloadSettings();
      setTotpDialog({ open: false, mode: "setup", password: "", code: "", setup: null });
      setTotpStatus({ type: "success", message: "二次认证已关闭" });
    } catch (error) {
      setTotpStatus({ type: "error", message: error.message || "An error occurred" });
    } finally {
      setTotpLoading(false);
    }
  };

  const updateRequireLogin = async (requireLogin) => {
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requireLogin }),
      });
      if (res.ok) {
        setSettings(prev => ({ ...prev, requireLogin }));
      }
    } catch (err) {
      console.error("Failed to update require login:", err);
    }
  };

  const openIpAccessDrawer = () => {
    const mode = settings.ipAccessMode === "blocklist" ? "blocklist" : "allowlist";
    setIpAccessForm({
      enabled: settings.ipAccessEnabled === true,
      mode,
      rules: (mode === "blocklist" ? (settings.ipBlocklist || []) : (settings.ipAllowlist || [])).join("\n"),
    });
    setIpAccessStatus({ type: "", message: "" });
    setIpAccessDrawerOpen(true);
  };

  const closeIpAccessDrawer = () => {
    setIpAccessDrawerOpen(false);
    setIpAccessStatus({ type: "", message: "" });
  };

  const saveIpAccess = async (event) => {
    event.preventDefault();
    setIpAccessLoading(true);
    setIpAccessStatus({ type: "", message: "" });

    const rules = ipAccessForm.rules.split(/[\n,]/).map((rule) => rule.trim()).filter(Boolean);
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ipAccessEnabled: ipAccessForm.enabled,
          ipAccessMode: ipAccessForm.mode,
          ipAllowlist: ipAccessForm.mode === "allowlist" ? rules : [],
          ipBlocklist: ipAccessForm.mode === "blocklist" ? rules : [],
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to save IP access rules");
      setSettings((prev) => ({ ...prev, ...data }));
      setIpAccessForm({
        enabled: data.ipAccessEnabled === true,
        mode: data.ipAccessMode === "blocklist" ? "blocklist" : "allowlist",
        rules: (data.ipAccessMode === "blocklist" ? (data.ipBlocklist || []) : (data.ipAllowlist || [])).join("\n"),
      });
      setIpAccessDrawerOpen(false);
      setIpAccessStatus({ type: "success", message: "IP 访问规则已保存" });
    } catch (error) {
      setIpAccessStatus({ type: "error", message: error.message || "An error occurred" });
    } finally {
      setIpAccessLoading(false);
    }
  };

  const updateApiKeyQuotaRules = async (event) => {
    event.preventDefault();
    setApiKeyQuotaLoading(true);
    setApiKeyQuotaStatus({ type: "", message: "" });
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          apiKeyQuotaRules: {
            fiveHourTokenLimitM: apiKeyQuotaForm.fiveHourTokenLimitM || null,
            weeklyTokenLimitM: apiKeyQuotaForm.weeklyTokenLimitM || null,
          },
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to update API key quota rules");
      setSettings((prev) => ({ ...prev, ...data }));
      setApiKeyQuotaForm({
        fiveHourTokenLimitM: data.apiKeyQuotaRules?.fiveHourTokenLimitM?.toString() || "",
        weeklyTokenLimitM: data.apiKeyQuotaRules?.weeklyTokenLimitM?.toString() || "",
      });
      setApiKeyQuotaStatus({ type: "success", message: "API key quota rules updated" });
    } catch (err) {
      setApiKeyQuotaStatus({ type: "error", message: err.message || "An error occurred" });
    } finally {
      setApiKeyQuotaLoading(false);
    }
  };

  const updateRetention = async (event) => {
    event.preventDefault();
    setRetentionLoading(true);
    setRetentionStatus({ type: "", message: "" });
    // Empty means "use the default", not zero — zero is a meaningful value
    // (keep forever), so it must be sent explicitly.
    const parse = (value, fallback) => {
      const trimmed = String(value ?? "").trim();
      if (trimmed === "") return fallback;
      const n = Number.parseInt(trimmed, 10);
      return Number.isFinite(n) && n >= 0 ? n : fallback;
    };
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          usageRetentionDays: parse(retentionForm.usage, 90),
          requestDetailsRetentionDays: parse(retentionForm.requestDetails, 30),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to update retention");
      setSettings((prev) => ({ ...prev, ...data }));
      setRetentionForm({
        usage: data.usageRetentionDays?.toString() ?? "",
        requestDetails: data.requestDetailsRetentionDays?.toString() ?? "",
      });
      setRetentionStatus({ type: "success", message: "保留策略已更新" });
    } catch (err) {
      setRetentionStatus({ type: "error", message: err.message || "An error occurred" });
    } finally {
      setRetentionLoading(false);
    }
  };

  // The editor takes seconds because that is how people reason about a queue
  // wait; the API and the gate take milliseconds.
  const updateApiKeyRateLimitRules = async (event) => {
    event.preventDefault();
    setApiKeyRateLimitLoading(true);
    setApiKeyRateLimitStatus({ type: "", message: "" });
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          apiKeyRateLimitRules: {
            rpmLimit: apiKeyRateLimitForm.rpmLimit || null,
            rpmQueueMax: apiKeyRateLimitForm.rpmQueueMax === "" ? 0 : apiKeyRateLimitForm.rpmQueueMax,
            queueTimeoutMs: apiKeyRateLimitForm.queueTimeoutSeconds
              ? Number(apiKeyRateLimitForm.queueTimeoutSeconds) * 1000
              : null,
          },
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to update API key rate limit rules");
      setSettings((prev) => ({ ...prev, ...data }));
      setApiKeyRateLimitForm({
        rpmLimit: data.apiKeyRateLimitRules?.rpmLimit?.toString() || "",
        rpmQueueMax: data.apiKeyRateLimitRules?.rpmQueueMax?.toString() ?? "",
        queueTimeoutSeconds: data.apiKeyRateLimitRules?.queueTimeoutMs
          ? Math.round(data.apiKeyRateLimitRules.queueTimeoutMs / 1000).toString()
          : "",
      });
      setApiKeyRateLimitStatus({ type: "success", message: "API key rate limit rules updated" });
    } catch (err) {
      setApiKeyRateLimitStatus({ type: "error", message: err.message || "An error occurred" });
    } finally {
      setApiKeyRateLimitLoading(false);
    }
  };

  const updateRequestLogFileDumpsEnabled = async (enabled) => {
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enableRequestLogFileDumps: enabled }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "更新文件日志设置失败");
      setSettings((prev) => ({ ...prev, enableRequestLogFileDumps: enabled }));
    } catch (err) {
      console.error("Failed to update enableRequestLogFileDumps:", err);
    }
  };

  const updateObservabilityEnabled = async (enabled) => {
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enableObservability: enabled }),
      });
      if (res.ok) {
        setSettings(prev => ({ ...prev, enableObservability: enabled }));
      }
    } catch (err) {
      console.error("Failed to update enableObservability:", err);
    }
  };

  const reloadSettings = async () => {
    try {
      const res = await fetch("/api/settings");
      if (!res.ok) return;
      const data = await res.json();
      setSettings(data);
    } catch (err) {
      console.error("Failed to reload settings:", err);
    }
  };

  const handleExportDatabase = async (password) => {
    setDbLoading(true);
    setDbStatus({ type: "", message: "" });
    try {
      const res = await fetch("/api/settings/database", {
        headers: { "x-9r-password": password },
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to export database");
      }

      const payload = await res.json();
      const content = JSON.stringify(payload, null, 2);
      const blob = new Blob([content], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      const stamp = new Date().toISOString().replace(/[.:]/g, "-");
      anchor.href = url;
      anchor.download = `spring-mouse-backup-${stamp}.json`;
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      URL.revokeObjectURL(url);

      setDbStatus({ type: "success", message: "Database backup downloaded" });
    } catch (err) {
      setDbStatus({ type: "error", message: err.message || "Failed to export database" });
    } finally {
      setDbLoading(false);
    }
  };

  const handleImportDatabase = (event) => {
    const file = event.target.files?.[0];
    if (importFileRef.current) importFileRef.current.value = "";
    if (!file) return;
    pendingImportRef.current = file;
    setDbStatus({ type: "", message: "" });
    setDbAuth({ open: true, mode: "import", password: "" });
  };

  const runImportDatabase = async (password) => {
    const file = pendingImportRef.current;
    if (!file) return;
    setDbLoading(true);
    try {
      const raw = await file.text();
      const payload = JSON.parse(raw);

      const res = await fetch("/api/settings/database", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, password }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || "Failed to import database");
      }

      await reloadSettings();
      setDbStatus({ type: "success", message: "Database imported successfully" });
    } catch (err) {
      setDbStatus({ type: "error", message: err.message || "Invalid backup file" });
    } finally {
      pendingImportRef.current = null;
      setDbLoading(false);
    }
  };

  // Confirm password modal, then run export or import.
  const handleDbAuthConfirm = async () => {
    const { mode, password } = dbAuth;
    setDbAuth({ open: false, mode: "", password: "" });
    if (mode === "export") await handleExportDatabase(password);
    else if (mode === "import") await runImportDatabase(password);
    else if (mode === "restore") await runBackupRestore(password);
  };

  const refreshBackupStatus = async () => {
    try {
      const res = await fetch("/api/settings/backup", { cache: "no-store" });
      if (res.ok) setBackupStatus(await res.json());
    } catch { /* the poll will retry */ }
  };

  // The drawer works on a DRAFT. Adding posts a new destination; editing PATCHes
  // one by id, and blank secret fields mean "keep the stored credential" — the
  // server merges the stored blob, so an edit that only renames a destination
  // does not wipe its password.
  const saveDestination = async (event) => {
    event?.preventDefault?.();
    const { editingId, draft } = destinationDrawer;
    setBackupLoading(true);
    setBackupMessage({ type: "", message: "" });
    try {
      const url = editingId
        ? `/api/settings/backup/destinations/${editingId}`
        : "/api/settings/backup/destinations";
      const res = await fetch(url, {
        method: editingId ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: draft.type, label: draft.label, config: draft.config, secret: draft.secret }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "保存保存位置失败");
      setDestinations(Array.isArray(data.destinations) ? data.destinations : []);
      // The new destination becomes active only when it was the first one; pick
      // the active id back up so the list marks the right row.
      const refreshed = await fetch("/api/settings").then((r) => r.json()).catch(() => null);
      if (refreshed?.backupActiveDestinationId !== undefined) setActiveDestinationId(refreshed.backupActiveDestinationId);
      setDestinationDrawer({ open: false, editingId: null, draft: emptyDestinationDraft("file") });
      await refreshBackupStatus();
      setBackupMessage({ type: "success", message: editingId ? "保存位置已更新" : "保存位置已添加" });
    } catch (error) {
      setBackupMessage({ type: "error", message: error.message || "保存保存位置失败" });
    } finally {
      setBackupLoading(false);
    }
  };

  const openAddDestination = () => {
    setBackupMessage({ type: "", message: "" });
    setDestinationDrawer({ open: true, editingId: null, draft: emptyDestinationDraft("file") });
  };

  const openEditDestination = (destination) => {
    setBackupMessage({ type: "", message: "" });
    const spec = DESTINATION_TYPES[destination.type] ?? DESTINATION_TYPES.file;
    const config = {};
    for (const field of spec.configFields) {
      const value = destination.config?.[field.key];
      config[field.key] = field.type === "boolean" ? value === true : (value ?? "");
    }
    const secret = {};
    for (const field of spec.secretFields) secret[field.key] = "";
    setDestinationDrawer({
      open: true,
      editingId: destination.id,
      draft: { type: destination.type, label: destination.label || "", config, secret },
    });
  };

  const activateDestination = async (id) => {
    setBackupLoading(true);
    setBackupMessage({ type: "", message: "" });
    try {
      const res = await fetch(`/api/settings/backup/destinations/${id}/activate`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "切换保存位置失败");
      setDestinations(Array.isArray(data.destinations) ? data.destinations : []);
      setActiveDestinationId(id);
      await refreshBackupStatus();
      setBackupMessage({ type: "success", message: "已切换到该保存位置" });
    } catch (error) {
      setBackupMessage({ type: "error", message: error.message || "切换保存位置失败" });
    } finally {
      setBackupLoading(false);
    }
  };

  const removeDestination = async (destination) => {
    if (!window.confirm(`删除保存位置「${destination.label}」？正在使用它的复制会停止。`)) return;
    setBackupLoading(true);
    setBackupMessage({ type: "", message: "" });
    try {
      const res = await fetch(`/api/settings/backup/destinations/${destination.id}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "删除保存位置失败");
      setDestinations(Array.isArray(data.destinations) ? data.destinations : []);
      const refreshed = await fetch("/api/settings").then((r) => r.json()).catch(() => null);
      if (refreshed?.backupActiveDestinationId !== undefined) setActiveDestinationId(refreshed.backupActiveDestinationId);
      if (refreshed?.backupEnabled !== undefined) setBackupEnabled(refreshed.backupEnabled === true);
      await refreshBackupStatus();
      setBackupMessage({ type: "success", message: "保存位置已删除" });
    } catch (error) {
      setBackupMessage({ type: "error", message: error.message || "删除保存位置失败" });
    } finally {
      setBackupLoading(false);
    }
  };

  const toggleBackupEnabled = async (enabled) => {
    setBackupEnabled(enabled);
    setBackupLoading(true);
    setBackupMessage({ type: "", message: "" });
    try {
      // The dedicated endpoint starts the engine BEFORE persisting, so a failed
      // enable leaves the row untouched instead of enabled-but-broken.
      const res = await fetch("/api/settings/backup", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "切换备份状态失败");
      // Enabling with no saved destination seeds a local one, so the list can
      // gain a row here; re-read it rather than assuming.
      const refreshed = await fetch("/api/settings").then((r) => r.json()).catch(() => null);
      if (refreshed?.backupDestinations) setDestinations(refreshed.backupDestinations);
      if (refreshed?.backupActiveDestinationId !== undefined) setActiveDestinationId(refreshed.backupActiveDestinationId);
      await refreshBackupStatus();
      setBackupMessage({ type: "success", message: enabled ? "持续备份已开启" : "持续备份已关闭" });
    } catch (error) {
      setBackupEnabled(!enabled);
      setBackupMessage({ type: "error", message: error.message || "切换备份状态失败" });
    } finally {
      setBackupLoading(false);
    }
  };

  // Restore is destructive and irreversible from the UI, so it goes through the
  // same password-confirmation modal as import. The request answers with
  // `restarting: true`; the server then exits and entrypoint.sh swaps the
  // database in before any process opens it.
  const runBackupRestore = async (password) => {
    setBackupLoading(true);
    setBackupMessage({ type: "", message: "" });
    try {
      const res = await fetch("/api/settings/backup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "restore", password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "恢复失败");
      setBackupMessage({
        type: "success",
        message: data.restarting
          ? `已从远端恢复 ${data.bytes ? `${(data.bytes / 1024 / 1024).toFixed(0)} MB` : "数据"}，服务正在重启以应用…`
          : "恢复已完成",
      });
    } catch (error) {
      setBackupMessage({ type: "error", message: error.message || "恢复失败" });
    } finally {
      setBackupLoading(false);
    }
  };

  const handleRestoreClick = () => {
    if (!backupStatus?.running) {
      setBackupMessage({ type: "error", message: "复制进程未运行，无法从远端恢复" });
      return;
    }
    setDbAuth({ open: true, mode: "restore", password: "" });
  };

  // Only rendered inside the confirm modal, so the wording matches the action.
  const dbAuthVerb = dbAuth.mode === "export" ? "export" : dbAuth.mode === "restore" ? "restore" : "import";
  // The badge reflects the STORED state: a configured destination plus the
  // enable switch. "复制中" additionally requires the child process to be alive.
  const backupState = destinations.length === 0
    ? { label: "未配置", variant: "default" }
    : backupStatus?.running
      ? { label: "复制中", variant: "success" }
      : backupEnabled
        ? { label: "已启用，未运行", variant: "warning" }
        : { label: "已配置，未启用", variant: "default" };
  // The drawer's field spec for the currently selected type — config fields,
  // secret fields and the hint all come from the shared table.
  const draftSpec = DESTINATION_TYPES[destinationDrawer.draft.type] ?? DESTINATION_TYPES.file;
  // A blank secret on an EDIT means "keep the stored credential", so the field
  // can be left alone. On ADD it is required (unless a key path covers SSH auth).
  const draftEditing = Boolean(destinationDrawer.editingId);
  const draftMissingRequired = useMemo(() => {
    const { draft } = destinationDrawer;
    for (const field of draftSpec.configFields) {
      if (field.required && !String(draft.config[field.key] ?? "").trim()) return true;
    }
    if (draftEditing) return false;
    if (draft.type === "sftp") {
      return !String(draft.secret.password ?? "").trim() && !String(draft.config.keyPath ?? "").trim();
    }
    return draftSpec.secretFields.some((field) => field.required && !String(draft.secret[field.key] ?? "").trim());
  }, [destinationDrawer, draftSpec, draftEditing]);

  const observabilityEnabled = settings.enableObservability === true;
  const requestLogFileDumpsEnabled = settings.enableRequestLogFileDumps === true;

  return (
    <div ref={pageRef} className="mx-auto w-full max-w-6xl px-4 pb-8 pt-1 sm:px-0 sm:pt-2">
      <DashboardHero
        eyebrow="System preferences"
        title="设置"
        description="配置控制台访问、安全入口、服务代理与本地数据维护。"
        icon="settings"
      >
        <Badge variant={settings.requireLogin ? "success" : "warning"} size="md" icon="shield">{settings.requireLogin ? "登录保护已开启" : "登录保护未开启"}</Badge>
        <Badge variant={settings.totpEnabled ? "success" : "default"} size="md" icon="verified_user">{settings.totpEnabled ? "二次认证已开启" : "二次认证未开启"}</Badge>
        <Badge
          variant={cloudflareTunnelStatus?.connected ? "success" : cloudflareTunnelStatus?.running ? "warning" : "default"}
          size="md"
          icon="public"
        >
          {cloudflareTunnelStatus?.connected ? "外部通道已连接" : cloudflareTunnelStatus?.running ? "外部通道连接中" : "外部通道未运行"}
        </Badge>
        <Badge variant={proxyForm.outboundProxyEnabled ? "info" : "default"} size="md" icon="lan">{proxyForm.outboundProxyEnabled ? "出站代理已启用" : "直连模式"}</Badge>
      </DashboardHero>

      <div className="mt-7 grid items-start gap-6 lg:grid-cols-[14rem_minmax(0,1fr)]">
        <SettingsNav activeId={activeZone} onSelect={jumpToZone} />
        <div className="flex min-w-0 flex-col gap-7">
        <SettingsZone
          id="zone-access"
          index="01"
          title="访问与安全"
          description="控制 Dashboard 的登录保护，并配置外部安全访问入口。"
        >
          <div className="grid gap-4 xl:grid-cols-3">
            <Card className="flex flex-col">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-primary/10 text-primary shrink-0">
                  <span className="material-symbols-outlined text-[20px]">shield</span>
                </div>
                <div className="min-w-0 flex-1">
                  <h3 className="text-base sm:text-lg font-semibold">后台登录</h3>
                  <p className="mt-0.5 text-xs sm:text-sm text-text-muted">密码是 Dashboard 的第一道验证。</p>
                </div>
                <Toggle checked={settings.requireLogin === true} onChange={() => updateRequireLogin(!settings.requireLogin)} disabled={loading} />
              </div>
              <div className="mt-4 flex flex-1 flex-col justify-between gap-4 border-t border-border/50 pt-4">
                <div className="flex flex-wrap gap-2">
                  <Badge variant={settings.requireLogin ? "success" : "warning"} size="sm">{settings.requireLogin ? "登录保护已开启" : "登录保护未开启"}</Badge>
                  <Badge variant={settings.hasPassword ? "default" : "warning"} size="sm">{settings.hasPassword ? "密码已设置" : "待设置密码"}</Badge>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <p className="text-xs text-text-muted">修改密码需要当前凭据确认。</p>
                  <Button type="button" variant="secondary" onClick={() => { setPassStatus({ type: "", message: "" }); setPasswordDrawerOpen(true); }} disabled={loading} className="shrink-0">
                    {settings.hasPassword ? "更新密码" : "设置密码"}
                  </Button>
                </div>
              </div>
              {passStatus.message && <p className={`mt-3 text-xs sm:text-sm ${passStatus.type === "error" ? "text-red-500" : "text-green-500"}`}>{passStatus.message}</p>}
            </Card>

            <Card className="flex flex-col">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-emerald-500/10 text-emerald-500 shrink-0">
                  <span className="material-symbols-outlined text-[20px]">verified_user</span>
                </div>
                <div className="min-w-0 flex-1">
                  <h3 className="text-base sm:text-lg font-semibold">二次认证</h3>
                  <p className="mt-0.5 text-xs sm:text-sm text-text-muted">Microsoft Authenticator 动态验证码。</p>
                </div>
              </div>
              <div className="mt-4 flex flex-1 flex-col justify-between gap-4 border-t border-border/50 pt-4">
                <div className="flex flex-wrap gap-2">
                  <Badge variant={settings.totpEnabled ? "success" : "default"} size="sm">{settings.totpEnabled ? "已启用" : "未启用"}</Badge>
                  {settings.totpEnabled && <Badge variant="default" size="sm">剩余 {settings.totpRecoveryCodeCount || 0} 个恢复码</Badge>}
                </div>
                <div className="flex items-center justify-between gap-3">
                  <p className="text-xs text-text-muted">密码成功后还需验证 6 位动态码。</p>
                  <Button type="button" variant={settings.totpEnabled ? "secondary" : "primary"} onClick={() => openTotpDialog(settings.totpEnabled ? "disable" : "setup")} disabled={loading} className="shrink-0">
                    {settings.totpEnabled ? "管理" : "启用"}
                  </Button>
                </div>
              </div>
              {totpStatus.message && <p className={`mt-3 text-xs sm:text-sm ${totpStatus.type === "error" ? "text-red-500" : "text-green-500"}`}>{totpStatus.message}</p>}
            </Card>

            <Card className="flex flex-col">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-rose-500/10 text-rose-500 shrink-0">
                  <span className="material-symbols-outlined text-[20px]">filter_alt</span>
                </div>
                <div className="min-w-0 flex-1">
                  <h3 className="text-base sm:text-lg font-semibold">IP 访问控制</h3>
                  <p className="mt-0.5 text-xs sm:text-sm text-text-muted">
                    {settings.ipAccessEnabled === true
                      ? (settings.ipAccessMode === "blocklist" ? "黑名单模式：封禁指定来源" : "白名单模式：只允许指定来源")
                      : "未启用；后台仅按登录策略校验。"}
                  </p>
                </div>
              </div>
              <div className="mt-4 flex flex-1 flex-col justify-between gap-4 border-t border-border/50 pt-4">
                <div className="flex flex-wrap gap-2">
                  <Badge variant={settings.ipAccessEnabled === true ? "success" : "default"} size="sm">{settings.ipAccessEnabled === true ? "已启用" : "未启用"}</Badge>
                  <Badge variant="default" size="sm">{settings.ipAccessMode === "blocklist" ? "黑名单" : "白名单"} · {(settings.ipAccessMode === "blocklist" ? (settings.ipBlocklist || []) : (settings.ipAllowlist || [])).length} 条规则</Badge>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <p className="text-xs text-text-muted">仅保护后台登录与管理接口。</p>
                  <Button type="button" variant="secondary" onClick={openIpAccessDrawer} disabled={loading} className="shrink-0">管理规则</Button>
                </div>
              </div>
              {ipAccessStatus.message && <p className={`mt-3 text-xs sm:text-sm ${ipAccessStatus.type === "error" ? "text-red-500" : "text-green-500"}`}>{ipAccessStatus.message}</p>}
            </Card>
          </div>
        </SettingsZone>

        <SettingsZone
          id="zone-network"
          index="02"
          title="网络与可观测性"
          description="管理上游网络代理，并控制用量与诊断数据采集。"
        >
          <div className="grid gap-4 2xl:grid-cols-[minmax(0,1.25fr)_minmax(0,0.75fr)]">
        {/* Network */}
        <Card>
          <div className="flex items-center gap-3 mb-4">
            <div className="p-2 rounded-lg bg-purple-500/10 text-purple-500 shrink-0">
              <span className="material-symbols-outlined text-[20px]">wifi</span>
            </div>
            <h3 className="text-base sm:text-lg font-semibold">Network</h3>
          </div>

          <div className="flex flex-col gap-4">
            <div className="flex items-start sm:items-center justify-between gap-4">
              <div className="flex-1 min-w-0">
                <p className="font-medium text-sm sm:text-base">Outbound Proxy</p>
                <p className="text-xs sm:text-sm text-text-muted">Enable proxy for OAuth + provider outbound requests.</p>
              </div>
              <Toggle
                checked={settings.outboundProxyEnabled === true}
                onChange={() => updateOutboundProxyEnabled(!(settings.outboundProxyEnabled === true))}
                disabled={loading || proxyLoading}
              />
            </div>

            {settings.outboundProxyEnabled === true && (
              <form onSubmit={updateOutboundProxy} className="flex flex-col gap-4 pt-2 border-t border-border/50">
                <div className="flex flex-col gap-2">
                  <label className="font-medium text-sm sm:text-base">Proxy URL</label>
                  <Input
                    placeholder="http://127.0.0.1:7897"
                    value={proxyForm.outboundProxyUrl}
                    onChange={(e) => setProxyForm((prev) => ({ ...prev, outboundProxyUrl: e.target.value }))}
                    disabled={loading || proxyLoading}
                  />
                  <p className="text-xs sm:text-sm text-text-muted">Leave empty to inherit existing env proxy (if any).</p>
                </div>

                <div className="flex flex-col gap-2 pt-2 border-t border-border/50">
                  <label className="font-medium text-sm sm:text-base">No Proxy</label>
                  <Input
                    placeholder="localhost,127.0.0.1"
                    value={proxyForm.outboundNoProxy}
                    onChange={(e) => setProxyForm((prev) => ({ ...prev, outboundNoProxy: e.target.value }))}
                    disabled={loading || proxyLoading}
                  />
                  <p className="text-xs sm:text-sm text-text-muted">Comma-separated hostnames/domains to bypass the proxy.</p>
                </div>

                <div className="pt-2 border-t border-border/50 flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
                  <Button
                    type="button"
                    variant="secondary"
                    loading={proxyTestLoading}
                    disabled={loading || proxyLoading}
                    onClick={testOutboundProxy}
                    className="w-full sm:w-auto"
                  >
                    Test proxy URL
                  </Button>
                  <Button type="submit" variant="primary" loading={proxyLoading} className="w-full sm:w-auto">
                    Apply
                  </Button>
                </div>
              </form>
            )}

            {proxyStatus.message && (
              <p className={`text-xs sm:text-sm ${proxyStatus.type === "error" ? "text-red-500" : "text-green-500"} pt-2 border-t border-border/50`}>
                {proxyStatus.message}
              </p>
            )}
          </div>
        </Card>


        {/* Observability Settings */}
        <Card>
          <div className="flex items-center gap-3 mb-4">
            <div className="p-2 rounded-lg bg-orange-500/10 text-orange-500 shrink-0">
              <span className="material-symbols-outlined text-[20px]">monitoring</span>
            </div>
            <h3 className="text-base sm:text-lg font-semibold">可观测性</h3>
          </div>
          <div className="flex flex-col gap-4">
            <div className="flex items-start sm:items-center justify-between gap-4">
              <div className="flex-1 min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-medium text-sm sm:text-base">请求诊断明细</p>
                  <span className="rounded bg-sky-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-sky-500">数据库</span>
                </div>
                <p className="text-xs sm:text-sm text-text-muted">
                  保存每次请求的诊断快照，用于请求明细查询和故障排查；关闭后不影响请求量、Token、费用等汇总统计。
                </p>
              </div>
              <Toggle
                checked={observabilityEnabled}
                onChange={updateObservabilityEnabled}
                disabled={loading}
              />
            </div>
            <div className="border-t border-border/50 pt-4">
              <div className="flex items-start sm:items-center justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-medium text-sm sm:text-base">完整请求/响应文件</p>
                    <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-amber-500">写入数据目录</span>
                  </div>
                  <p className="text-xs sm:text-sm text-text-muted">
                    保存完整请求和响应副本供深度排障，可能包含敏感内容并快速占用磁盘，仅建议临时开启。
                  </p>
                </div>
                <Toggle
                  checked={requestLogFileDumpsEnabled}
                  onChange={updateRequestLogFileDumpsEnabled}
                  disabled={loading}
                />
              </div>
            </div>

            <div className="border-t border-border/50 pt-4">
              <div className="mb-3">
                <p className="font-medium text-sm sm:text-base">数据保留</p>
                <p className="text-xs sm:text-sm text-text-muted">
                  超过保留天数的记录会被定期清理。填 0 表示永久保留。请求明细还受上方「请求诊断明细」的条数上限约束，两者谁先触发就按谁清理。
                </p>
              </div>
              <form onSubmit={updateRetention} className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] lg:items-end">
                <Input
                  label="用量记录保留天数"
                  type="number"
                  min="0"
                  step="1"
                  placeholder="90"
                  value={retentionForm.usage}
                  onChange={(event) => setRetentionForm((prev) => ({ ...prev, usage: event.target.value }))}
                  disabled={loading || retentionLoading}
                />
                <Input
                  label="请求明细保留天数"
                  type="number"
                  min="0"
                  step="1"
                  placeholder="30"
                  value={retentionForm.requestDetails}
                  onChange={(event) => setRetentionForm((prev) => ({ ...prev, requestDetails: event.target.value }))}
                  disabled={loading || retentionLoading}
                />
                <Button type="submit" disabled={loading || retentionLoading} loading={retentionLoading}>
                  保存
                </Button>
              </form>
              {retentionStatus.message && (
                <p className={`mt-2 text-xs ${retentionStatus.type === "error" ? "text-red-500" : "text-green-500"}`}>
                  {retentionStatus.message}
                </p>
              )}
            </div>
          </div>
        </Card>

        {/* Cloudflare external access tunnel */}
        <Card className="2xl:col-span-2">
          <div className="flex items-center gap-3 mb-4">
            <div className="p-2 rounded-lg bg-orange-500/10 text-orange-500 shrink-0">
              <span className="material-symbols-outlined text-[20px]">public</span>
            </div>
            <div className="min-w-0">
              <h3 className="text-base sm:text-lg font-semibold">Cloudflare 外部加速通道</h3>
              <p className="text-xs sm:text-sm text-text-muted mt-0.5">通过 Cloudflare Tunnel 安全地从外部访问 Spring Mouse。</p>
            </div>
          </div>

          <div className="flex flex-col gap-4">
            <div className="flex items-start sm:items-center justify-between gap-4">
              <div className="flex-1 min-w-0">
                <p className="font-medium text-sm sm:text-base">启用外部访问</p>
                <p className="text-xs sm:text-sm text-text-muted">仅限已登录的 Dashboard 管理员启停通道。</p>
              </div>
              <Toggle
                checked={cloudflareTunnelStatus?.running === true}
                onChange={() => toggleCloudflareTunnel(!(cloudflareTunnelStatus?.running === true))}
                disabled={loading || cloudflareTunnelLoading}
              />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2 border-t border-border/50">
              <div className="flex flex-col gap-2">
                <label className="font-medium text-sm sm:text-base">Cloudflare Tunnel Token</label>
                <Input
                  type="password"
                  placeholder={settings.cloudflareTunnelConfigured ? "已保存；留空可保持不变" : "eyJh..."}
                  value={cloudflareTunnelToken}
                  onChange={(e) => setCloudflareTunnelToken(e.target.value)}
                  disabled={loading || cloudflareTunnelLoading}
                />
                <p className="text-xs text-text-muted">Token 仅保存在本机设置中，不会回传到浏览器。</p>
              </div>

              <div className="flex flex-col gap-2">
                <label className="font-medium text-sm sm:text-base">Cloudflare 公网访问地址</label>
                <Input
                  placeholder="https://api.example.com"
                  value={cloudflareTunnelForm.publicUrl}
                  onChange={(e) => setCloudflareTunnelForm((prev) => ({ ...prev, publicUrl: e.target.value }))}
                  disabled={loading || cloudflareTunnelLoading}
                />
                <p className="text-xs text-text-muted">填写 Cloudflare Tunnel 绑定的域名；启用成功后会在「端点与密钥」中展示。</p>
              </div>
            </div>

            {cloudflareTunnelStatus?.connected && cloudflareTunnelStatus?.publicUrl && (
              <div className="rounded-lg border border-primary/25 bg-primary/5 px-3 py-2 text-sm break-all">
                <span className="text-text-muted">外部 API 地址：</span>
                <code className="text-primary">{cloudflareTunnelStatus.publicUrl}/v1</code>
              </div>
            )}

            <div className="flex flex-col sm:flex-row gap-2 pt-2 border-t border-border/50">
              <Button type="button" variant="secondary" onClick={fetchCloudflareTunnelStatus} disabled={loading || cloudflareTunnelLoading} className="w-full sm:w-auto">
                刷新状态
              </Button>
              <Button type="button" variant="secondary" onClick={saveCloudflareTunnelConfig} loading={cloudflareTunnelLoading} disabled={loading} className="w-full sm:w-auto">
                保存配置
              </Button>
            </div>

            {cloudflareTunnelMessage.message && (
              <p className={`text-xs sm:text-sm ${cloudflareTunnelMessage.type === "error" ? "text-red-500" : "text-green-500"} pt-2 border-t border-border/50`}>
                {cloudflareTunnelMessage.message}
              </p>
            )}
          </div>
        </Card>


          </div>
        </SettingsZone>

        <SettingsZone
          id="api-key-quota"
          index="03"
          title="API Key 配额"
          description="配置所有密钥共用的 5 小时与周 Token 额度；每把密钥在集成与凭据页选择是否限额。"
        >
          <Card>
            <div className="flex items-center gap-3 mb-4">
              <div className="p-2 rounded-lg bg-sky-500/10 text-sky-500 shrink-0">
                <span className="material-symbols-outlined text-[20px]">data_usage</span>
              </div>
              <div>
                <h3 className="text-base sm:text-lg font-semibold">统一配额规则</h3>
                <p className="text-xs sm:text-sm text-text-muted">按成功请求的总 Token 数（输入 + 输出）统计，滚动窗口自动重置。</p>
              </div>
            </div>
            <form onSubmit={updateApiKeyQuotaRules} className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] lg:items-end">
              <Input
                label="5 小时 Token 限额 (M)"
                type="number"
                min="0"
                step="0.1"
                placeholder="不限制"
                value={apiKeyQuotaForm.fiveHourTokenLimitM}
                onChange={(event) => setApiKeyQuotaForm((prev) => ({ ...prev, fiveHourTokenLimitM: event.target.value }))}
                disabled={loading || apiKeyQuotaLoading}
              />
              <Input
                label="周 Token 限额 (M)"
                type="number"
                min="0"
                step="0.1"
                placeholder="不限制"
                value={apiKeyQuotaForm.weeklyTokenLimitM}
                onChange={(event) => setApiKeyQuotaForm((prev) => ({ ...prev, weeklyTokenLimitM: event.target.value }))}
                disabled={loading || apiKeyQuotaLoading}
              />
              <Button type="submit" size="field" loading={apiKeyQuotaLoading} disabled={loading}>
                Save
              </Button>
            </form>
            {apiKeyQuotaStatus.message && (
              <p className={`mt-4 border-t border-border/50 pt-4 text-xs sm:text-sm ${apiKeyQuotaStatus.type === "error" ? "text-red-500" : "text-green-500"}`}>
                {apiKeyQuotaStatus.message}
              </p>
            )}
          </Card>

          <div>
            <Card>
              <div className="flex items-center gap-3 mb-4">
                <div className="p-2 rounded-lg bg-amber-500/10 text-amber-500 shrink-0">
                  <span className="material-symbols-outlined text-[20px]">speed</span>
                </div>
                <div>
                  <h3 className="text-base sm:text-lg font-semibold">每分钟请求限流</h3>
                  <p className="text-xs sm:text-sm text-text-muted">
                    按滚动 60 秒窗口统计请求数：前 x 个请求直接放行，其后的请求进入队列等待窗口腾出位置；队列超过 y 个、或等待超过设定秒数即返回 429。留空表示不限制，单把密钥可在集成与凭据页单独覆盖。
                  </p>
                </div>
              </div>
              <form onSubmit={updateApiKeyRateLimitRules} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto] lg:items-end">
                <Input
                  label="每分钟请求数上限 (x)"
                  type="number"
                  min="1"
                  placeholder="不限制"
                  value={apiKeyRateLimitForm.rpmLimit}
                  onChange={(event) => setApiKeyRateLimitForm((prev) => ({ ...prev, rpmLimit: event.target.value }))}
                  disabled={loading || apiKeyRateLimitLoading}
                />
                <Input
                  label="等待队列长度 (y)"
                  type="number"
                  min="0"
                  placeholder="0"
                  value={apiKeyRateLimitForm.rpmQueueMax}
                  onChange={(event) => setApiKeyRateLimitForm((prev) => ({ ...prev, rpmQueueMax: event.target.value }))}
                  disabled={loading || apiKeyRateLimitLoading}
                />
                <Input
                  label="队列最大等待 (秒)"
                  type="number"
                  min="1"
                  placeholder="60"
                  value={apiKeyRateLimitForm.queueTimeoutSeconds}
                  onChange={(event) => setApiKeyRateLimitForm((prev) => ({ ...prev, queueTimeoutSeconds: event.target.value }))}
                  disabled={loading || apiKeyRateLimitLoading}
                />
                <Button type="submit" size="field" loading={apiKeyRateLimitLoading} disabled={loading}>
                  Save
                </Button>
              </form>
              {apiKeyRateLimitStatus.message && (
                <p className={`mt-4 border-t border-border/50 pt-4 text-xs sm:text-sm ${apiKeyRateLimitStatus.type === "error" ? "text-red-500" : "text-green-500"}`}>
                  {apiKeyRateLimitStatus.message}
                </p>
              )}
            </Card>
          </div>
        </SettingsZone>

        <SettingsZone
          id="token-saver"
          index="05"
          title="Token 节省"
          description="配置工具输出、上下文与模型输出的压缩策略，降低调用成本。"
        >
          <TokenSaverClient embedded />
        </SettingsZone>

        <SettingsZone
          id="zone-data"
          index="06"
          title="数据维护"
          description="持续备份数据库以防主机损坏，或导出 JSON 快照在设备与服务器之间迁移。"
        >
        {/* ONE card, two mechanisms. Continuous replication streams the whole
            SQLite file (crash-safe, needs a restart to restore, not portable);
            the JSON export is a point-in-time snapshot that can be carried to
            another server or version. They were two cards, which made them look
            like alternatives — they are two tools for the same job. */}
        <Card>
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
            <div className="flex items-center gap-3 sm:gap-4">
              <div className="size-10 sm:size-12 rounded-lg bg-[#38bdf8]/10 text-[#38bdf8] flex items-center justify-center shrink-0">
                <span className="material-symbols-outlined text-xl sm:text-2xl">cloud_sync</span>
              </div>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-lg sm:text-xl font-semibold">备份与恢复</h2>
                  <Badge variant={backupState.variant} size="sm">{backupState.label}</Badge>
                </div>
                <p className="text-sm text-text-muted mt-0.5">把数据库持续备份到本地或远端，也可导出快照迁移到其他服务器。</p>
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <span className="text-sm text-text-muted">启用</span>
              <Toggle
                checked={backupEnabled === true}
                onChange={() => toggleBackupEnabled(!(backupEnabled === true))}
                disabled={loading || backupLoading}
              />
            </div>
          </div>

          {/* Indented to the card title's TEXT column, not the card's content
              edge: the header puts a 40/48px icon before the title, so the title
              text starts at icon + gap (52px on mobile, 64px from sm up). The
              switch matches the title instead of the icon, which is what the
              operator expects under a heading. */}
          <div className="mt-4 pl-[52px] sm:pl-16">
            <SegmentedControl
              value={backupView}
              onChange={setBackupView}
              options={[
                { value: "continuous", label: "持续备份", icon: "sync" },
                { value: "portable", label: "便携导出", icon: "file_download" },
              ]}
            />
          </div>

          {backupView === "continuous" && (
            <div className="flex flex-col gap-4 pt-4 mt-4 border-t border-border">
              <div className="flex flex-col gap-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-medium text-sm sm:text-base">保存位置</p>
                    <p className="mt-0.5 text-xs text-text-muted">
                      可保存多个，但 litestream 同一数据库只允许一个副本，所以同一时间只有一个是「启用中」。
                    </p>
                  </div>
                  <Button type="button" variant="secondary" icon="add" onClick={openAddDestination} disabled={loading || backupLoading} className="shrink-0">
                    添加保存位置
                  </Button>
                </div>

                {destinations.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-border-subtle bg-surface-2 px-4 py-6 text-center">
                    <p className="text-sm text-text-muted">还没有保存位置。添加一个即可开始持续备份。</p>
                  </div>
                ) : (
                  <ul className="flex flex-col divide-y divide-border-subtle rounded-lg border border-border-subtle">
                    {destinations.map((destination) => (
                      <li key={destination.id} className="flex flex-col gap-3 p-3 sm:flex-row sm:items-center sm:justify-between">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="truncate font-medium text-sm">{destination.label}</span>
                            <Badge variant="default" size="sm">{DESTINATION_TYPES[destination.type]?.label || destination.type}</Badge>
                            {destination.isActive && <Badge variant="success" size="sm">启用中</Badge>}
                            {!destination.hasCredentials && <Badge variant="warning" size="sm">缺少凭据</Badge>}
                          </div>
                          <p className="mt-1 break-all text-xs text-text-muted"><code>{destination.displayUrl || "—"}</code></p>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          {!destination.isActive && (
                            <Button type="button" variant="outline" size="sm" onClick={() => activateDestination(destination.id)} disabled={loading || backupLoading}>
                              设为启用
                            </Button>
                          )}
                          <Button type="button" variant="ghost" size="sm" onClick={() => openEditDestination(destination)} disabled={loading || backupLoading || destination.type === "url"} title={destination.type === "url" ? "旧版 URL 保存位置不可编辑，请新增一个保存位置后删除它" : undefined}>
                            编辑
                          </Button>
                          <Button type="button" variant="ghost" size="sm" onClick={() => removeDestination(destination)} disabled={loading || backupLoading}>
                            删除
                          </Button>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
                <p className="text-xs text-text-muted">
                  凭据加密后仅保存在本机设置中，不会回传到浏览器。远端桶请自行开启服务端加密（OSS SSE / S3 SSE）。
                </p>
              </div>

              <div className="flex flex-col sm:flex-row gap-2 pt-4 border-t border-border">
                <Button type="button" variant="outline" onClick={refreshBackupStatus} disabled={loading || backupLoading}>
                  刷新状态
                </Button>
              </div>

              <div className="flex flex-col gap-2 pt-4 border-t border-border">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1 text-xs">
                  <p className="text-text-muted">
                    复制进程：<span className={backupStatus?.running ? "text-green-600 dark:text-green-400" : "text-text-muted"}>{backupStatus?.running ? `运行中${backupStatus.pid ? `（PID ${backupStatus.pid}）` : ""}` : "未运行"}</span>
                  </p>
                  <p className="text-text-muted break-all">
                    生效地址：<code>{backupStatus?.replicaUrl || "—"}</code>
                  </p>
                </div>

                {backupStatus?.replicaUrlError && (
                  <p className="text-xs text-red-500">配置错误：{backupStatus.replicaUrlError}</p>
                )}
                {backupStatus?.lastError && (
                  <p className="text-xs text-red-500 break-all">最近错误：{backupStatus.lastError}</p>
                )}
                {backupStatus?.restore?.pending && (
                  <p className="text-xs text-amber-500">
                    已暂存一次恢复，等待重启后生效{backupStatus.restore.pendingSince ? `（${new Date(backupStatus.restore.pendingSince).toLocaleString()}）` : ""}。
                  </p>
                )}
                {backupStatus?.recentLog?.length > 0 && (
                  <details className="text-xs">
                    <summary className="cursor-pointer text-text-muted">查看复制日志</summary>
                    <pre className="mt-2 max-h-40 overflow-auto rounded-lg border border-border-subtle bg-surface-2 p-2 text-[11px] leading-4 text-text-muted whitespace-pre-wrap break-all">{backupStatus.recentLog.slice(-12).join("\n")}</pre>
                  </details>
                )}

                <div className="flex flex-col sm:flex-row sm:items-center gap-3 pt-2">
                  <Button
                    type="button"
                    variant="outline"
                    icon="restore"
                    onClick={handleRestoreClick}
                    loading={backupLoading}
                    disabled={loading || backupStatus?.restore?.canSwapOnBoot === false}
                    className="w-full sm:w-auto"
                  >
                    从备份恢复
                  </Button>
                  <p className="text-xs text-text-muted">
                    {backupStatus?.restore?.canSwapOnBoot === false
                      ? "当前部署不支持在重启时替换数据库（仅 Docker 部署可用）；请手动停服后恢复 SQLite 文件。"
                      : "用最近一次备份覆盖当前数据库，服务会自动重启；替换前的数据库会另存一份。"}
                  </p>
                </div>

                {backupMessage.message && (
                  <p className={`text-xs sm:text-sm ${backupMessage.type === "error" ? "text-red-500" : "text-green-600 dark:text-green-400"}`}>
                    {backupMessage.message}
                  </p>
                )}
              </div>
            </div>
          )}

          {backupView === "portable" && (
            <div className="flex flex-col gap-3 pt-4 mt-4 border-t border-border">
              <p className="text-xs text-text-muted">
                导出为一份 JSON 快照，包含设置、供应商连接、API Key 等配置（不含请求明细）。
                它不依赖本机路径与版本，是迁移到其他服务器时唯一可用的方式；导入会覆盖当前配置。
              </p>
              <div className="flex flex-col sm:flex-row gap-2">
                <Button
                  variant="secondary"
                  icon="download"
                  onClick={() => setDbAuth({ open: true, mode: "export", password: "" })}
                  loading={dbLoading}
                  className="w-full sm:w-auto"
                >
                  导出快照
                </Button>
                <Button
                  variant="outline"
                  icon="upload"
                  onClick={() => importFileRef.current?.click()}
                  disabled={dbLoading}
                  className="w-full sm:w-auto"
                >
                  导入快照
                </Button>
                <input
                  ref={importFileRef}
                  type="file"
                  accept="application/json,.json"
                  className="hidden"
                  onChange={handleImportDatabase}
                />
              </div>
              {dbStatus.message && (
                <p className={`text-sm ${dbStatus.type === "error" ? "text-red-500" : "text-green-600 dark:text-green-400"}`}>
                  {dbStatus.message}
                </p>
              )}
            </div>
          )}
        </Card>

        </SettingsZone>

        <div className="border-t border-border-subtle pt-5 text-center text-xs sm:text-sm text-text-muted">
          <p>{APP_CONFIG.name} v{APP_CONFIG.version}</p>
          <p className="mt-1">Local Mode - All data stored on your machine</p>
        </div>
        </div>
      </div>

      <Drawer isOpen={passwordDrawerOpen} onClose={() => { if (!passLoading) { setPasswordDrawerOpen(false); setPasswords({ current: "", new: "", confirm: "" }); } }} title={settings.hasPassword ? "更新后台密码" : "设置后台密码"} width="md">
        <form onSubmit={handlePasswordChange} className="flex flex-col gap-4">
          <p className="text-sm text-text-muted">使用强密码；修改完成后，后续后台登录将立即使用新密码。</p>
          {settings.hasPassword && (
            <Input label="当前密码" type="password" placeholder="输入当前密码" value={passwords.current} onChange={(event) => setPasswords((prev) => ({ ...prev, current: event.target.value }))} required autoFocus />
          )}
          <Input label="新密码" type="password" placeholder="输入新密码" value={passwords.new} onChange={(event) => setPasswords((prev) => ({ ...prev, new: event.target.value }))} required autoFocus={!settings.hasPassword} />
          <Input label="确认新密码" type="password" placeholder="再次输入新密码" value={passwords.confirm} onChange={(event) => setPasswords((prev) => ({ ...prev, confirm: event.target.value }))} required />
          {passStatus.message && <p className={`text-xs sm:text-sm ${passStatus.type === "error" ? "text-red-500" : "text-green-500"}`}>{passStatus.message}</p>}
          <div className="flex justify-end gap-2 border-t border-border/50 pt-4">
            <Button type="button" variant="ghost" onClick={() => { setPasswordDrawerOpen(false); setPasswords({ current: "", new: "", confirm: "" }); }} disabled={passLoading}>取消</Button>
            <Button type="submit" loading={passLoading}>{settings.hasPassword ? "更新密码" : "设置密码"}</Button>
          </div>
        </form>
      </Drawer>

      <Drawer
        isOpen={ipAccessDrawerOpen}
        onClose={closeIpAccessDrawer}
        title="管理 IP 访问规则"
        width="lg"
      >
        <form onSubmit={saveIpAccess} className="flex flex-col gap-5">
          <div className="rounded-lg border border-border-subtle bg-surface-2 px-3 py-2 text-xs leading-5 text-text-muted">
            白名单和黑名单为互斥模式：白名单只允许列表中的来源；黑名单只拒绝列表中的来源。启用白名单前请先加入当前出口 IP。本机回环访问（127.0.0.1 / ::1）始终保留，作为恢复通道。
          </div>

          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="font-medium text-sm sm:text-base">启用 IP 访问控制</p>
              <p className="mt-1 text-xs sm:text-sm text-text-muted">规则保护 Dashboard、登录页及管理接口。</p>
            </div>
            <Toggle
              checked={ipAccessForm.enabled}
              onChange={() => setIpAccessForm((prev) => ({ ...prev, enabled: !prev.enabled }))}
              disabled={ipAccessLoading}
            />
          </div>

          <div className="flex flex-col gap-2 border-t border-border/50 pt-5">
            <label className="text-sm font-medium">访问模式</label>
            <SegmentedControl
              value={ipAccessForm.mode}
              onChange={(mode) => setIpAccessForm((prev) => ({ ...prev, mode, rules: "" }))}
              options={[
                { value: "allowlist", label: "白名单" },
                { value: "blocklist", label: "黑名单" },
              ]}
            />
            <p className="text-xs text-text-muted">
              {ipAccessForm.mode === "allowlist"
                ? "仅允许匹配列表的远程 IP / 网段访问；启用时至少需要一条规则。"
                : "拒绝匹配列表的远程 IP / 网段；未匹配的来源仍可访问。"}
            </p>
          </div>

          <div className="flex flex-col gap-2">
            <label className="text-sm font-medium">{ipAccessForm.mode === "allowlist" ? "白名单规则" : "黑名单规则"}</label>
            <textarea
              rows={10}
              placeholder={ipAccessForm.mode === "allowlist"
                ? "203.0.113.10\n10.0.0.0/8\n2001:db8::/32"
                : "198.51.100.7\n203.0.113.0/24"}
              value={ipAccessForm.rules}
              onChange={(event) => setIpAccessForm((prev) => ({ ...prev, rules: event.target.value }))}
              disabled={ipAccessLoading}
              className="w-full resize-y rounded-[10px] border border-transparent bg-surface-2 px-3 py-2.5 font-mono text-sm text-text-main placeholder-text-muted/70 outline-none transition-all focus:border-brand-500/40 focus:ring-2 focus:ring-brand-500/30 disabled:cursor-not-allowed disabled:opacity-50"
            />
            <p className="text-xs text-text-muted">每行一个 IPv4、IPv6 或 CIDR 网段，最多 100 条。</p>
          </div>

          {ipAccessStatus.message && (
            <p className={`text-xs sm:text-sm ${ipAccessStatus.type === "error" ? "text-red-500" : "text-green-500"}`}>
              {ipAccessStatus.message}
            </p>
          )}

          <div className="flex justify-end gap-2 border-t border-border/50 pt-4">
            <Button type="button" variant="ghost" onClick={closeIpAccessDrawer} disabled={ipAccessLoading}>取消</Button>
            <Button type="submit" loading={ipAccessLoading}>保存规则</Button>
          </div>
        </form>
      </Drawer>

      {/* Add / edit a backup destination. The fields are rendered from the shared
          type table, so picking SFTP shows host/user/path/password and picking S3
          shows bucket/region/AccessKey — the mismatch that started this rework
          cannot recur, because there is no per-type form to keep in sync. */}
      <Drawer
        isOpen={destinationDrawer.open}
        onClose={() => { if (!backupLoading) setDestinationDrawer((prev) => ({ ...prev, open: false })); }}
        title={draftEditing ? "编辑保存位置" : "添加保存位置"}
        width="lg"
      >
        <form onSubmit={saveDestination} className="flex flex-col gap-5">
          <div className="flex flex-col gap-2">
            <label className="text-sm font-medium">类型</label>
            <Select
              options={DESTINATION_TYPE_OPTIONS}
              value={destinationDrawer.draft.type}
              onChange={(event) => {
                // Rebuild the draft for the new type so its fields (and only its
                // fields) exist — a stale `bucket` from the previous type would
                // otherwise be submitted.
                const type = event.target.value;
                setDestinationDrawer((prev) => ({ ...prev, draft: { ...emptyDestinationDraft(type), label: prev.draft.label } }));
              }}
              disabled={draftEditing || backupLoading}
              aria-label="保存位置类型"
            />
            {draftSpec.hint && <p className="text-xs text-text-muted">{draftSpec.hint}</p>}
            {draftEditing && <p className="text-xs text-text-muted">类型创建后不可更改，如需更换请删除后重新添加。</p>}
          </div>

          <div className="flex flex-col gap-2 border-t border-border/50 pt-5">
            <label className="text-sm font-medium">名称</label>
            <Input
              placeholder={draftSpec.label}
              value={destinationDrawer.draft.label}
              onChange={(event) => setDestinationDrawer((prev) => ({ ...prev, draft: { ...prev.draft, label: event.target.value } }))}
              disabled={backupLoading}
            />
          </div>

          <div className="flex flex-col gap-4 border-t border-border/50 pt-5">
            {draftSpec.configFields.map((field) => (
              <div key={field.key} className="flex flex-col gap-2">
                <label className="text-sm font-medium">{field.label}{field.required ? "" : "（可选）"}</label>
                {field.type === "boolean" ? (
                  <Toggle
                    checked={destinationDrawer.draft.config[field.key] === true}
                    onChange={() => setDestinationDrawer((prev) => ({
                      ...prev,
                      draft: { ...prev.draft, config: { ...prev.draft.config, [field.key]: !prev.draft.config[field.key] } },
                    }))}
                    disabled={backupLoading}
                  />
                ) : (
                  <Input
                    placeholder={field.placeholder}
                    value={destinationDrawer.draft.config[field.key] ?? ""}
                    onChange={(event) => setDestinationDrawer((prev) => ({
                      ...prev,
                      draft: { ...prev.draft, config: { ...prev.draft.config, [field.key]: event.target.value } },
                    }))}
                    disabled={backupLoading}
                    spellCheck={false}
                  />
                )}
              </div>
            ))}
          </div>

          {draftSpec.secretFields.length > 0 && (
            <div className="flex flex-col gap-4 border-t border-border/50 pt-5">
              <p className="text-xs text-text-muted">
                凭据加密后仅保存在本机，不会回传到浏览器。
                {draftEditing && "留空表示保持已保存的凭据不变。"}
              </p>
              {draftSpec.secretFields.map((field) => (
                <div key={field.key} className="flex flex-col gap-2">
                  <label className="text-sm font-medium">{field.label}{field.required && !draftEditing ? "" : "（可选）"}</label>
                  <Input
                    type={field.type === "password" ? "password" : "text"}
                    placeholder={draftEditing ? "已保存；留空保持不变" : ""}
                    value={destinationDrawer.draft.secret[field.key] ?? ""}
                    onChange={(event) => setDestinationDrawer((prev) => ({
                      ...prev,
                      draft: { ...prev.draft, secret: { ...prev.draft.secret, [field.key]: event.target.value } },
                    }))}
                    disabled={backupLoading}
                    autoComplete={field.type === "password" ? "new-password" : "off"}
                  />
                </div>
              ))}
            </div>
          )}

          {backupMessage.message && destinationDrawer.open && (
            <p className={`text-xs sm:text-sm ${backupMessage.type === "error" ? "text-red-500" : "text-green-500"}`}>
              {backupMessage.message}
            </p>
          )}

          <div className="flex justify-end gap-2 border-t border-border/50 pt-4">
            <Button type="button" variant="ghost" onClick={() => setDestinationDrawer((prev) => ({ ...prev, open: false }))} disabled={backupLoading}>取消</Button>
            <Button type="submit" loading={backupLoading} disabled={draftMissingRequired}>
              {draftEditing ? "保存修改" : "添加"}
            </Button>
          </div>
        </form>
      </Drawer>

      <Modal
        isOpen={totpDialog.open}
        onClose={closeTotpDialog}
        title={totpDialog.mode === "disable" ? "关闭二次认证" : "设置 Microsoft Authenticator"}
        size={totpDialog.setup ? "lg" : "sm"}
      >
        {totpDialog.mode === "disable" ? (
          <form onSubmit={disableTotp} className="flex flex-col gap-4">
            <p className="text-sm text-text-muted">为防止误操作，请输入当前密码，以及 Microsoft Authenticator 验证码或一条恢复码。</p>
            <Input label="当前密码" type="password" value={totpDialog.password} onChange={(event) => setTotpDialog((prev) => ({ ...prev, password: event.target.value }))} required autoFocus />
            <Input label="验证码或恢复码" placeholder="123456 或 ABCDE-12345" value={totpDialog.code} onChange={(event) => setTotpDialog((prev) => ({ ...prev, code: event.target.value.toUpperCase() }))} required />
            {totpStatus.message && <p className="text-xs text-red-500">{totpStatus.message}</p>}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={closeTotpDialog} disabled={totpLoading}>取消</Button>
              <Button type="submit" variant="outline" loading={totpLoading}>关闭二次认证</Button>
            </div>
          </form>
        ) : totpDialog.setup ? (
          <form onSubmit={enableTotp} className="flex flex-col gap-4">
            <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400">
              请使用 Microsoft Authenticator 扫描二维码。恢复码只会显示这一次，请立即保存到安全位置。
            </div>
            <div className="grid gap-5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
              <div className="min-w-0">
                <p className="font-medium">1. 扫描二维码</p>
                <p className="mt-1 text-sm text-text-muted">在 Authenticator 中添加“其他帐户”，然后扫描此二维码。</p>
                <p className="mt-4 text-sm font-medium">无法扫描时的手动密钥</p>
                <code className="mt-1 block break-all rounded bg-surface-2 px-3 py-2 text-xs text-text-main">{totpDialog.setup.manualKey}</code>
              </div>
              <Image src={totpDialog.setup.qrCodeDataUrl} alt="Microsoft Authenticator TOTP QR code" width={192} height={192} unoptimized className="mx-auto size-48 rounded-lg border border-border-subtle bg-white p-2" />
            </div>
            <div className="border-t border-border/50 pt-4">
              <p className="font-medium">2. 保存恢复码</p>
              <div className="mt-2 grid grid-cols-2 gap-2 rounded-lg bg-surface-2 p-3 font-mono text-sm text-text-main">
                {totpDialog.setup.recoveryCodes.map((code) => <span key={code}>{code}</span>)}
              </div>
            </div>
            <Input label="3. 输入 Authenticator 当前验证码以确认" placeholder="123456" value={totpDialog.code} onChange={(event) => setTotpDialog((prev) => ({ ...prev, code: event.target.value.replace(/\D/g, "").slice(0, 6) }))} required autoFocus />
            {totpStatus.message && <p className="text-xs text-red-500">{totpStatus.message}</p>}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={closeTotpDialog} disabled={totpLoading}>取消</Button>
              <Button type="submit" loading={totpLoading} disabled={totpDialog.code.length !== 6}>确认启用</Button>
            </div>
          </form>
        ) : (
          <form onSubmit={startTotpSetup} className="flex flex-col gap-4">
            <p className="text-sm text-text-muted">启用后，密码登录还需要 Microsoft Authenticator 的动态验证码。请先输入当前密码确认身份。</p>
            <Input label="当前密码" type="password" value={totpDialog.password} onChange={(event) => setTotpDialog((prev) => ({ ...prev, password: event.target.value }))} required autoFocus />
            {settings.totpSetupPending && <p className="text-xs text-amber-600 dark:text-amber-400">检测到未完成的绑定。重新开始会使之前未确认的二维码和恢复码失效。</p>}
            {totpStatus.message && <p className="text-xs text-red-500">{totpStatus.message}</p>}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={closeTotpDialog} disabled={totpLoading}>取消</Button>
              <Button type="submit" loading={totpLoading} disabled={!totpDialog.password}>继续</Button>
            </div>
          </form>
        )}
      </Modal>

      <Modal
        isOpen={dbAuth.open}
        onClose={() => setDbAuth({ open: false, mode: "", password: "" })}
        title={dbAuth.mode === "restore" ? "确认从远端恢复" : "Confirm Password"}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setDbAuth({ open: false, mode: "", password: "" })} disabled={dbLoading || backupLoading}>
              Cancel
            </Button>
            <Button variant="primary" onClick={handleDbAuthConfirm} loading={dbLoading || backupLoading} disabled={!dbAuth.password}>
              Confirm
            </Button>
          </>
        }
      >
        {dbAuth.mode === "restore" ? (
          <p className="text-red-500 mb-3 text-sm">
            这会把当前数据库替换为远端最近的一次备份，重启后生效。替换前的数据库会另存一份，但请确认你确实要回滚。
          </p>
        ) : (
          <p className="text-text-muted mb-3 text-sm">
            Enter your current password to {dbAuthVerb} the database.
          </p>
        )}
        <Input
          type="password"
          value={dbAuth.password}
          onChange={(e) => setDbAuth((s) => ({ ...s, password: e.target.value }))}
          onKeyDown={(e) => { if (e.key === "Enter" && dbAuth.password) handleDbAuthConfirm(); }}
          placeholder="Current password"
          autoFocus
        />
      </Modal>
    </div>
  );
}
