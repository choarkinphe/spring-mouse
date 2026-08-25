"use client";

import { useState, useEffect, useRef } from "react";
import Image from "next/image";
import { Badge, Card, Button, DashboardHero, Drawer, SegmentedControl, Toggle, Input } from "@/shared/components";
import Modal from "@/shared/components/Modal";
import { APP_CONFIG } from "@/shared/constants/config";
import TokenSaverClient from "../token-saver/TokenSaverClient";

function SettingsZone({ id, index, title, description, children }) {
  return (
    <section id={id} className="scroll-mt-6 grid gap-4 xl:grid-cols-[11rem_minmax(0,1fr)] xl:gap-7">
      <div className="xl:pt-5">
        <div className="inline-flex items-center gap-2 text-[10px] font-mono font-semibold uppercase tracking-[0.18em] text-[#38bdf8]">
          <span className="h-px w-5 bg-[#38bdf8]/70" />
          {index}
        </div>
        <h2 className="mt-2 text-base font-semibold text-text-main">{title}</h2>
        <p className="mt-1 max-w-[13rem] text-xs leading-5 text-text-muted">{description}</p>
      </div>
      <div className="min-w-0">{children}</div>
    </section>
  );
}

export default function ProfilePage() {
  const [settings, setSettings] = useState({});
  const [loading, setLoading] = useState(true);
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

  useEffect(() => {
    fetch("/api/settings")
      .then((res) => res.json())
      .then((data) => {
        setSettings(data);
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
  };

  const observabilityEnabled = settings.enableObservability === true;
  const requestLogFileDumpsEnabled = settings.enableRequestLogFileDumps === true;

  return (
    <div className="mx-auto w-full max-w-6xl px-4 pb-8 pt-1 sm:px-0 sm:pt-2">
      <div className="flex flex-col gap-7">
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

        <SettingsZone
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
              <Button type="submit" loading={apiKeyQuotaLoading} disabled={loading}>
                Save
              </Button>
            </form>
            {apiKeyQuotaStatus.message && (
              <p className={`mt-4 border-t border-border/50 pt-4 text-xs sm:text-sm ${apiKeyQuotaStatus.type === "error" ? "text-red-500" : "text-green-500"}`}>
                {apiKeyQuotaStatus.message}
              </p>
            )}
          </Card>
        </SettingsZone>

        <SettingsZone
          id="token-saver"
          index="04"
          title="Token 节省"
          description="配置工具输出、上下文与模型输出的压缩策略，降低调用成本。"
        >
          <TokenSaverClient embedded />
        </SettingsZone>

        <SettingsZone
          index="05"
          title="数据维护"
          description="通过加密备份导出和导入，在设备之间安全迁移配置。"
        >
        {/* Backup and restore */}
        <Card>
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-4">
            <div className="flex items-center gap-3 sm:gap-4">
              <div className="size-10 sm:size-12 rounded-lg bg-[#38bdf8]/10 text-[#38bdf8] flex items-center justify-center shrink-0">
                <span className="material-symbols-outlined text-xl sm:text-2xl">inventory_2</span>
              </div>
              <div>
                <h2 className="text-lg sm:text-xl font-semibold">备份与恢复</h2>
                <p className="text-sm text-text-muted">导出当前配置，或从备份安全恢复</p>
              </div>
            </div>
          </div>
          <div className="flex flex-col gap-3 pt-4 border-t border-border">
            <div className="flex flex-col sm:flex-row gap-2">
              <Button
                variant="secondary"
                icon="download"
                onClick={() => setDbAuth({ open: true, mode: "export", password: "" })}
                loading={dbLoading}
                className="w-full sm:w-auto"
              >
                Download Backup
              </Button>
              <Button
                variant="outline"
                icon="upload"
                onClick={() => importFileRef.current?.click()}
                disabled={dbLoading}
                className="w-full sm:w-auto"
              >
                Import Backup
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
        </Card>


        </SettingsZone>

        <div className="border-t border-border-subtle pt-5 text-center text-xs sm:text-sm text-text-muted">
          <p>{APP_CONFIG.name} v{APP_CONFIG.version}</p>
          <p className="mt-1">Local Mode - All data stored on your machine</p>
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
        title="Confirm Password"
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setDbAuth({ open: false, mode: "", password: "" })} disabled={dbLoading}>
              Cancel
            </Button>
            <Button variant="primary" onClick={handleDbAuthConfirm} loading={dbLoading} disabled={!dbAuth.password}>
              Confirm
            </Button>
          </>
        }
      >
        <p className="text-text-muted mb-3 text-sm">
          Enter your current password to {dbAuth.mode === "export" ? "export" : "import"} the database.
        </p>
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
