"use client";

import PropTypes from "prop-types";
import { useState } from "react";
import Card from "@/shared/components/Card";
import UsageChart from "./UsageChart";
import PersonAnalysisReport from "./PersonAnalysisReport";
import UsageDetailsDrawer from "./UsageDetailsDrawer";
import { formatBytes } from "@/shared/utils/formatBytes";

const PERIOD_LABELS = ["凌晨", "清晨", "上午", "下午", "傍晚", "夜间"];
const WEEKDAY_LABELS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];

const fmt = (value) => new Intl.NumberFormat("zh-CN").format(value || 0);
const fmtCost = (value) => `$${Number(value || 0).toFixed(2)}`;
const fmtTokens = (value) => {
  const amount = value || 0;
  if (amount >= 1_000_000) return `${(amount / 1_000_000).toFixed(1)}M`;
  if (amount >= 1_000) return `${(amount / 1_000).toFixed(1)}K`;
  return fmt(amount);
};


function providerIdFromModelRow(item) {
  return item.key?.match(/ \(([^()]+)\)$/)?.[1] || "";
}

function formatDateRange(timeRange) {
  if (!timeRange?.startDate || !timeRange?.endDate) return "当前统计周期";
  const format = (value) => new Intl.DateTimeFormat("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date(value));
  return `${format(timeRange.startDate)} — ${format(timeRange.endDate)}`;
}

function formatGeo(geo) {
  if (!geo) return "GeoIP 待解析";
  const location = geo.label || [geo.city, geo.region, geo.country].filter(Boolean).join(" · ");
  const network = [geo.organization, geo.asn ? `AS${geo.asn}` : null].filter(Boolean).join(" · ");
  return [location, network].filter(Boolean).join(" · ") || "GeoIP 无匹配";
}

function getRows(data, limit = 6, sortBy = "requests") {
  return Object.entries(data || {})
    .map(([key, rawItem]) => {
      const item = rawItem && typeof rawItem === "object" ? rawItem : {};
      return {
      key,
      ...item,
      totalTokens: (Number(item.promptTokens) || 0) + (Number(item.completionTokens) || 0),
      };
    })
    .sort((a, b) => (b[sortBy] || 0) - (a[sortBy] || 0))
    .slice(0, limit);
}

function topEntry(data) {
  return getRows(data, 1)[0] || null;
}

function topIndex(values = []) {
  if (!values.length || !values.some(Boolean)) return -1;
  return values.reduce((best, value, index) => value > values[best] ? index : best, 0);
}

function Sparkline({ points = [], color = "#2563eb" }) {
  const values = points.length ? points : [0, 0];
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const range = Math.max(max - min, 1);
  const coords = values.map((value, index) => {
    const x = values.length === 1 ? 50 : (index / (values.length - 1)) * 100;
    const y = 32 - ((value - min) / range) * 28;
    return `${x},${y}`;
  }).join(" ");

  return (
    <svg viewBox="0 0 100 36" aria-hidden="true" className="h-10 w-24 overflow-visible">
      <polyline points={coords} fill="none" stroke={color} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={coords.split(" ").at(-1)?.split(",")[0]} cy={coords.split(" ").at(-1)?.split(",")[1]} r="3" fill={color} />
    </svg>
  );
}

Sparkline.propTypes = {
  points: PropTypes.arrayOf(PropTypes.number),
  color: PropTypes.string,
};

function MetricCard({ icon, label, value, detail, points, tone, color }) {
  return (
    <Card className="group relative min-w-0 overflow-hidden p-4" padding="none">
      <div className={`absolute inset-x-0 top-0 h-[2px] ${tone}`} />
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-text-muted">
            <span className={`material-symbols-outlined grid size-8 place-items-center rounded-lg text-[18px] ${tone} bg-opacity-10`}>
              {icon}
            </span>
            <span className="text-[11px] font-bold uppercase tracking-[0.12em]">{label}</span>
          </div>
          <p className="mt-3 truncate text-2xl font-bold tracking-tight text-text-main">{value}</p>
          <p className="mt-1 truncate text-[11px] text-text-muted">{detail}</p>
        </div>
        <Sparkline points={points} color={color} />
      </div>
    </Card>
  );
}

MetricCard.propTypes = {
  icon: PropTypes.string.isRequired,
  label: PropTypes.string.isRequired,
  value: PropTypes.string.isRequired,
  detail: PropTypes.string.isRequired,
  points: PropTypes.arrayOf(PropTypes.number),
  tone: PropTypes.string.isRequired,
  color: PropTypes.string.isRequired,
};

function PanelHeader({ icon, eyebrow, title, description, action }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border pb-3">
      <div className="flex min-w-0 items-start gap-3">
        <span className="material-symbols-outlined grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-[20px] text-primary">{icon}</span>
        <div className="min-w-0">
          <p className="text-[10px] font-bold uppercase tracking-[0.15em] text-primary">{eyebrow}</p>
          <h2 className="mt-0.5 text-base font-semibold text-text-main">{title}</h2>
          {description ? <p className="mt-1 text-xs text-text-muted">{description}</p> : null}
        </div>
      </div>
      {action}
    </div>
  );
}

PanelHeader.propTypes = {
  icon: PropTypes.string.isRequired,
  eyebrow: PropTypes.string.isRequired,
  title: PropTypes.string.isRequired,
  description: PropTypes.string,
  action: PropTypes.node,
};

function RankingPanel({
  icon,
  title,
  eyebrow,
  action,
  rows,
  getLabel,
  getSubtitle,
  color = "bg-primary",
  emptyMessage,
  valueMode = "requests",
  scrollable = false,
  visibleRows,
  className = "",
  onSelect,
}) {
  const maxValue = Math.max(...rows.map((item) => item[valueMode] || 0), 1);
  const fixedViewport = Number.isInteger(visibleRows) && visibleRows > 0;
  const contentClassName = fixedViewport
    ? "mt-2 h-[320px] min-h-[320px] divide-y divide-border/60 overflow-y-auto pr-1 custom-scrollbar"
    : `mt-2 flex-1 divide-y divide-border/60 ${scrollable ? "min-h-0 overflow-y-auto pr-1 custom-scrollbar" : ""}`;

  return (
    <Card className={`flex min-w-0 flex-col ${className}`} padding="sm">
      <PanelHeader icon={icon} eyebrow={eyebrow} title={title} action={action} />
      {!rows.length ? (
        <p className={`text-center text-xs text-text-muted ${fixedViewport ? "flex h-[320px] items-center justify-center" : "py-9"}`}>
          {emptyMessage || "当前时段暂无统计数据。"}
        </p>
      ) : (
        <div className={contentClassName}>
          {rows.map((item, index) => {
            const value = item[valueMode] || 0;
            const content = <>
              <div className="flex items-center gap-3">
                <span className={`grid size-7 shrink-0 place-items-center rounded-md text-[11px] font-black ${index < 3 ? "bg-primary/10 text-primary" : "bg-bg-subtle text-text-muted"}`}>
                  {String(index + 1).padStart(2, "0")}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-text-main" title={getLabel(item)}>{getLabel(item)}</p>
                  <p className="truncate text-[11px] text-text-muted" title={getSubtitle?.(item)}>{getSubtitle?.(item)}</p>
                </div>
                <div className="flex shrink-0 items-center gap-1.5 text-right">
                  <div>
                    <p className="text-xs font-bold text-text-main">{valueMode === "totalTokens" ? fmtTokens(value) : fmt(value)}</p>
                    <p className="text-[10px] text-text-muted">{valueMode === "totalTokens" ? "Token" : "模型调用"}</p>
                  </div>
                  {onSelect && <span className="material-symbols-outlined text-[17px] text-text-muted transition-colors group-hover:text-primary">arrow_forward</span>}
                </div>
              </div>
              <div className="ml-10 mt-2 h-1 overflow-hidden rounded-full bg-bg-subtle">
                <div className={`h-full rounded-full ${color}`} style={{ width: `${Math.max(3, (value / maxValue) * 100)}%` }} />
              </div>
            </>;
            return onSelect ? (
              <button key={item.key} type="button" onClick={() => onSelect(item)} title={`查看 ${getLabel(item)} 的使用明细`} className="group block w-full rounded-lg py-2.5 text-left transition-colors hover:bg-primary/[0.045] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40">
                {content}
              </button>
            ) : <div key={item.key} className="py-2.5">{content}</div>;
          })}
        </div>
      )}
    </Card>
  );
}

RankingPanel.propTypes = {
  icon: PropTypes.string.isRequired,
  action: PropTypes.node,
  title: PropTypes.string.isRequired,
  eyebrow: PropTypes.string.isRequired,
  rows: PropTypes.array.isRequired,
  getLabel: PropTypes.func.isRequired,
  getSubtitle: PropTypes.func,
  color: PropTypes.string,
  emptyMessage: PropTypes.string,
  valueMode: PropTypes.oneOf(["requests", "totalTokens"]),
  scrollable: PropTypes.bool,
  visibleRows: PropTypes.number,
  className: PropTypes.string,
  onSelect: PropTypes.func,
};

function PersonFocusSummary({ person }) {
  const topModel = topEntry(person.models);
  const topApp = topEntry(person.apps);
  const topIp = topEntry(person.sourceIps);
  const peakPeriod = topIndex(person.periods);
  const peakWeekday = topIndex(person.weekdays);
  const items = [
    { icon: "person", label: "正在查看", value: person.keyName },
    { icon: "model_training", label: "常用模型", value: topModel?.key || "暂无" },
    { icon: "schedule", label: "使用时段", value: `${peakWeekday >= 0 ? WEEKDAY_LABELS[peakWeekday] : "—"} · ${peakPeriod >= 0 ? PERIOD_LABELS[peakPeriod] : "—"}` },
    { icon: "devices", label: "来源应用", value: topApp?.key || "未识别" },
    { icon: "lan", label: "来源 IP", value: topIp?.key || "未采集", mono: true },
  ];

  return (
    <div className="mt-3 flex flex-wrap gap-2">
      {items.map((item) => (
        <span key={item.label} className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-primary/15 bg-surface/80 px-2.5 py-1.5 text-xs">
          <span className="material-symbols-outlined text-[15px] text-primary">{item.icon}</span>
          <span className="text-text-muted">{item.label}</span>
          <span className={`max-w-[220px] truncate font-semibold text-text-main ${item.mono ? "font-mono" : ""}`} title={item.value}>{item.value}</span>
        </span>
      ))}
    </div>
  );
}

PersonFocusSummary.propTypes = { person: PropTypes.object.isRequired };

function formatCallTime(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).format(new Date(value));
}

function RecentCallDetailsTable({ rows, totalCalls }) {
  return (
    <Card className="min-w-0 overflow-hidden" padding="sm">
      <PanelHeader
        icon="receipt_long"
        eyebrow="CALL DETAILS"
        title="模型调用明细"
        description="当前筛选时间范围内的实际模型调用，按最近时间倒序展示。"
        action={<span className="rounded-md bg-primary/10 px-2.5 py-1 text-xs font-semibold text-primary">共 {fmt(totalCalls)} 条 · 展示最近 {fmt(rows.length)} 条</span>}
      />
      {!rows.length ? (
        <p className="py-10 text-center text-sm text-text-muted">当前筛选时间范围内暂无模型调用记录。</p>
      ) : (
        <div className="mt-3 max-h-[500px] overflow-auto rounded-lg border border-border custom-scrollbar">
          <table className="w-full min-w-[1380px] border-collapse text-xs">
            <thead className="sticky top-0 z-10 border-b border-border bg-surface-2 shadow-[0_1px_0_var(--color-border)] text-[10px] font-bold uppercase tracking-[0.08em] text-text-muted">
              <tr>
                <th className="px-3 py-2.5 text-left">调用时间</th>
                <th className="px-3 py-2.5 text-left">使用人</th>
                <th className="px-3 py-2.5 text-left">模型</th>
                <th className="px-3 py-2.5 text-left">来源</th>
                <th className="px-3 py-2.5 text-right">输入 / 输出</th>
                <th className="px-3 py-2.5 text-right">总 Token</th>
                <th className="px-3 py-2.5 text-right">上传流量</th>
                <th className="px-3 py-2.5 text-right">下载流量</th>
                <th className="px-3 py-2.5 text-right">总流量</th>
                <th className="px-3 py-2.5 text-right">成本</th>
                <th className="px-3 py-2.5 text-left">端点</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {rows.map((row) => (
                <tr key={row.id} className="transition-colors hover:bg-primary/[0.025]">
                  <td className="whitespace-nowrap px-3 py-2.5 font-mono text-[11px] text-text-muted">{formatCallTime(row.timestamp)}</td>
                  <td className="max-w-[130px] px-3 py-2.5">
                    <p className="truncate font-semibold text-text-main" title={row.keyName}>{row.keyName}</p>
                  </td>
                  <td className="max-w-[190px] px-3 py-2.5">
                    <p className="truncate font-semibold text-text-main" title={row.model}>{row.model}</p>
                    <p className="mt-0.5 truncate text-[10px] text-text-muted">{row.provider}</p>
                  </td>
                  <td className="max-w-[180px] px-3 py-2.5">
                    <p className="truncate font-medium text-text-main" title={row.appName}>{row.appName}</p>
                    <p className="mt-0.5 truncate font-mono text-[10px] text-text-muted" title={row.sourceIp}>{row.sourceIp || "IP 未采集"}</p>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-right">
                    <span className="text-indigo-500">{fmtTokens(row.promptTokens)}</span>
                    <span className="px-1 text-text-muted">/</span>
                    <span className="text-emerald-500">{fmtTokens(row.completionTokens)}</span>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-right font-semibold text-primary">{fmtTokens(row.totalTokens)}</td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-right font-mono text-indigo-600">{formatBytes(row.requestBytes)}</td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-right font-mono text-emerald-600">{formatBytes(row.responseBytes)}</td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-right font-semibold text-cyan-600">{formatBytes(row.totalBytes)}</td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-right font-semibold text-warning">{fmtCost(row.cost)}</td>
                  <td className="max-w-[170px] px-3 py-2.5 font-mono text-[11px] text-text-muted" title={row.endpoint}>{row.endpoint}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

RecentCallDetailsTable.propTypes = {
  rows: PropTypes.array.isRequired,
  totalCalls: PropTypes.number.isRequired,
};

function CaptureStatus({ capture, hasIpData, hasAppData }) {
  const isDisabled = capture?.mode === "disabled";
  const isDevelopment = capture?.mode === "development";
  const geoipReady = capture?.geoip?.cityAvailable || capture?.geoip?.asnAvailable;
  return (
    <div className={`flex flex-wrap items-start gap-3 rounded-xl border px-4 py-3 ${isDisabled ? "border-amber-500/25 bg-amber-500/[0.06]" : "border-emerald-500/20 bg-emerald-500/[0.05]"}`}>
      <span className={`material-symbols-outlined text-[21px] ${isDisabled ? "text-amber-600" : "text-emerald-600"}`}>
        {isDisabled ? "warning" : "verified_user"}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-text-main">
          {isDisabled ? "可信来源 IP 采集未启用" : isDevelopment ? "开发模式 IP 采集已启用" : "可信来源 IP 采集已启用"}
        </p>
        <p className="mt-1 text-xs leading-5 text-text-muted">
          {isDisabled
            ? "生产环境需要通过 custom-server.js（npm start）启动，由服务端写入不可伪造的 x-sm-real-ip。"
            : `IP 数据${hasIpData ? "已进入统计" : "尚无新记录"}，应用识别${hasAppData ? "已有结果" : "会从 X-App-Name / X-Title / User-Agent 自动补充"}。`}
          <span className="ml-1 font-medium text-text-main">
            {geoipReady ? "GeoLite2 数据库已加载，后续请求会记录地理位置与 ASN。" : "GeoIP 包只负责把已取得的 IP 转为地区；请将 GeoLite2-City.mmdb（可选 GeoLite2-ASN.mmdb）映射到 /app/data/geoip。"}
          </span>
        </p>
      </div>
    </div>
  );
}

CaptureStatus.propTypes = {
  capture: PropTypes.object,
  hasIpData: PropTypes.bool.isRequired,
  hasAppData: PropTypes.bool.isRequired,
};

export default function UsageBreakdownGrid({ stats, timeRange, apiKeyId, chartRefreshToken = null }) {
  const [detailsSelection, setDetailsSelection] = useState(null);
  const providers = getRows(stats.byProvider, Number.MAX_SAFE_INTEGER, "totalTokens");
  const models = getRows(stats.byModel, Number.MAX_SAFE_INTEGER, "totalTokens");
  const sourceIps = getRows(stats.bySourceIp, Number.MAX_SAFE_INTEGER);
  const apps = getRows(stats.byApp, Number.MAX_SAFE_INTEGER);
  const people = getRows(stats.byUser, Number.MAX_SAFE_INTEGER, "totalTokens");
  const totalTokens = (stats.totalPromptTokens || 0) + (stats.totalCompletionTokens || 0);
  const recent = Array.isArray(stats.last10Minutes) ? stats.last10Minutes : [];
  const topPerson = people[0];
  const topModel = models[0];
  const focusPerson = apiKeyId ? people.find((person) => person.userId === apiKeyId) || people[0] : people.length === 1 ? people[0] : null;
  const detailFilterOptions = {
    providers: providers.map((item) => item.key).filter(Boolean),
    models: models.map((item) => item.rawModel || item.key).filter(Boolean),
    people: people.map((item) => ({ id: item.userId || item.key, label: item.keyName || item.apiKeyMasked || item.key })).filter((item) => item.id),
    apps: apps.map((item) => item.appName || item.key).filter(Boolean),
    sourceIps: sourceIps.map((item) => item.sourceIp || item.key).filter(Boolean),
  };
  const openDetails = (filters, subject) => setDetailsSelection({
    key: `${subject}-${Date.now()}`,
    subject,
    filters: { startDate: timeRange?.startDate || "", endDate: timeRange?.endDate || "", ...(apiKeyId ? { apiKeyId } : {}), ...filters },
  });

  return (
    <section aria-label="使用看板" className="flex min-w-0 flex-col gap-4">
      <div className="relative overflow-hidden rounded-xl border border-primary/15 bg-primary/[0.045] px-4 py-4 sm:px-5">
        <div aria-hidden="true" className="absolute -right-16 -top-24 size-56 rounded-full bg-primary/10 blur-3xl" />
        <div className="relative flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-primary">USAGE INTELLIGENCE</p>
            <h1 className="mt-1 text-xl font-bold tracking-tight text-text-main">{formatDateRange(timeRange)}</h1>
            <p className="mt-1 text-xs text-text-muted">以使用人为主线，观察模型偏好、访问节奏、Token 消耗与请求来源。</p>
            {focusPerson ? <PersonFocusSummary person={focusPerson} /> : null}
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2 text-xs">
            <span className="rounded-md border border-border bg-surface px-2.5 py-1.5 text-text-muted"><b className="text-text-main">{fmt(people.length)}</b> 使用人</span>
            <span className="rounded-md border border-border bg-surface px-2.5 py-1.5 text-text-muted"><b className="text-text-main">{fmt(models.length)}</b> 模型</span>
            <span className="rounded-md border border-border bg-surface px-2.5 py-1.5 text-text-muted"><b className="text-text-main">{fmt(apps.length)}</b> 应用</span>
            <span className="rounded-md border border-border bg-surface px-2.5 py-1.5 text-text-muted"><b className="text-text-main">{fmt(sourceIps.length)}</b> IP</span>
            <button
              type="button"
              onClick={() => openDetails({}, "当前筛选范围")}
              className="rounded-md border border-border bg-surface px-2.5 py-1.5 text-text-muted transition-colors hover:border-primary/35 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            >
              明细
            </button>
          </div>
        </div>
      </div>

      <CaptureStatus capture={stats.sourceCapture} hasIpData={sourceIps.length > 0} hasAppData={apps.some((item) => item.appName !== "未知客户端")} />

      <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
        <MetricCard icon="send" label="模型调用次数" value={fmt(stats.totalRequests)} detail={`Top 使用人：${topPerson?.keyName || "暂无"}`} points={recent.map((item) => item.requests || 0)} tone="bg-sky-500 text-sky-600" color="#0ea5e9" />
        <MetricCard icon="input" label="输入 Token" value={fmtTokens(stats.totalPromptTokens)} detail={`缓存命中 ${fmtTokens(stats.totalCachedTokens)}`} points={recent.map((item) => item.promptTokens || 0)} tone="bg-indigo-500 text-indigo-600" color="#6366f1" />
        <MetricCard icon="output" label="输出 Token" value={fmtTokens(stats.totalCompletionTokens)} detail={`总消耗 ${fmtTokens(totalTokens)}`} points={recent.map((item) => item.completionTokens || 0)} tone="bg-emerald-500 text-emerald-600" color="#10b981" />
        <MetricCard icon="network_check" label="数据流量" value={formatBytes(stats.totalTrafficBytes)} detail={`↑ ${formatBytes(stats.totalRequestBytes)} · ↓ ${formatBytes(stats.totalResponseBytes)}`} points={recent.map((item) => item.trafficBytes || 0)} tone="bg-cyan-500 text-cyan-600" color="#0891b2" />
        <MetricCard icon="paid" label="预估成本" value={fmtCost(stats.totalCost)} detail={`Top 模型：${topModel?.rawModel || topModel?.key || "暂无"}`} points={recent.map((item) => item.cost || 0)} tone="bg-amber-500 text-amber-600" color="#f59e0b" />
        <MetricCard icon="hub" label="活跃路由" value={apiKeyId ? "—" : fmt(stats.activeRequests?.length)} detail={apiKeyId ? "实时队列不保留 API Key" : `识别应用 ${fmt(apps.length)} 个`} points={recent.map((item) => item.requests || 0)} tone="bg-violet-500 text-violet-600" color="#8b5cf6" />
      </div>

      <div className="grid min-w-0 gap-5 xl:grid-cols-[minmax(0,1.65fr)_minmax(320px,0.75fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          <UsageChart
            timeRange={timeRange}
            apiKeyId={apiKeyId}
            refreshToken={chartRefreshToken}
            title="Token 与成本趋势"
            className="xl:h-[500px]"
          />

          <div className="grid min-w-0 gap-3 lg:grid-cols-2 2xl:grid-cols-3">
            <RankingPanel
              icon="devices"
              eyebrow="APP SOURCES"
              title="模型调用来源应用排行"
              rows={apps}
              getLabel={(item) => item.appName || item.key}
              getSubtitle={(item) => `${fmtTokens(item.totalTokens)} Token · ${fmtCost(item.cost)}`}
              visibleRows={5}
              color="bg-violet-500"
              scrollable
              className="lg:h-[420px]"
              onSelect={(item) => openDetails({ appName: item.appName || item.key }, `来源应用：${item.appName || item.key}`)}
            />
            <RankingPanel
              icon="lan"
              eyebrow="NETWORK FOOTPRINT"
              title="来源 IP 排行"
              rows={sourceIps}
              getLabel={(item) => item.sourceIp || item.key}
              getSubtitle={(item) => `${formatGeo(item.sourceGeo)} · ${fmtTokens(item.totalTokens)} Token`}
              visibleRows={5}
              color="bg-sky-500"
              emptyMessage="暂无来源 IP。请确认生产环境由 custom-server.js 启动，并在启用后产生新请求。"
              scrollable
              className="lg:h-[420px]"
              onSelect={(item) => openDetails({ sourceIp: item.sourceIp || item.key }, `来源 IP：${item.sourceIp || item.key}`)}
            />
            <RankingPanel
              icon="dns"
              eyebrow="PROVIDER MIX"
              title="提供商消耗排行"
              rows={providers}
              getLabel={(item) => item.key || "未知提供商"}
              getSubtitle={(item) => `${fmt(item.requests)} 次调用 · ${fmtCost(item.cost)}`}
              visibleRows={5}
              color="bg-emerald-500"
              valueMode="totalTokens"
              scrollable
              className="lg:h-[420px]"
              onSelect={(item) => openDetails({ provider: item.key }, `提供商：${item.key}`)}
            />
          </div>
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <RankingPanel
            icon="groups"
            eyebrow="PEOPLE RANKING"
            title="人员使用排行榜"
            action={<PersonAnalysisReport stats={stats} timeRange={timeRange} />}
            rows={people}
            getLabel={(item) => item.keyName || item.apiKeyMasked || item.key}
            getSubtitle={(item) => {
              const modelCount = Object.keys(item.models || {}).length;
              return `使用 ${fmt(modelCount)} 个模型 · ${fmt(item.requests)} 次调用 · ${fmtCost(item.cost)}`;
            }}
            color="bg-violet-500"
            valueMode="totalTokens"
            emptyMessage="当前筛选范围内暂无使用人数据。"
            scrollable
            className="xl:h-[500px]"
            onSelect={(item) => openDetails({ apiKeyId: item.userId || item.key }, `使用人：${item.keyName || item.apiKeyMasked || item.key}`)}
          />

          <RankingPanel
            icon="model_training"
            eyebrow="MODEL RANKING"
            title="模型消耗排行"
            rows={models}
            getLabel={(item) => item.rawModel || item.key}
            getSubtitle={(item) => `${item.provider || "未标记提供商"} · ${fmt(item.requests)} 次调用 · ${fmtCost(item.cost)}`}
            visibleRows={5}
            color="bg-primary"
            valueMode="totalTokens"
            scrollable
            className="lg:h-[420px]"
            onSelect={(item) => openDetails({ model: item.rawModel || item.key, provider: providerIdFromModelRow(item) }, `模型：${item.rawModel || item.key}`)}
          />
        </div>
      </div>

      <RecentCallDetailsTable rows={stats.recentCallDetails || []} totalCalls={stats.totalRequests || 0} />

      {detailsSelection && <UsageDetailsDrawer
        key={detailsSelection.key}
        isOpen={Boolean(detailsSelection)}
        onClose={() => setDetailsSelection(null)}
        subject={detailsSelection.subject}
        initialFilters={detailsSelection.filters}
        filterOptions={detailFilterOptions}
      />}
    </section>
  );
}

UsageBreakdownGrid.propTypes = {
  stats: PropTypes.object.isRequired,
  timeRange: PropTypes.shape({ startDate: PropTypes.string, endDate: PropTypes.string }),
  apiKeyId: PropTypes.string,
  chartRefreshToken: PropTypes.number,
};
