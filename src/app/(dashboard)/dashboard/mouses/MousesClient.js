"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Card, ConfirmModal, DashboardHero, Drawer, Input, Select } from "@/shared/components";

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}

function formatRelative(value) {
  if (!value) return "—";
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "—";
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `${seconds} 秒前`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

function StatusBadge({ mouse }) {
  const variant = mouse.status === "online" ? "success" : mouse.status === "disabled" ? "error" : "default";
  const label = mouse.status === "online" ? "在线" : mouse.status === "disabled" ? "已禁用" : "离线";
  return <Badge variant={variant} dot>{label}</Badge>;
}

function TokenBadge({ token }) {
  const variant = token.status === "active" ? "success" : token.status === "revoked" ? "error" : "warning";
  const label = token.status === "active" ? "可用" : token.status === "revoked" ? "已删除" : "已过期";
  return <Badge variant={variant}>{label}</Badge>;
}

const TOKEN_TTL_OPTIONS = [
  { value: "permanent", label: "长期有效" },
  { value: "3600", label: "1 小时" },
  { value: "86400", label: "1 天" },
  { value: "604800", label: "7 天" },
  { value: "2592000", label: "30 天" },
];

export default function MousesClient() {
  const [mouses, setMouses] = useState([]);
  const [accessTokens, setAccessTokens] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [tokenName, setTokenName] = useState("");
  const [tokenTtl, setTokenTtl] = useState("604800");
  const [creating, setCreating] = useState(false);
  const [createdToken, setCreatedToken] = useState(null);
  const [copied, setCopied] = useState(false);
  const [tokenDrawerOpen, setTokenDrawerOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [savingMouseId, setSavingMouseId] = useState("");
  const [savingTokenId, setSavingTokenId] = useState("");

  const loadData = useCallback(async () => {
    setError("");
    try {
      const response = await fetch("/api/mouses", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "读取 Mouse 失败");
      setMouses(data.mouses || []);
      setAccessTokens(data.accessTokens || []);
    } catch (loadError) {
      setError(loadError.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const initialTimer = window.setTimeout(() => { void loadData(); }, 0);
    const timer = window.setInterval(() => { void loadData(); }, 30000);
    return () => {
      window.clearTimeout(initialTimer);
      window.clearInterval(timer);
    };
  }, [loadData]);

  const createToken = async () => {
    setCreating(true);
    setError("");
    try {
      const response = await fetch("/api/mouses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: tokenName.trim() || undefined, ttlSeconds: tokenTtl === "permanent" ? null : Number(tokenTtl) }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "创建访问 Token 失败");
      setCreatedToken(data.accessToken);
      setCopied(false);
      setTokenName("");
      await loadData();
    } catch (createError) {
      setError(createError.message);
    } finally {
      setCreating(false);
    }
  };

  const deleteToken = async (token) => {
    await fetch(`/api/mouses/access-tokens/${token.id}`, { method: "DELETE" });
    await loadData();
  };

  const rotateToken = async (token) => {
    setSavingTokenId(token.id);
    setError("");
    try {
      const response = await fetch(`/api/mouses/access-tokens/${token.id}/rotate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ttlSeconds: tokenTtl === "permanent" ? null : Number(tokenTtl) }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "轮换 Token 失败");
      setCreatedToken({ ...token, ...data });
      setCopied(false);
      await loadData();
    } catch (rotateError) {
      setError(rotateError.message);
    } finally {
      setSavingTokenId("");
    }
  };

  const toggleMouse = async (mouse) => {
    setSavingMouseId(mouse.id);
    try {
      await fetch(`/api/mouses/${mouse.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ disabled: mouse.status !== "disabled" }),
      });
      await loadData();
    } finally {
      setSavingMouseId("");
    }
  };

  const deleteMouse = async () => {
    if (!confirmDelete) return;
    setSavingMouseId(confirmDelete.id);
    try {
      await fetch(`/api/mouses/${confirmDelete.id}`, { method: "DELETE" });
      setConfirmDelete(null);
      await loadData();
    } finally {
      setSavingMouseId("");
    }
  };

  const copyToken = async () => {
    await navigator.clipboard.writeText(createdToken?.token || "");
    setCopied(true);
  };

  // The plaintext token must not survive the drawer: closing it drops the
  // secret from memory, matching the "only visible once" promise in the copy.
  const closeTokenDrawer = () => {
    setTokenDrawerOpen(false);
    setCreatedToken(null);
    setCopied(false);
  };

  const onlineCount = mouses.filter((mouse) => mouse.isOnline).length;
  const activeTokenCount = accessTokens.filter((token) => token.status === "active").length;

  return (
    <div className="flex min-w-0 flex-col gap-5 p-3 sm:p-4 lg:p-5">
      <DashboardHero
        eyebrow="EXECUTION NODES"
        title="Mouse 执行节点"
        description="Mouse 是可选的远程渠道执行节点。未绑定 Mouse 的渠道账号仍由 Spring 本机执行。"
        icon="device_hub"
        action={<Button variant="secondary" icon="key" onClick={() => setTokenDrawerOpen(true)}>访问 Token</Button>}
      >
        <Badge size="md" variant="default" icon="dns">{mouses.length} 个节点</Badge>
        <Badge size="md" variant={onlineCount ? "success" : "default"} icon="sensors">{onlineCount} 个在线</Badge>
        <Badge size="md" variant={activeTokenCount ? "primary" : "default"} icon="key">{activeTokenCount} 个可用 Token</Badge>
      </DashboardHero>

      {error && (
        <Card className="border-red-500/30 bg-red-500/5 p-3 text-sm text-red-500">{error}</Card>
      )}

      <Card title="已注册 Mouse" subtitle="状态每 30 秒自动刷新。">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead className="text-xs uppercase tracking-wide text-text-muted">
              <tr>
                <th className="px-3 py-2">节点</th>
                <th className="px-3 py-2">状态</th>
                <th className="px-3 py-2">绑定账号</th>
                <th className="px-3 py-2">最后心跳</th>
                <th className="px-3 py-2">版本</th>
                <th className="px-3 py-2 text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {mouses.map((mouse) => (
                <tr key={mouse.id} className="border-t border-border-subtle">
                  <td className="px-3 py-2.5">
                    <div className="font-medium text-text-main">{mouse.name}</div>
                    <div className="font-mono text-xs text-text-muted">{mouse.clientId}</div>
                  </td>
                  <td className="px-3 py-2.5"><StatusBadge mouse={mouse} /></td>
                  <td className="px-3 py-2.5">
                    {mouse.boundAccountCount
                      ? <span className="text-text-main">{mouse.boundAccountCount} 个账号</span>
                      : <span className="text-text-muted">未绑定</span>}
                  </td>
                  <td className="px-3 py-2.5 text-text-muted" title={formatDate(mouse.lastHeartbeatAt)}>{formatRelative(mouse.lastHeartbeatAt)}</td>
                  <td className="px-3 py-2.5 text-text-muted">{mouse.version || "—"}</td>
                  <td className="px-3 py-2.5 text-right">
                    <div className="inline-flex gap-1">
                      <Button size="sm" variant="secondary" loading={savingMouseId === mouse.id} onClick={() => toggleMouse(mouse)}>
                        {mouse.status === "disabled" ? "启用" : "禁用"}
                      </Button>
                      <Button size="sm" variant="danger" onClick={() => setConfirmDelete(mouse)}>删除</Button>
                    </div>
                  </td>
                </tr>
              ))}
              {!mouses.length && (
                <tr><td colSpan="6" className="px-3 py-6 text-center text-text-muted">还没有 Mouse 注册；当前所有渠道仍由 Spring 执行</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <Drawer isOpen={tokenDrawerOpen} onClose={closeTokenDrawer} title="Mouse 访问 Token" width="xl">
        <div className="flex flex-col gap-6">
          <section className="rounded-xl border border-border-subtle bg-bg/30 p-5">
            <h3 className="text-sm font-semibold text-text-main">生成访问 Token</h3>
            <p className="mt-1 text-xs text-text-muted">同一个有效 Token 可以认证多个 Mouse；Mouse 通过 clientId 唯一标识。</p>
            <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end">
              <Input
                className="flex-1"
                label="Token 名称"
                placeholder="例如：US Twitter Mouse"
                value={tokenName}
                onChange={(event) => setTokenName(event.target.value)}
              />
              <Select
                className="sm:w-36"
                label="有效期"
                value={tokenTtl}
                onChange={(event) => setTokenTtl(event.target.value)}
                options={TOKEN_TTL_OPTIONS}
              />
              <Button onClick={createToken} loading={creating}>生成</Button>
            </div>

            {createdToken && (
              <div className="mt-4 rounded-xl border border-[#38bdf8]/30 bg-[#38bdf8]/[0.06] p-4">
                <div className="flex items-center gap-2 text-sm font-medium text-[#7dd3fc]">
                  <span className="material-symbols-outlined text-[18px]">key</span>
                  Token 已生成，请立即复制
                </div>
                <code className="mt-3 block break-all rounded-lg bg-surface-2 p-3 font-mono text-xs text-text-main">{createdToken.token}</code>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <Button size="sm" variant="secondary" icon={copied ? "check" : "content_copy"} onClick={copyToken}>
                    {copied ? "已复制" : "复制 Token"}
                  </Button>
                  <span className="text-xs text-text-muted">关闭抽屉后无法再次查看。</span>
                </div>
              </div>
            )}
          </section>

          <section>
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-text-main">已生成 Token</h3>
              <span className="text-xs text-text-muted">{accessTokens.length} 个</span>
            </div>
            <div className="overflow-x-auto rounded-xl border border-border-subtle">
              <table className="w-full text-left text-sm">
                <thead className="bg-bg/40 text-xs uppercase tracking-wide text-text-muted">
                  <tr>
                    <th className="px-3 py-2">名称</th>
                    <th className="px-3 py-2">状态</th>
                    <th className="px-3 py-2">过期时间</th>
                    <th className="px-3 py-2">创建时间</th>
                    <th className="px-3 py-2 text-right">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {accessTokens.map((token) => (
                    <tr key={token.id} className="border-t border-border-subtle">
                      <td className="px-3 py-2.5 font-medium text-text-main">{token.name}</td>
                      <td className="px-3 py-2.5"><TokenBadge token={token} /></td>
                      <td className="px-3 py-2.5 text-text-muted">{formatDate(token.expiresAt)}</td>
                      <td className="px-3 py-2.5 text-text-muted">{formatDate(token.createdAt)}</td>
                      <td className="px-3 py-2.5 text-right">
                        <div className="inline-flex gap-1">
                          <Button size="sm" variant="secondary" loading={savingTokenId === token.id} onClick={() => rotateToken(token)}>轮换</Button>
                          <Button size="sm" variant="danger" onClick={() => deleteToken(token)}>删除</Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                  {!accessTokens.length && (
                    <tr><td colSpan="5" className="px-3 py-6 text-center text-text-muted">暂无访问 Token</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      </Drawer>

      <ConfirmModal
        isOpen={Boolean(confirmDelete)}
        title="删除 Mouse"
        message={`删除 ${confirmDelete?.name || ""} 后，绑定该节点的渠道账号会自动恢复为 Spring 本机执行。`}
        onConfirm={deleteMouse}
        onClose={() => setConfirmDelete(null)}
        loading={Boolean(confirmDelete && savingMouseId === confirmDelete.id)}
      />
    </div>
  );
}
