"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Card, ConfirmModal, DashboardHero, Drawer, Input } from "@/shared/components";

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

// Nodes are grouped by these buckets instead of printing a status badge on every
// row: the group header carries the state, the rows carry the facts. 未注册 comes
// first because it is the only bucket that asks the operator to do something.
const STATUS_GROUPS = [
  { key: "unregistered", label: "未注册", icon: "pending", accent: "text-yellow-600 dark:text-yellow-400", empty: "当前没有待接入的 Mouse" },
  { key: "online", label: "在线", icon: "sensors", accent: "text-green-600 dark:text-green-400", empty: "当前没有在线的 Mouse" },
  { key: "offline", label: "离线", icon: "cloud_off", accent: "text-text-muted", empty: "当前没有离线的 Mouse" },
  { key: "disabled", label: "已禁用", icon: "block", accent: "text-red-600 dark:text-red-400", empty: "当前没有已禁用的 Mouse" },
];

const SETUP_STEPS = [
  { icon: "add_circle", title: "新建 Mouse", body: "给节点起个名字，系统为它生成专属访问 Token。" },
  { icon: "terminal", title: "在目标服务器执行", body: "复制生成的启动命令，用 Docker 跑起来。" },
  { icon: "sensors", title: "节点自动接入", body: "节点启动后主动连上 Spring，「未注册」变为「在线」。" },
];

// One command per node: the token in it *is* that node's identity, so the
// plaintext is shown once only, and re-issuing it invalidates the previous
// command. Nothing in it describes where the node lives — the agent dials out,
// so the host needs no public address and the container publishes no port.
function buildStartCommand({ token, springUrl }) {
  return [
    `SPRING_URL=${springUrl || "<Spring 地址>"} \\`,
    `MOUSE_TOKEN=${token} \\`,
    "docker compose -f docker-compose.mouse.yml up -d --build",
  ].join("\n");
}

export default function MousesClient() {
  const [mouses, setMouses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [reissueTarget, setReissueTarget] = useState(null);
  const [form, setForm] = useState({ name: "", springUrl: "" });
  const [created, setCreated] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [commandCopied, setCommandCopied] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [savingMouseId, setSavingMouseId] = useState("");

  const loadData = useCallback(async () => {
    setError("");
    try {
      const response = await fetch("/api/mouses", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "读取 Mouse 失败");
      setMouses(data.mouses || []);
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

  const openCreateDrawer = () => {
    setReissueTarget(null);
    setCreated(null);
    setCommandCopied(false);
    setError("");
    setForm({ name: "", springUrl: window.location.origin });
    setDrawerOpen(true);
  };

  // Re-issuing is the recovery path for a node whose command was lost before it
  // ever connected. It mints a fresh token, so the old command stops working.
  const openReissueDrawer = (mouse) => {
    setReissueTarget(mouse);
    setCreated(null);
    setCommandCopied(false);
    setError("");
    setForm({ name: mouse.name, springUrl: window.location.origin });
    setDrawerOpen(true);
  };

  // The plaintext token must not survive the drawer: closing it drops the secret
  // from memory, matching the "only visible once" promise in the copy.
  const closeDrawer = () => {
    setDrawerOpen(false);
    setReissueTarget(null);
    setCreated(null);
    setCommandCopied(false);
    setError("");
  };

  const submit = async () => {
    const name = form.name.trim();
    if (!name) {
      setError("请填写节点名称");
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      if (reissueTarget) {
        const rotateResponse = await fetch(`/api/mouses/${reissueTarget.id}/access-token`, { method: "POST" });
        const rotateData = await rotateResponse.json();
        if (!rotateResponse.ok) throw new Error(rotateData.error || "生成启动命令失败");
        setCreated({ mouse: rotateData.mouse, token: rotateData.token });
      } else {
        const response = await fetch("/api/mouses", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name }),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "新建 Mouse 失败");
        setCreated({ mouse: data.mouse, token: data.token });
      }
      setCommandCopied(false);
      await loadData();
    } catch (submitError) {
      setError(submitError.message);
    } finally {
      setSubmitting(false);
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

  const startCommand = created
    ? buildStartCommand({
        token: created.token,
        springUrl: form.springUrl.trim(),
      })
    : "";

  const copyCommand = async () => {
    await navigator.clipboard.writeText(startCommand);
    setCommandCopied(true);
  };

  const onlineCount = mouses.filter((mouse) => mouse.isOnline).length;
  const unregisteredCount = mouses.filter((mouse) => mouse.status === "unregistered").length;
  const statusGroups = STATUS_GROUPS.map((group) => {
    const items = mouses.filter((mouse) => mouse.status === group.key);
    return {
      ...group,
      items,
      boundTotal: items.reduce((sum, mouse) => sum + (mouse.boundAccountCount || 0), 0),
    };
  });

  return (
    <div className="flex min-w-0 flex-col gap-5 p-3 sm:p-4 lg:p-5">
      <DashboardHero
        eyebrow="EXECUTION NODES"
        title="Mouse 执行节点"
        description="Mouse 是可选的远程渠道执行节点。未绑定 Mouse 的渠道账号仍由 Spring 本机执行。"
        icon="device_hub"
        action={<Button icon="add" onClick={openCreateDrawer}>新建 Mouse</Button>}
      >
        <Badge size="md" variant="default" icon="dns">{mouses.length} 个节点</Badge>
        <Badge size="md" variant={onlineCount ? "success" : "default"} icon="sensors">{onlineCount} 个在线</Badge>
        <Badge size="md" variant={unregisteredCount ? "warning" : "default"} icon="pending">{unregisteredCount} 个未注册</Badge>
      </DashboardHero>

      {error && !drawerOpen && (
        <Card className="border-red-500/30 bg-red-500/5 p-3 text-sm text-red-500">{error}</Card>
      )}

      <Card title="Mouse 节点" subtitle={mouses.length ? "按接入状态分组；状态每 30 秒自动刷新。" : undefined}>
        {!mouses.length ? (
          <div className="flex min-h-[320px] flex-col items-center justify-center rounded-xl border border-dashed border-border bg-bg/20 px-6 py-10 text-center">
            <span className="material-symbols-outlined mb-3 text-[34px] text-[#647688]">device_hub</span>
            <h2 className="text-base font-semibold text-text-main">还没有 Mouse</h2>
            <p className="mt-1 max-w-md text-sm leading-6 text-text-muted">
              不接入 Mouse 时，所有渠道仍由 Spring 本机执行。新建一个 Mouse，把生成的启动命令贴到目标服务器上执行，它就会出现在这里。
            </p>
            <div className="mt-5">
              <Button size="field" icon="add" onClick={openCreateDrawer}>新建 Mouse</Button>
            </div>
            <div className="mt-6 grid w-full max-w-2xl gap-3 sm:grid-cols-3">
              {SETUP_STEPS.map((step, index) => (
                <div key={step.title} className="rounded-xl border border-border-subtle bg-bg/40 p-3 text-left">
                  <div className="flex items-center gap-2">
                    <span className="material-symbols-outlined text-[16px]! leading-none text-[#647688]">{step.icon}</span>
                    <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-text-muted">第 {index + 1} 步</span>
                  </div>
                  <p className="mt-2 text-sm font-medium text-text-main">{step.title}</p>
                  <p className="mt-1 text-xs leading-5 text-text-muted">{step.body}</p>
                </div>
              ))}
            </div>
          </div>
        ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px] text-left text-sm">
            <thead className="text-xs uppercase tracking-wide text-text-muted">
              <tr className="border-b border-border-subtle">
                <th className="px-4 py-2">节点</th>
                <th className="px-4 py-2">绑定账号</th>
                <th className="px-4 py-2">最后心跳</th>
                <th className="px-4 py-2">版本</th>
                <th className="px-4 py-2 text-right">操作</th>
              </tr>
            </thead>
            {statusGroups.map((group) => (
                <tbody key={group.key}>
                  <tr className="border-b border-border-subtle bg-bg/40">
                    <td colSpan="5" className="px-4 py-2">
                      <div className="flex items-center gap-2">
                        <span className={`material-symbols-outlined text-[14px]! leading-none ${group.accent}`}>{group.icon}</span>
                        <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-text-muted">{group.label}</span>
                        <span className="rounded-full bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-text-muted">{group.items.length}</span>
                        {group.boundTotal > 0 && (
                          <span className="text-[11px] text-text-muted">· 承载 {group.boundTotal} 个账号</span>
                        )}
                      </div>
                    </td>
                  </tr>
                  {group.items.map((mouse) => (
                    <tr key={mouse.id} className="border-b border-border-subtle last:border-b-0">
                      <td className="px-4 py-2.5">
                        <div className="font-medium text-text-main">{mouse.name}</div>
                        <div className="font-mono text-xs text-text-muted">{mouse.clientId}</div>
                      </td>
                      <td className="px-4 py-2.5">
                        {mouse.boundAccountCount
                          ? <span className="text-text-main">{mouse.boundAccountCount} 个账号</span>
                          : <span className="text-text-muted">未绑定</span>}
                      </td>
                      <td className="px-4 py-2.5 text-text-muted" title={formatDate(mouse.lastHeartbeatAt)}>{formatRelative(mouse.lastHeartbeatAt)}</td>
                      <td className="px-4 py-2.5 text-text-muted">{mouse.version || "—"}</td>
                      <td className="px-4 py-2.5 text-right">
                        <div className="inline-flex gap-1">
                          {mouse.status === "unregistered" ? (
                            <Button size="sm" variant="secondary" icon="terminal" onClick={() => openReissueDrawer(mouse)}>
                              启动命令
                            </Button>
                          ) : (
                            <Button size="sm" variant="secondary" loading={savingMouseId === mouse.id} onClick={() => toggleMouse(mouse)}>
                              {mouse.status === "disabled" ? "启用" : "禁用"}
                            </Button>
                          )}
                          <Button size="sm" variant="danger" onClick={() => setConfirmDelete(mouse)}>删除</Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                  {!group.items.length && (
                    <tr><td colSpan="5" className="px-4 py-3 text-center text-xs text-text-muted">{group.empty}</td></tr>
                  )}
                </tbody>
              ))}
          </table>
        </div>
        )}
      </Card>

      <Drawer
        isOpen={drawerOpen}
        onClose={closeDrawer}
        title={created ? "启动命令" : reissueTarget ? "重新生成启动命令" : "新建 Mouse"}
        width="xl"
        footer={created ? (
          <>
            <Button variant="secondary" onClick={closeDrawer}>完成</Button>
            <Button icon={commandCopied ? "check" : "content_copy"} onClick={copyCommand}>
              {commandCopied ? "已复制" : "复制启动命令"}
            </Button>
          </>
        ) : (
          <>
            <Button variant="secondary" onClick={closeDrawer}>取消</Button>
            <Button onClick={submit} loading={submitting}>{reissueTarget ? "生成启动命令" : "新建并生成命令"}</Button>
          </>
        )}
      >
        {!created ? (
          <div className="flex flex-col gap-5">
            <p className="text-sm leading-6 text-text-muted">
              为节点命名后，系统会立即为它生成专属访问 Token，并给出可复制的 Docker 启动命令。节点在第一次连上 Spring 之前显示为「未注册」。
            </p>
            <Input
              label="节点名称"
              placeholder="例如：tokyo-edge-01"
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
              disabled={Boolean(reissueTarget)}
              hint={reissueTarget ? "名称创建后不可修改，需要改名请删除后重建。" : "只用于在列表里识别这个节点。"}
            />
            <Input
              label="Spring 地址"
              placeholder="http://spring.example.com"
              value={form.springUrl}
              onChange={(event) => setForm({ ...form, springUrl: event.target.value })}
              hint="目标服务器能访问到的 Spring 地址。节点主动向外连接，不需要公网 IP，也不需要映射任何端口。"
            />
            {error && <p className="text-sm text-red-500">{error}</p>}
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="rounded-xl border border-[#38bdf8]/30 bg-[#38bdf8]/[0.06] p-4">
              <div className="flex items-center gap-2 text-sm font-medium text-[#7dd3fc]">
                <span className="material-symbols-outlined text-[18px]!">key</span>
                {created.mouse.name} 已创建，把命令贴到目标服务器上执行
              </div>
              <p className="mt-2 text-xs leading-5 text-[#7dd3fc]/80">
                访问 Token 只在这里显示一次，关闭后无法再次查看；丢失时回到列表点「启动命令」重新生成，旧命令随即失效。
              </p>
            </div>
            <pre className="max-w-full overflow-x-auto rounded-lg border border-border-subtle bg-bg/40 px-3 py-2 text-left font-mono text-xs leading-5 text-text-main">
              {startCommand}
            </pre>
            <p className="text-xs leading-5 text-text-muted">
              需在检出本仓库的机器上执行：agent 镜像由 <span className="font-mono">Dockerfile.mouse</span> 本地构建，未发布到镜像仓库。
            </p>
          </div>
        )}
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
