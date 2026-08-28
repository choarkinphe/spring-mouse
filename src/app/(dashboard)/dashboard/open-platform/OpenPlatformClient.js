"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, Button, ConfirmModal, DashboardHero, Drawer, Input, Modal, Toggle } from "@/shared/components";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import { cn } from "@/shared/utils/cn";

const ENDPOINTS = [
  { id: "users", method: "GET", path: "/open/v1/users", title: "成员目录", icon: "group" },
  { id: "report", method: "GET", path: "/open/v1/usage/report", title: "成员使用报告", icon: "query_stats" },
];

function formatDate(value) {
  if (!value) return "尚未调用";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  });
}

function CodeBlock({ code, copyId, copied, onCopy }) {
  return (
    <div className="overflow-hidden rounded-xl border border-white/[0.07] bg-[#09111a]">
      <div className="flex items-center justify-between border-b border-white/[0.06] px-3 py-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-[#5f7182]">request</span>
        <button type="button" onClick={() => onCopy(code, copyId)} className="inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] text-[#8da1b3] transition-colors hover:bg-white/[0.06] hover:text-[#7dd3fc]">
          <span className="material-symbols-outlined text-[14px]">{copied === copyId ? "check" : "content_copy"}</span>
          {copied === copyId ? "已复制" : "复制"}
        </button>
      </div>
      <pre className="overflow-x-auto p-4 font-mono text-[12px] leading-6 text-[#b9c8d5]"><code>{code}</code></pre>
    </div>
  );
}

function ParameterTable({ rows }) {
  return (
    <div className="overflow-hidden rounded-xl border border-border-subtle">
      <div className="grid grid-cols-[110px_72px_minmax(0,1fr)] bg-bg px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-text-muted">
        <span>参数</span><span>必填</span><span>说明</span>
      </div>
      {rows.map((row) => (
        <div key={row.name} className="grid grid-cols-[110px_72px_minmax(0,1fr)] items-start border-t border-border-subtle px-3 py-3 text-xs">
          <code className="text-sky-500">{row.name}</code>
          <span className={row.required ? "text-amber-500" : "text-text-muted"}>{row.required ? "是" : "否"}</span>
          <span className="leading-5 text-text-muted">{row.description}</span>
        </div>
      ))}
    </div>
  );
}

function EndpointDocumentation({ endpoint, baseUrl, copied, copy }) {
  const usersCurl = `curl '${baseUrl}/open/v1/users' \\\n  -H 'Authorization: Bearer smop_YOUR_OPEN_PLATFORM_KEY'`;
  const reportCurl = `curl -G '${baseUrl}/open/v1/usage/report' \\\n  -H 'Authorization: Bearer smop_YOUR_OPEN_PLATFORM_KEY' \\\n  --data-urlencode 'userId=USER_ID_FROM_DIRECTORY' \\\n  --data-urlencode 'startDate=2026-08-01T00:00:00+08:00' \\\n  --data-urlencode 'endDate=2026-08-28T23:59:59+08:00'`;

  const response = endpoint.id === "users"
    ? `{
  "object": "list",
  "data": [
    {
      "userId": "8cf1...",
      "name": "Alice",
      "active": true,
      "createdAt": "2026-07-01T08:00:00.000Z",
      "lastUsedAt": "2026-08-28T10:30:00.000Z"
    }
  ]
}`
    : `{
  "object": "usage_report",
  "range": {
    "startDate": "2026-07-31T16:00:00.000Z",
    "endDate": "2026-08-28T15:59:59.000Z"
  },
  "subject": {
    "userId": "8cf1...",
    "name": "Alice",
    "hasUsage": true
  },
  "usage": {
    "requests": 22784,
    "successRate": 0.953,
    "tokens": { "total": 3737700000 },
    "estimatedCost": 2502.81
  },
  "comparison": {
    "referenceScore": 98,
    "ranks": { "overall": 1, "tokens": 1 }
  }
}`;

  return (
    <article className="min-w-0">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border-subtle pb-5">
        <div>
          <div className="flex items-center gap-2">
            <Badge size="sm" variant="success">{endpoint.method}</Badge>
            <code className="break-all font-mono text-sm font-semibold text-text-main">{endpoint.path}</code>
          </div>
          <h2 className="mt-3 text-xl font-semibold text-text-main">{endpoint.title}</h2>
          <p className="mt-1.5 max-w-2xl text-sm leading-6 text-text-muted">
            {endpoint.id === "users"
              ? "获取当前系统中可用于使用报告查询的成员标识。先调用该接口取得 userId，再查询指定成员的报告。"
              : "按成员和 ISO-8601 时间范围生成与使用看板一致的个人使用报告，并返回团队聚合基准和排名。"}
          </p>
        </div>
        <Badge icon="lock" variant="primary">开放平台密钥</Badge>
      </div>

      <div className="mt-6 space-y-7">
        <section>
          <h3 className="mb-3 text-sm font-semibold text-text-main">请求示例</h3>
          <CodeBlock code={endpoint.id === "users" ? usersCurl : reportCurl} copyId={`curl-${endpoint.id}`} copied={copied} onCopy={copy} />
        </section>

        {endpoint.id === "report" && (
          <section>
            <h3 className="mb-3 text-sm font-semibold text-text-main">查询参数</h3>
            <ParameterTable rows={[
              { name: "userId", required: true, description: "成员目录接口返回的 userId。" },
              { name: "startDate", required: true, description: "统计起始时间，ISO-8601 格式，建议携带明确时区。" },
              { name: "endDate", required: true, description: "统计结束时间，ISO-8601 格式，不得早于 startDate。" },
            ]} />
          </section>
        )}

        <section>
          <h3 className="mb-3 text-sm font-semibold text-text-main">响应示例</h3>
          <CodeBlock code={response} copyId={`response-${endpoint.id}`} copied={copied} onCopy={copy} />
        </section>

        <section className="rounded-xl border border-amber-500/15 bg-amber-500/[0.045] p-4">
          <div className="flex gap-3">
            <span className="material-symbols-outlined mt-0.5 text-[18px] text-amber-500">privacy_tip</span>
            <div>
              <p className="text-sm font-semibold text-text-main">鉴权与数据边界</p>
              <p className="mt-1 text-xs leading-5 text-text-muted">开放平台密钥拥有读取使用报告的能力，请仅交给可信服务端系统。接口不会返回模型调用密钥原文；所有响应均设置 Cache-Control: no-store。</p>
            </div>
          </div>
        </section>
      </div>
    </article>
  );
}

function statusVariant(statusCode) {
  if (statusCode >= 500) return "error";
  if (statusCode >= 400) return "warning";
  return "success";
}

export default function OpenPlatformClient() {
  const [keys, setKeys] = useState([]);
  const [keysLoading, setKeysLoading] = useState(true);
  const [error, setError] = useState("");
  const [managementOpen, setManagementOpen] = useState(false);
  const [managementView, setManagementView] = useState("keys");
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createdKey, setCreatedKey] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [selectedEndpoint, setSelectedEndpoint] = useState("users");
  const [baseUrl, setBaseUrl] = useState("https://spring-mouse.example.com");
  const [logs, setLogs] = useState([]);
  const [logsLoading, setLogsLoading] = useState(false);
  const [logKeyFilter, setLogKeyFilter] = useState("");
  const [logPagination, setLogPagination] = useState({ page: 1, pageSize: 30, totalItems: 0, totalPages: 0 });
  const { copied, copy } = useCopyToClipboard(2000);

  const loadKeys = useCallback(async () => {
    try {
      setError("");
      const response = await fetch("/api/open-platform/keys", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "读取开放平台密钥失败");
      setKeys(data.keys || []);
    } catch (loadError) {
      setError(loadError.message || "读取开放平台密钥失败");
    } finally {
      setKeysLoading(false);
    }
  }, []);

  const loadLogs = useCallback(async (page = 1, apiKeyId = "") => {
    setLogsLoading(true);
    try {
      setError("");
      const params = new URLSearchParams({ page: String(page), pageSize: "30" });
      if (apiKeyId) params.set("apiKeyId", apiKeyId);
      const response = await fetch(`/api/open-platform/logs?${params.toString()}`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "读取调用记录失败");
      setLogs(data.logs || []);
      setLogPagination(data.pagination || { page: 1, pageSize: 30, totalItems: 0, totalPages: 0 });
    } catch (loadError) {
      setError(loadError.message || "读取调用记录失败");
    } finally {
      setLogsLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setBaseUrl(window.location.origin);
      void loadKeys();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadKeys]);

  const openManagement = () => {
    setManagementView("keys");
    setManagementOpen(true);
    void loadKeys();
  };

  const showLogs = (apiKeyId = logKeyFilter) => {
    setManagementView("logs");
    setLogKeyFilter(apiKeyId);
    setManagementOpen(true);
    void loadLogs(1, apiKeyId);
  };

  const createKey = async () => {
    const name = newName.trim();
    if (!name) return;
    setCreating(true);
    try {
      const response = await fetch("/api/open-platform/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "创建失败");
      setCreatedKey(data.key);
      setShowCreate(false);
      setNewName("");
      await loadKeys();
    } catch (createError) {
      setError(createError.message || "创建失败");
    } finally {
      setCreating(false);
    }
  };

  const setKeyActive = async (key, isActive) => {
    const response = await fetch(`/api/open-platform/keys/${key.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isActive }),
    });
    if (response.ok) await loadKeys();
    else setError((await response.json()).error || "更新失败");
  };

  const deleteKey = async () => {
    if (!confirmDelete) return;
    const response = await fetch(`/api/open-platform/keys/${confirmDelete.id}`, { method: "DELETE" });
    setConfirmDelete(null);
    if (response.ok) setKeys((current) => current.filter((key) => key.id !== confirmDelete.id));
    else setError((await response.json()).error || "删除失败");
  };

  const activeCount = keys.filter((key) => key.isActive).length;
  const currentEndpoint = useMemo(() => ENDPOINTS.find((item) => item.id === selectedEndpoint) || ENDPOINTS[0], [selectedEndpoint]);
  const authHeader = "Authorization: Bearer smop_YOUR_OPEN_PLATFORM_KEY";

  return (
    <div className="flex min-w-0 flex-col gap-5 p-3 sm:p-4 lg:p-5">
      <DashboardHero
        eyebrow="OPEN PLATFORM · API REFERENCE"
        title="开放平台接口文档"
        description="面向服务端集成的开放接口参考。选择接口即可查看鉴权方式、请求参数、调用示例和响应结构。"
        icon="api"
        action={<Button icon="key" onClick={openManagement}>API Key 管理</Button>}
      >
        <Badge variant="success" dot>{ENDPOINTS.length} 个开放接口</Badge>
        <Badge variant="primary" icon="key">{keysLoading ? "读取密钥中" : `${activeCount} 个启用密钥`}</Badge>
        <Badge variant="default" icon="history">调用记录已启用</Badge>
      </DashboardHero>

      <section className="min-w-0 overflow-hidden rounded-2xl border border-border-subtle bg-surface shadow-[var(--shadow-soft)]">
        <div className="grid min-h-[720px] lg:grid-cols-[240px_minmax(0,1fr)]">
          <aside className="border-b border-border-subtle bg-bg/55 p-4 lg:border-b-0 lg:border-r lg:p-5">
            <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-text-muted">API Reference</p>
            <div className="mt-3 grid gap-1.5 sm:grid-cols-2 lg:grid-cols-1">
              {ENDPOINTS.map((endpoint) => (
                <button key={endpoint.id} type="button" onClick={() => setSelectedEndpoint(endpoint.id)} className={cn("flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left transition-colors", selectedEndpoint === endpoint.id ? "bg-primary/10 text-primary" : "text-text-muted hover:bg-surface hover:text-text-main")}>
                  <span className="material-symbols-outlined text-[17px]">{endpoint.icon}</span>
                  <span className="min-w-0 flex-1"><span className="block text-xs font-semibold">{endpoint.title}</span><span className="mt-0.5 block truncate font-mono text-[9px] opacity-70">{endpoint.path}</span></span>
                </button>
              ))}
            </div>

            <div className="mt-6 rounded-xl border border-border-subtle bg-surface p-3">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-text-muted">Base URL</p>
              <div className="mt-2 flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-text-main">{baseUrl}</code>
                <button type="button" onClick={() => copy(baseUrl, "base-url")} className="text-text-muted hover:text-primary" aria-label="复制 Base URL"><span className="material-symbols-outlined text-[15px]">{copied === "base-url" ? "check" : "content_copy"}</span></button>
              </div>
            </div>

            <div className="mt-3 rounded-xl border border-border-subtle bg-surface p-3">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-text-muted">Authentication</p>
              <code className="mt-2 block break-all font-mono text-[10px] leading-5 text-sky-500">{authHeader}</code>
              <button type="button" onClick={() => copy(authHeader, "auth-header")} className="mt-2 inline-flex items-center gap-1 text-[10px] text-text-muted hover:text-primary"><span className="material-symbols-outlined text-[13px]">{copied === "auth-header" ? "check" : "content_copy"}</span>复制请求头</button>
            </div>
          </aside>
          <div className="min-w-0 p-5 sm:p-7 lg:p-8">
            <EndpointDocumentation endpoint={currentEndpoint} baseUrl={baseUrl} copied={copied} copy={copy} />
          </div>
        </div>
      </section>

      <Drawer isOpen={managementOpen} onClose={() => setManagementOpen(false)} title="开放平台管理" width="xl" zIndex="z-40">
        <div className="space-y-5">
          <div className="flex rounded-xl border border-border-subtle bg-bg p-1">
            <button type="button" onClick={() => setManagementView("keys")} className={cn("flex flex-1 items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold transition-colors", managementView === "keys" ? "bg-surface text-primary shadow-[var(--shadow-soft)]" : "text-text-muted hover:text-text-main")}><span className="material-symbols-outlined text-[17px]">key</span>API Key</button>
            <button type="button" onClick={() => showLogs()} className={cn("flex flex-1 items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold transition-colors", managementView === "logs" ? "bg-surface text-primary shadow-[var(--shadow-soft)]" : "text-text-muted hover:text-text-main")}><span className="material-symbols-outlined text-[17px]">history</span>调用记录</button>
          </div>

          {error && <div className="rounded-lg border border-rose-500/20 bg-rose-500/[0.06] px-3 py-2 text-xs text-rose-500">{error}</div>}

          {managementView === "keys" ? (
            <section>
              <div className="flex items-start justify-between gap-3">
                <div><p className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-primary">Credentials</p><h3 className="mt-1 text-lg font-semibold text-text-main">API Key</h3><p className="mt-1 text-xs leading-5 text-text-muted">仅用于 `/open/v1/*`，完整密钥只在创建时显示一次。</p></div>
                <Button size="sm" icon="add" className="shrink-0 whitespace-nowrap" onClick={() => setShowCreate(true)}>创建密钥</Button>
              </div>

              <div className="mt-4">
                {keysLoading ? (
                  <div className="space-y-3">{[1, 2].map((item) => <div key={item} className="h-32 animate-pulse rounded-xl bg-bg" />)}</div>
                ) : keys.length === 0 ? (
                  <button type="button" onClick={() => setShowCreate(true)} className="flex w-full flex-col items-center rounded-xl border border-dashed border-border px-6 py-12 text-center transition-colors hover:border-primary/40 hover:bg-primary/[0.025]"><span className="material-symbols-outlined text-3xl text-primary">key_vertical</span><span className="mt-3 text-sm font-semibold text-text-main">创建第一个开放平台密钥</span><span className="mt-1 text-xs text-text-muted">创建后即可调用开放接口。</span></button>
                ) : (
                  <div className="grid gap-3 md:grid-cols-2">
                    {keys.map((key) => (
                      <div key={key.id} className={cn("rounded-xl border p-4 transition-colors", key.isActive ? "border-sky-500/15 bg-sky-500/[0.035]" : "border-border-subtle bg-bg/60 opacity-75")}>
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0"><div className="flex items-center gap-2"><p className="truncate text-sm font-semibold text-text-main">{key.name}</p><Badge size="sm" variant={key.isActive ? "success" : "default"}>{key.isActive ? "启用" : "停用"}</Badge></div><code className="mt-2 block truncate font-mono text-xs text-sky-500">{key.keyPrefix}••••••••••••••••</code></div>
                          <Toggle checked={key.isActive} onChange={(value) => void setKeyActive(key, value)} size="sm" ariaLabel={`${key.name} 状态`} />
                        </div>
                        <div className="mt-4 grid grid-cols-2 gap-3 border-t border-border-subtle pt-3 text-[11px]"><div><p className="text-text-muted">创建时间</p><p className="mt-1 text-text-main">{formatDate(key.createdAt)}</p></div><div><p className="text-text-muted">最近调用</p><p className="mt-1 text-text-main">{formatDate(key.lastUsedAt)}</p></div></div>
                        <div className="mt-3 flex items-center justify-between"><Badge size="sm" variant="primary" icon="visibility">usage:read</Badge><div className="flex items-center gap-1"><button type="button" onClick={() => showLogs(key.id)} className="flex h-7 items-center gap-1 rounded-lg px-2 text-[11px] text-text-muted hover:bg-primary/10 hover:text-primary"><span className="material-symbols-outlined text-[15px]">history</span>调用记录</button><button type="button" onClick={() => setConfirmDelete(key)} className="flex size-7 items-center justify-center rounded-lg text-text-muted hover:bg-rose-500/10 hover:text-rose-500" title="删除密钥" aria-label={`删除 ${key.name}`}><span className="material-symbols-outlined text-[17px]">delete</span></button></div></div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </section>
          ) : (
            <section>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                <div><p className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-primary">Audit Log</p><h3 className="mt-1 text-lg font-semibold text-text-main">调用记录</h3><p className="mt-1 text-xs leading-5 text-text-muted">记录有效开放平台密钥的接口、状态、耗时、来源 IP 和查询成员。</p></div>
                <div className="flex items-center gap-2"><select value={logKeyFilter} onChange={(event) => { const value = event.target.value; setLogKeyFilter(value); void loadLogs(1, value); }} className="h-9 min-w-[180px] rounded-lg border border-border-subtle bg-bg px-3 text-xs text-text-main outline-none focus:border-primary/40"><option value="">全部密钥</option>{keys.map((key) => <option key={key.id} value={key.id}>{key.name}</option>)}</select><button type="button" onClick={() => void loadLogs(logPagination.page, logKeyFilter)} className="flex size-9 items-center justify-center rounded-lg border border-border-subtle text-text-muted hover:bg-bg hover:text-primary" aria-label="刷新调用记录"><span className={cn("material-symbols-outlined text-[18px]", logsLoading && "animate-spin")}>refresh</span></button></div>
              </div>

              <div className="mt-4 overflow-hidden rounded-xl border border-border-subtle">
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[760px] border-collapse text-xs">
                    <thead className="bg-bg text-left font-mono text-[10px] uppercase tracking-wider text-text-muted"><tr><th className="px-3 py-2.5">时间 / 密钥</th><th className="px-3 py-2.5">请求</th><th className="px-3 py-2.5">状态</th><th className="px-3 py-2.5">耗时</th><th className="px-3 py-2.5">来源</th></tr></thead>
                    <tbody className="divide-y divide-border-subtle">
                      {logsLoading ? <tr><td colSpan={5} className="px-4 py-12 text-center text-text-muted">正在读取调用记录…</td></tr> : logs.length === 0 ? <tr><td colSpan={5} className="px-4 py-12 text-center text-text-muted">暂无调用记录</td></tr> : logs.map((log) => (
                        <tr key={log.id} className="align-top hover:bg-bg/45"><td className="px-3 py-3"><p className="whitespace-nowrap text-text-main">{formatDate(log.timestamp)}</p><p className="mt-1 font-mono text-[10px] text-text-muted">{log.keyName} · {log.keyPrefix}</p></td><td className="px-3 py-3"><div className="flex items-center gap-2"><Badge size="sm" variant="success">{log.method}</Badge><code className="font-mono text-[11px] text-text-main">{log.path}</code></div>{log.subjectUserId && <p className="mt-1 font-mono text-[10px] text-text-muted">userId: {log.subjectUserId}</p>}</td><td className="px-3 py-3"><Badge size="sm" variant={statusVariant(log.statusCode)}>{log.statusCode}</Badge></td><td className="px-3 py-3 font-mono text-text-main">{log.durationMs} ms</td><td className="px-3 py-3"><p className="font-mono text-[11px] text-text-main">{log.sourceIp || "未采集"}</p>{log.userAgent && <p className="mt-1 max-w-[220px] truncate text-[10px] text-text-muted" title={log.userAgent}>{log.userAgent}</p>}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="flex items-center justify-between border-t border-border-subtle bg-bg/40 px-3 py-2.5"><p className="text-[11px] text-text-muted">共 {logPagination.totalItems} 条 · 第 {logPagination.page}/{Math.max(logPagination.totalPages, 1)} 页</p><div className="flex gap-1"><Button size="xs" variant="ghost" disabled={logPagination.page <= 1 || logsLoading} onClick={() => void loadLogs(logPagination.page - 1, logKeyFilter)}>上一页</Button><Button size="xs" variant="ghost" disabled={logPagination.page >= logPagination.totalPages || logsLoading} onClick={() => void loadLogs(logPagination.page + 1, logKeyFilter)}>下一页</Button></div></div>
              </div>
            </section>
          )}
        </div>
      </Drawer>

      <Modal isOpen={showCreate} onClose={() => { setShowCreate(false); setNewName(""); }} title="创建开放平台密钥">
        <div className="space-y-4"><Input label="密钥名称" value={newName} onChange={(event) => setNewName(event.target.value)} placeholder="例如：企业 BI 使用报告" maxLength={80} autoFocus /><div className="rounded-xl border border-sky-500/15 bg-sky-500/[0.05] p-3 text-xs leading-5 text-text-muted"><b className="text-text-main">权限：</b>读取成员目录和使用分析报告。所有调用会进入开放平台调用记录。</div><div className="flex gap-2"><Button fullWidth loading={creating} disabled={!newName.trim()} onClick={() => void createKey()}>创建密钥</Button><Button fullWidth variant="ghost" onClick={() => setShowCreate(false)}>取消</Button></div></div>
      </Modal>

      <Modal isOpen={Boolean(createdKey)} onClose={() => setCreatedKey(null)} title="开放平台密钥已创建" closeOnOverlay={false}>
        <div className="space-y-4"><div className="rounded-xl border border-amber-500/20 bg-amber-500/[0.06] p-4"><p className="text-sm font-semibold text-text-main">请立即复制并安全保存</p><p className="mt-1 text-xs leading-5 text-text-muted">关闭窗口后无法再次查看完整密钥。数据库中只保存密钥哈希。</p></div><div className="rounded-xl border border-border-subtle bg-bg p-3"><code className="block break-all font-mono text-sm text-sky-500">{createdKey?.key}</code></div><Button fullWidth icon={copied === "created-open-key" ? "check" : "content_copy"} onClick={() => copy(createdKey?.key || "", "created-open-key")}>{copied === "created-open-key" ? "已复制" : "复制完整密钥"}</Button><Button fullWidth variant="ghost" onClick={() => setCreatedKey(null)}>我已保存</Button></div>
      </Modal>

      <ConfirmModal isOpen={Boolean(confirmDelete)} onClose={() => setConfirmDelete(null)} onConfirm={() => void deleteKey()} title="删除开放平台密钥" message={`确定删除“${confirmDelete?.name || "该密钥"}”吗？使用它的外部系统将立即无法访问开放接口；历史调用记录会保留。`} confirmText="删除" cancelText="取消" />
    </div>
  );
}
