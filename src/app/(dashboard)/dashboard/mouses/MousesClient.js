"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Card, ConfirmModal, DashboardHero, Input, Modal, Select } from "@/shared/components";

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
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

  const onlineCount = mouses.filter((mouse) => mouse.isOnline).length;

  return (
    <div className="flex min-w-0 flex-col gap-5 p-3 sm:p-4 lg:p-5">
      <DashboardHero
        eyebrow="EXECUTION NODES"
        title="Mouse 执行节点"
        description="Mouse 是可选的远程渠道执行节点。未绑定 Mouse 的渠道账号仍由 Spring 本机执行。"
        icon="device_hub"
        action={<Button icon="add_link" onClick={createToken} loading={creating}>生成访问 Token</Button>}
      >
        <Badge variant="primary" icon="dns">{mouses.length} 个节点</Badge>
        <Badge variant={onlineCount ? "success" : "default"} dot>{onlineCount} 个在线</Badge>
      </DashboardHero>

      {error && (
        <Card className="border-red-500/30 bg-red-500/5 p-3 text-sm text-red-500">{error}</Card>
      )}

      <Card title="Mouse 访问 Token" subtitle="同一个有效 Token 可以认证多个 Mouse；Mouse 通过 clientId 唯一标识。">
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            className="flex-1"
            label="Token 名称"
            placeholder="例如：US Twitter Mouse"
            value={tokenName}
            onChange={(event) => setTokenName(event.target.value)}
          />
          <Select
            className="sm:w-48"
            label="有效期"
            value={tokenTtl}
            onChange={(event) => setTokenTtl(event.target.value)}
            options={[
              { value: "permanent", label: "长期有效" },
              { value: "3600", label: "1 小时" },
              { value: "86400", label: "1 天" },
              { value: "604800", label: "7 天" },
              { value: "2592000", label: "30 天" },
            ]}
          />
          <div className="flex items-end">
            <Button onClick={createToken} loading={creating}>生成</Button>
          </div>
        </div>

        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[820px] text-left text-sm">
            <thead className="text-xs uppercase tracking-wide text-text-muted">
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
                  <td className="px-3 py-2.5 font-medium">{token.name}</td>
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
      </Card>

      <Card title="已注册 Mouse" subtitle="状态每 30 秒自动刷新。">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[840px] text-left text-sm">
            <thead className="text-xs uppercase tracking-wide text-text-muted">
              <tr>
                <th className="px-3 py-2">Client ID</th>
                <th className="px-3 py-2">名称</th>
                <th className="px-3 py-2">状态</th>
                <th className="px-3 py-2">版本</th>
                <th className="px-3 py-2">能力</th>
                <th className="px-3 py-2">最后心跳</th>
                <th className="px-3 py-2 text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {mouses.map((mouse) => (
                <tr key={mouse.id} className="border-t border-border-subtle">
                  <td className="px-3 py-2.5 font-mono text-xs">{mouse.clientId}</td>
                  <td className="px-3 py-2.5 font-medium">{mouse.name}</td>
                  <td className="px-3 py-2.5"><StatusBadge mouse={mouse} /></td>
                  <td className="px-3 py-2.5 text-text-muted">{mouse.version || "—"}</td>
                  <td className="px-3 py-2.5 text-text-muted">{mouse.capabilities?.join(", ") || "通用"}</td>
                  <td className="px-3 py-2.5 text-text-muted">{formatDate(mouse.lastHeartbeatAt)}</td>
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
                <tr><td colSpan="7" className="px-3 py-6 text-center text-text-muted">还没有 Mouse 注册；当前所有渠道仍由 Spring 执行</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <Modal
        isOpen={Boolean(createdToken)}
        title="Mouse 访问 Token"
        onClose={() => setCreatedToken(null)}
        footer={<Button onClick={() => setCreatedToken(null)}>完成</Button>}
      >
        <div className="flex flex-col gap-3">
          <p className="text-sm text-text-muted">请立即复制。这个 Token 可以给多个 Mouse 使用，关闭后无法再次查看。</p>
          <code className="block break-all rounded-lg bg-surface-2 p-3 font-mono text-xs">{createdToken?.token}</code>
          <Button variant="secondary" icon={copied ? "check" : "content_copy"} onClick={copyToken}>{copied ? "已复制" : "复制 Token"}</Button>
        </div>
      </Modal>

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
