"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import PropTypes from "prop-types";
import { cn } from "@/shared/utils/cn";
import { buildPersonUsageAnalysisFromStats } from "@/shared/utils/personUsageAnalysis";
import Card from "@/shared/components/Card";
import Drawer from "@/shared/components/Drawer";

const WEEKDAY_LABELS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
const PERIOD_LABELS = ["凌晨", "清晨", "上午", "下午", "傍晚", "夜间"];
const SESSION_GAP_MINUTES = 30;

const fmt = (value) => new Intl.NumberFormat("zh-CN").format(value || 0);
const fmtCost = (value) => `$${Number(value || 0).toFixed(2)}`;
const fmtPct = (value, digits = 1) => `${((value || 0) * 100).toFixed(digits)}%`;
const fmtTokens = (value) => {
  const amount = value || 0;
  if (amount >= 1_000_000) return `${(amount / 1_000_000).toFixed(1)}M`;
  if (amount >= 1_000) return `${(amount / 1_000).toFixed(1)}K`;
  return fmt(amount);
};

function formatDateRange(timeRange) {
  if (!timeRange?.startDate || !timeRange?.endDate) return "当前统计周期";
  const format = (value) => new Intl.DateTimeFormat("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date(value));
  return `${format(timeRange.startDate)} — ${format(timeRange.endDate)}`;
}

function formatDateTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).format(date);
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return `${Math.max(1, Math.floor(ms / 1000))} 秒`;
  if (minutes < 60) return `${minutes} 分`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  if (hours < 24) return restMinutes ? `${hours} 小时 ${restMinutes} 分` : `${hours} 小时`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours ? `${days} 天 ${restHours} 小时` : `${days} 天`;
}

function topEntries(data, limit = 4, key = "totalTokens") {
  return Object.entries(data || {})
    .map(([name, item]) => ({ name, ...(typeof item === "object" ? item : {}), value: item?.[key] || item?.totalTokens || item?.requests || 0 }))
    .sort((a, b) => b.value - a.value)
    .slice(0, limit);
}

function topIndex(values = []) {
  if (!values.length || !values.some(Boolean)) return -1;
  return values.reduce((best, value, index) => (value > values[best] ? index : best), 0);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildTeamHtmlReport(analysis, timeRange) {
  const reportDate = formatDateRange(timeRange);
  const exportedAt = new Intl.DateTimeFormat("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).format(new Date());
  const benchmarkRows = BENCHMARK_METRICS.map((metric) => {
    const result = analysis.benchmarks[metric.key];
    return `<tr><td>${escapeHtml(metric.label)}</td><td>${escapeHtml(metric.format(result.average))}</td><td>${escapeHtml(metric.format(result.median))}</td><td>${escapeHtml(metric.format(result.p25))} – ${escapeHtml(metric.format(result.p75))}</td><td>${escapeHtml(metric.format(result.min))}</td><td>${escapeHtml(metric.format(result.max))}</td><td class="accent">${escapeHtml(metric.format(result.range))}</td></tr>`;
  }).join("");
  const memberRows = analysis.rows.map((person) => `<tr><td>${person.rank}</td><td><strong>${escapeHtml(person.displayName)}</strong><small>${escapeHtml(person.tier.label)}</small></td><td class="accent">${person.referenceScore}/100</td><td>${fmt(person.requests)} 次<br><small>${fmtPct(person.successRate)} 成功率</small></td><td>${fmtTokens(person.totalTokens)}<br><small>${fmtCost(person.cost)}</small></td><td>${escapeHtml(formatDuration(person.effectiveDurationMs))}</td><td>${fmt(person.activeDays)} 天 / ${fmt(person.sessionCount)} 会话</td><td>${fmtPct(person.tokenShare)}</td></tr>`).join("");


  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>人员 AI 使用分析报告</title><style>
    :root{--ink:#172033;--muted:#627087;--line:#dfe5ee;--surface:#fff;--soft:#f6f8fc;--brand:#2563eb;--good:#047857}*{box-sizing:border-box}body{margin:0;background:#f2f5fa;color:var(--ink);font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}.page{max-width:1280px;margin:32px auto;background:var(--surface);padding:44px;box-shadow:0 12px 40px rgba(26,41,67,.1)}h1,h2,h3,p{margin:0}.eyebrow{color:var(--brand);font-size:11px;font-weight:800;letter-spacing:.13em}.cover{display:flex;justify-content:space-between;gap:28px;border-bottom:1px solid var(--line);padding-bottom:28px}.cover h1{font-size:30px;line-height:1.25;margin-top:6px}.cover p{color:var(--muted);margin-top:8px}.notice{max-width:360px;border-left:3px solid var(--brand);background:var(--soft);padding:12px 14px;color:var(--muted);font-size:12px}.section{margin-top:32px}.section-head{display:flex;justify-content:space-between;align-items:end;gap:20px;margin-bottom:14px}.section h2{font-size:19px}.section-head p{color:var(--muted);font-size:12px;margin-top:3px}.summary{display:grid;grid-template-columns:repeat(6,1fr);border:1px solid var(--line);border-radius:12px;overflow:hidden}.summary div{padding:16px;border-left:1px solid var(--line)}.summary div:first-child{border-left:0}.summary dt{color:var(--muted);font-size:12px}.summary dd{font-size:21px;font-weight:750;margin:6px 0 0}.summary small{color:var(--muted);font-size:11px}.grid{display:grid;grid-template-columns:1.7fr .8fr;gap:20px}.card{border:1px solid var(--line);border-radius:12px;padding:20px}.card h3{font-size:15px}.card p{color:var(--muted);font-size:12px;margin-top:4px}.assessment{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-top:14px}.assessment div{background:var(--soft);border-radius:9px;padding:14px}.assessment span{font-size:12px;color:var(--muted)}.assessment b{display:block;font-size:22px;margin-top:5px}.assessment small{display:block;color:var(--muted);font-size:11px;margin-top:4px}table{width:100%;border-collapse:collapse;font-size:12px}th{background:var(--soft);color:var(--muted);font-size:11px;text-align:right;padding:10px;border-bottom:1px solid var(--line)}th:first-child,td:first-child{text-align:left}td{text-align:right;padding:10px;border-bottom:1px solid var(--line)}tbody tr:last-child td{border-bottom:0}td small{color:var(--muted)}.accent{color:var(--brand);font-weight:750}.profiles{display:grid;grid-template-columns:repeat(2,1fr);gap:14px}.profile{border:1px solid var(--line);border-radius:12px;padding:18px;break-inside:avoid}.profile-head{display:flex;align-items:start;justify-content:space-between;gap:12px;border-bottom:1px solid var(--line);padding-bottom:12px}.profile h3{font-size:16px}.profile-head p{font-size:11px;color:var(--muted);margin-top:3px}.score{color:var(--brand);font-size:24px}.score small{font-size:11px;color:var(--muted)}.profile dl{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:14px 0}.profile dt{font-size:11px;color:var(--muted)}.profile dd{font-weight:700;margin:3px 0 0;font-size:13px}.profile-note{border-top:1px solid var(--line);padding-top:10px}.profile-note p{font-size:11px;color:var(--muted);margin:4px 0}.profile-note b{color:var(--ink)}.footer{border-top:1px solid var(--line);margin-top:34px;padding-top:14px;color:var(--muted);font-size:11px}@media print{body{background:#fff}.page{box-shadow:none;margin:0;max-width:none;padding:25px}.section{break-inside:avoid}.profiles{grid-template-columns:repeat(2,1fr)}}@media(max-width:900px){.page{margin:0;padding:24px}.cover,.grid{display:block}.notice{max-width:none;margin-top:16px}.summary{grid-template-columns:repeat(2,1fr)}.summary div:nth-child(odd){border-left:0}.assessment,.profiles{grid-template-columns:1fr}.section-head{display:block}}
  </style></head><body><main class="page"><header class="cover"><div><p class="eyebrow">PERSONNEL PERFORMANCE REFERENCE</p><h1>人员 AI 使用分析报告</h1><p>${escapeHtml(reportDate)} · 导出时间：${escapeHtml(exportedAt)}</p></div><div class="notice">本报告用于绩效复盘的辅助观察，不应单独等同于业务产出或最终绩效；建议与岗位目标、交付质量及协作贡献联合评估。</div></header><section class="section"><div class="section-head"><div><p class="eyebrow">TEAM BENCHMARK</p><h2>团队整体概览</h2></div></div><dl class="summary"><div><dt>使用人数</dt><dd>${fmt(analysis.rows.length)} 人</dd><small>高/中/低：${analysis.highCount}/${analysis.mediumCount}/${analysis.lowCount}</small></div><div><dt>总调用</dt><dd>${fmt(analysis.totalRequests)} 次</dd><small>人均 ${fmt(analysis.avgRequests)} 次</small></div><div><dt>总 Token</dt><dd>${fmtTokens(analysis.totalTokens)}</dd><small>人均 ${fmtTokens(analysis.avgTokens)}</small></div><div><dt>估算活跃时长</dt><dd>${escapeHtml(formatDuration(analysis.totalActiveTime))}</dd><small>${fmt(analysis.activeTimePeople)} 人可计算</small></div><div><dt>使用集中度</dt><dd>${fmtPct(analysis.headTokenShare)}</dd><small>前 ${analysis.headCount} 人贡献 80% Token</small></div><div><dt>请求时长覆盖</dt><dd>${fmtPct(analysis.durationCoverage)}</dd><small>依据完整生命周期数据</small></div></dl></section><section class="section grid"><div class="card"><p class="eyebrow">EVALUATION BENCHMARK</p><h3>团队指标基准对比</h3><p>均值反映团队整体水平；中位数更接近典型成员；P25–P75 用于判断主要人员群体的正常波动区间。</p><div style="overflow:auto;margin-top:14px"><table><thead><tr><th>对比维度</th><th>平均数</th><th>中位数</th><th>P25–P75</th><th>最低值</th><th>最高值</th><th>高低差额</th></tr></thead><tbody>${benchmarkRows}</tbody></table></div></div><aside class="card"><p class="eyebrow">TEAM ASSESSMENT</p><h3>团队结构评估</h3><div class="assessment"><div><span>指数高低差额</span><b>${analysis.benchmarks.referenceScore.range.toFixed(0)} 分</b><small>最高 ${analysis.benchmarks.referenceScore.max.toFixed(0)} · 中位数 ${analysis.benchmarks.referenceScore.median.toFixed(0)}</small></div><div><span>人员分层结构</span><b>${analysis.highCount}/${analysis.mediumCount}/${analysis.lowCount}</b><small>高投入 / 中投入 / 低投入</small></div><div><span>资源集中度</span><b>${fmtPct(analysis.headTokenShare)}</b><small>前 ${analysis.headCount} 人贡献 80% Token</small></div></div><p style="margin-top:16px"><b style="color:var(--ink)">投入指数评分规则：</b>Token 使用规模 35%、调用次数 20%、估算活跃时长 18%、活跃天数 12%、模型使用广度 5%、调用成功率 10%。高投入 ≥70 分，中投入 40–69 分，低投入 &lt;40 分。</p></aside></section><section class="section"><div class="section-head"><div><p class="eyebrow">ALL MEMBERS</p><h2>全员详细对比</h2><p>按 AI 使用投入指数排序，保留原始使用数据以便复盘。</p></div></div><div style="overflow:auto"><table><thead><tr><th>排名</th><th>成员 / 分层</th><th>投入指数</th><th>调用 / 成功率</th><th>Token / 成本</th><th>估算活跃时长</th><th>活跃天 / 会话</th><th>Token 贡献</th></tr></thead><tbody>${memberRows}</tbody></table></div></section></section><footer class="footer">本报告由 Spring Mouse 人员使用分析报告生成。统计口径：连续请求间隔不超过 ${SESSION_GAP_MINUTES} 分钟合并为估算活跃会话；历史记录缺少完整生命周期时间时，时长统计可能不完整。</footer></main></body></html>`;
}

function buildMemberHtmlReport(analysis, timeRange, person) {
  const reportDate = formatDateRange(timeRange);
  const exportedAt = new Intl.DateTimeFormat("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).format(new Date());
  const topModels = topEntries(person.models, 5).map((row) => `<tr><td>${escapeHtml(row.name)}</td><td>${fmtTokens(row.value)}</td></tr>`).join("") || "<tr><td colspan=\"2\">暂无模型数据</td></tr>";
  const topApps = topEntries(person.apps, 4).map((row) => `<tr><td>${escapeHtml(row.appName || row.name)}</td><td>${fmtTokens(row.value)}</td></tr>`).join("") || "<tr><td colspan=\"2\">暂无应用数据</td></tr>";
  const topIps = topEntries(person.sourceIps, 3, "requests").map((row) => `<tr><td>${escapeHtml(row.name)}</td><td>${fmt(row.value)} 次</td></tr>`).join("") || "<tr><td colspan=\"2\">暂无 IP 数据</td></tr>";
  const peakWeekday = WEEKDAY_LABELS[topIndex(person.weekdays)] || "—";
  const peakPeriod = PERIOD_LABELS[topIndex(person.periods)] || "—";
  const insights = [];
  if (person.referenceScore >= 70) insights.push("当前周期属于团队高投入使用者，可关注其模型选择、提示词或自动化流程是否能够复用。");
  if (person.successRate < analysis.avgSuccessRate) insights.push("调用成功率低于团队均值，建议结合调用失败明细检查模型、渠道或使用方式。");
  if (person.effectiveDurationMs < analysis.avgDuration) insights.push("估算活跃时长低于团队均值，应结合岗位场景和实际交付判断是否需要进一步支持。");
  if (person.modelCount <= 1) insights.push("模型使用较集中，建议判断是否为单一任务场景或存在模型选择空间。");
  if (!insights.length) insights.push("使用规模、持续性和稳定性与团队整体水平相近，建议继续与实际交付结果结合复盘。");

  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(person.displayName)} · 人员 AI 使用报告</title><style>:root{--ink:#172033;--muted:#627087;--line:#dfe5ee;--surface:#fff;--soft:#f6f8fc;--brand:#2563eb}*{box-sizing:border-box}body{margin:0;background:#f2f5fa;color:var(--ink);font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}.page{max-width:1050px;margin:32px auto;background:#fff;padding:44px;box-shadow:0 12px 40px rgba(26,41,67,.1)}h1,h2,h3,p{margin:0}.eyebrow{color:var(--brand);font-size:11px;font-weight:800;letter-spacing:.13em}.cover{display:flex;justify-content:space-between;gap:28px;border-bottom:1px solid var(--line);padding-bottom:28px}.cover h1{font-size:30px;line-height:1.25;margin-top:6px}.cover p{color:var(--muted);margin-top:8px}.score{border:1px solid #d6e3ff;background:#f4f8ff;border-radius:12px;padding:14px 20px;text-align:right;white-space:nowrap}.score span{display:block;color:var(--brand);font-size:11px;font-weight:800}.score b{font-size:28px}.section{margin-top:30px}.section h2{font-size:19px}.section>p{color:var(--muted);font-size:12px;margin-top:4px}.stats{margin-top:14px;display:grid;grid-template-columns:repeat(3,1fr);border:1px solid var(--line);border-radius:12px;overflow:hidden}.stats div{padding:15px;border-left:1px solid var(--line);border-top:1px solid var(--line)}.stats div:nth-child(-n+3){border-top:0}.stats div:nth-child(3n+1){border-left:0}.stats span{font-size:11px;color:var(--muted)}.stats b{display:block;font-size:19px;margin-top:5px}.stats small{display:block;color:var(--muted);font-size:11px;margin-top:4px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:18px}.card{border:1px solid var(--line);border-radius:12px;padding:18px}.card h3{font-size:15px}.card p{font-size:12px;color:var(--muted);margin-top:4px}.barrow{display:grid;grid-template-columns:110px 1fr 78px;align-items:center;gap:10px;margin-top:12px;font-size:12px}.bar{height:7px;background:var(--soft);border-radius:99px;overflow:hidden}.bar i{display:block;height:100%;background:var(--brand);border-radius:99px}.barrow em{font-style:normal;text-align:right;font-weight:700}.two-col{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-top:14px}.two-col div{background:var(--soft);padding:12px;border-radius:9px}.two-col span{font-size:11px;color:var(--muted)}.two-col b{display:block;margin-top:4px}.list{margin:14px 0 0;padding-left:20px;color:var(--muted);font-size:12px}.list li{margin:7px 0}table{width:100%;border-collapse:collapse;font-size:12px;margin-top:14px}th{background:var(--soft);color:var(--muted);font-size:11px;text-align:left;padding:9px;border-bottom:1px solid var(--line)}td{padding:9px;border-bottom:1px solid var(--line)}td:last-child,th:last-child{text-align:right}.footer{border-top:1px solid var(--line);margin-top:32px;padding-top:14px;color:var(--muted);font-size:11px}@media print{body{background:#fff}.page{box-shadow:none;margin:0;max-width:none;padding:25px}.section,.card{break-inside:avoid}}@media(max-width:760px){.page{margin:0;padding:24px}.cover,.grid{display:block}.score{margin-top:16px;text-align:left}.stats{grid-template-columns:repeat(2,1fr)}.stats div:nth-child(3){border-top:1px solid var(--line)}.stats div:nth-child(3n+1){border-left:1px solid var(--line)}.stats div:nth-child(odd){border-left:0}.two-col{grid-template-columns:1fr}}</style></head><body><main class="page"><header class="cover"><div><p class="eyebrow">INDIVIDUAL PERSONNEL REPORT</p><h1>${escapeHtml(person.displayName)} · AI 使用报告</h1><p>${escapeHtml(reportDate)} · 导出时间：${escapeHtml(exportedAt)}</p></div><div class="score"><span>AI 使用投入指数（参考）</span><b>${person.referenceScore}<small>/100</small></b></div></header><section class="section"><p class="eyebrow">INDIVIDUAL OVERVIEW</p><h2>个人使用概览</h2><p>团队第 ${person.rank} 名 · Token 第 ${person.tokenRank} 名 · 活跃时长第 ${person.durationRank} 名 · 成功率第 ${person.successRank} 名 · ${escapeHtml(person.tier.label)}</p><div class="stats"><div><span>调用次数</span><b>${fmt(person.requests)} 次</b><small>团队均值 ${fmt(analysis.avgRequests)} 次</small></div><div><span>Token 使用规模</span><b>${fmtTokens(person.totalTokens)}</b><small>占团队 ${fmtPct(person.tokenShare)}</small></div><div><span>估算活跃时长</span><b>${escapeHtml(formatDuration(person.effectiveDurationMs))}</b><small>${fmt(person.sessionCount)} 个连续会话</small></div><div><span>活跃天数</span><b>${fmt(person.activeDays)} 天</b><small>团队均值 ${analysis.avgActiveDays.toFixed(1)} 天</small></div><div><span>调用成功率</span><b>${fmtPct(person.successRate)}</b><small>团队均值 ${fmtPct(analysis.avgSuccessRate)}</small></div><div><span>模型使用广度</span><b>${fmt(person.modelCount)} 个</b><small>预估成本 ${fmtCost(person.cost)}</small></div></div></section><section class="section grid"><div class="card"><p class="eyebrow">TEAM COMPARISON</p><h3>与团队均值对标</h3>${[["调用次数",person.requests,analysis.avgRequests,`${fmt(person.requests)} 次`,`团队均值 ${fmt(analysis.avgRequests)} 次`],["Token 使用规模",person.totalTokens,analysis.avgTokens,fmtTokens(person.totalTokens),`团队均值 ${fmtTokens(analysis.avgTokens)}`],["估算活跃时长",person.effectiveDurationMs,analysis.avgDuration,formatDuration(person.effectiveDurationMs),`团队均值 ${formatDuration(analysis.avgDuration)}`],["调用成功率",person.successRate,analysis.avgSuccessRate,fmtPct(person.successRate),`团队均值 ${fmtPct(analysis.avgSuccessRate)}`]].map(([label,value,average,valueText,averageText])=>{const maximum=Math.max(value,average,1);return `<div class="barrow"><span>${label}</span><div class="bar"><i style="width:${Math.round(value/maximum*100)}%"></i></div><em>${valueText}</em></div><p style="text-align:right;margin:2px 0 0">${averageText}</p>`;}).join("")}</div><div class="card"><p class="eyebrow">RELIABILITY</p><h3>调用稳定性与效率</h3><div class="two-col"><div><span>成功调用</span><b>${fmt(person.completedRequests)} 次</b></div><div><span>失败 / 取消</span><b>${fmt(person.failedRequests)} / ${fmt(person.cancelledRequests)}</b></div><div><span>单次 Token</span><b>${fmtTokens(person.tokensPerRequest)}</b></div><div><span>平均请求耗时</span><b>${escapeHtml(formatDuration(person.averageRequestDurationMs))}</b></div><div><span>累计请求耗时</span><b>${escapeHtml(formatDuration(person.requestDurationMs))}</b></div><div><span>每千 Token 成本</span><b>${fmtCost(person.totalTokens ? person.cost / person.totalTokens * 1000 : 0)}</b></div></div></div></section><section class="section grid"><div class="card"><p class="eyebrow">USAGE PREFERENCES</p><h3>模型与工具偏好</h3><table><thead><tr><th>常用模型</th><th>Token</th></tr></thead><tbody>${topModels}</tbody></table><table><thead><tr><th>来源应用</th><th>Token</th></tr></thead><tbody>${topApps}</tbody></table></div><div class="card"><p class="eyebrow">USAGE RHYTHM</p><h3>使用节奏与访问来源</h3><div class="two-col"><div><span>使用高峰</span><b>${escapeHtml(`${peakWeekday} · ${peakPeriod}`)}</b></div><div><span>首次使用</span><b>${escapeHtml(formatDateTime(person.firstUsed))}</b></div><div><span>最后使用</span><b>${escapeHtml(formatDateTime(person.lastUsed))}</b></div></div><table><thead><tr><th>来源 IP</th><th>调用</th></tr></thead><tbody>${topIps}</tbody></table></div></section><section class="section"><p class="eyebrow">MANAGER NOTES</p><h2>复盘提示</h2><ul class="list">${insights.map((item)=>`<li>${escapeHtml(item)}</li>`).join("")}</ul></section><footer class="footer">该报告用于绩效复盘辅助，不应单独等同于业务产出或最终绩效。时长口径：相邻请求间隔不超过 ${SESSION_GAP_MINUTES} 分钟合并为估算活跃会话。</footer></main></body></html>`;
}

function downloadHtmlFile(html, filename) {
  const blob = new Blob([html], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

function downloadTeamHtmlReport(analysis, timeRange) {
  const stamp = new Date().toISOString().slice(0, 10);
  downloadHtmlFile(buildTeamHtmlReport(analysis, timeRange), `团队AI使用分析报告-${stamp}.html`);
}

function downloadMemberHtmlReport(analysis, timeRange, person) {
  const stamp = new Date().toISOString().slice(0, 10);
  const safeName = String(person.displayName || "成员").replace(/[\\/:*?"<>|]/g, "-");
  downloadHtmlFile(buildMemberHtmlReport(analysis, timeRange, person), `${safeName}-AI使用报告-${stamp}.html`);
}


function Bar({ value, color = "bg-primary", className }) {
  return (
    <div className={cn("h-1.5 w-full overflow-hidden rounded-full bg-bg-subtle", className)}>
      <div className={cn("h-full rounded-full", color)} style={{ width: `${Math.max(value > 0 ? 2 : 0, Math.min(100, value * 100))}%` }} />
    </div>
  );
}

Bar.propTypes = { value: PropTypes.number.isRequired, color: PropTypes.string, className: PropTypes.string };

function TierBadge({ tier }) {
  return <span className={cn("inline-flex rounded border px-2 py-0.5 text-[10px] font-bold", tier.className)}>{tier.label}</span>;
}

TierBadge.propTypes = { tier: PropTypes.object.isRequired };

function SuccessBadge({ rate }) {
  const className = rate >= 0.98
    ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-600"
    : rate >= 0.9
      ? "border-amber-500/20 bg-amber-500/10 text-amber-600"
      : "border-rose-500/20 bg-rose-500/10 text-rose-600";
  return <span className={cn("inline-flex rounded border px-2 py-0.5 text-[10px] font-bold", className)}>{fmtPct(rate)}</span>;
}

SuccessBadge.propTypes = { rate: PropTypes.number.isRequired };

function SectionTitle({ eyebrow, title, description, action }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div>
        {eyebrow ? <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-primary">{eyebrow}</p> : null}
        <h2 className="mt-0.5 text-base font-semibold text-text-main">{title}</h2>
        {description ? <p className="mt-1 text-xs text-text-muted">{description}</p> : null}
      </div>
      {action}
    </div>
  );
}

SectionTitle.propTypes = { eyebrow: PropTypes.string, title: PropTypes.string.isRequired, description: PropTypes.string, action: PropTypes.node };

function CompactMetric({ label, value, description }) {
  return (
    <div className="min-w-0 border-l border-border-subtle px-4 first:border-l-0 first:pl-0">
      <p className="truncate text-[11px] text-text-muted">{label}</p>
      <p className="mt-1 truncate text-xl font-bold tracking-tight text-text-main" title={value}>{value}</p>
      {description ? <p className="mt-1 truncate text-[10px] text-text-muted" title={description}>{description}</p> : null}
    </div>
  );
}

CompactMetric.propTypes = { label: PropTypes.string.isRequired, value: PropTypes.string.isRequired, description: PropTypes.string };

function ComparisonMetric({ label, personValue, averageValue, personText, averageText, color = "bg-primary" }) {
  const benchmark = Math.max(personValue || 0, averageValue || 0, 1);
  return (
    <div className="py-3 first:pt-0 last:pb-0">
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="font-medium text-text-main">{label}</span>
        <span className="text-text-muted">团队均值 {averageText}</span>
      </div>
      <div className="mt-2 space-y-1.5">
        <div className="flex items-center gap-2"><span className="w-11 text-[10px] text-text-muted">本人</span><Bar value={personValue / benchmark} color={color} /><span className="w-20 text-right text-[11px] font-semibold text-text-main">{personText}</span></div>
        <div className="flex items-center gap-2"><span className="w-11 text-[10px] text-text-muted">均值</span><Bar value={averageValue / benchmark} color="bg-text-muted/50" /><span className="w-20 text-right text-[11px] text-text-muted">{averageText}</span></div>
      </div>
    </div>
  );
}

ComparisonMetric.propTypes = {
  label: PropTypes.string.isRequired,
  personValue: PropTypes.number.isRequired,
  averageValue: PropTypes.number.isRequired,
  personText: PropTypes.string.isRequired,
  averageText: PropTypes.string.isRequired,
  color: PropTypes.string,
};

function RankedBreakdown({ title, rows, labelKey = "name", valueFormatter = fmtTokens, color = "bg-primary", empty = "暂无数据" }) {
  const max = Math.max(...rows.map((row) => row.value || 0), 1);
  return (
    <div className="min-w-0">
      <p className="mb-2 text-xs font-semibold text-text-main">{title}</p>
      {!rows.length ? <p className="rounded-lg bg-bg px-3 py-4 text-center text-xs text-text-muted">{empty}</p> : (
        <div className="space-y-2.5">
          {rows.map((row, index) => (
            <div key={row.name}>
              <div className="flex min-w-0 items-center justify-between gap-3 text-xs">
                <p className="min-w-0 truncate text-text-main" title={row[labelKey]}>{index + 1}. {row[labelKey]}</p>
                <span className="shrink-0 font-semibold text-text-muted">{valueFormatter(row.value)}</span>
              </div>
              <Bar value={row.value / max} color={color} className="mt-1.5" />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

RankedBreakdown.propTypes = {
  title: PropTypes.string.isRequired,
  rows: PropTypes.array.isRequired,
  labelKey: PropTypes.string,
  valueFormatter: PropTypes.func,
  color: PropTypes.string,
  empty: PropTypes.string,
};

function TeamSummary({ analysis, onExport }) {
  return (
    <Card className="overflow-hidden" padding="sm">
      <SectionTitle eyebrow="TEAM BENCHMARK" title="全员 AI 使用概览" description="先看团队结构，再下钻到具体人员；指标仅反映平台可观测到的 AI 使用行为。" action={<button type="button" onClick={onExport} className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium text-text-muted transition-colors hover:bg-bg hover:text-text-main"><span className="material-symbols-outlined text-[16px]">download</span>导出</button>} />
      <div className="mt-4 grid grid-cols-2 gap-y-4 sm:grid-cols-3 xl:grid-cols-6">
        <CompactMetric label="使用人数" value={`${fmt(analysis.rows.length)} 人`} description={`高/中/低：${analysis.highCount}/${analysis.mediumCount}/${analysis.lowCount}`} />
        <CompactMetric label="总调用" value={`${fmt(analysis.totalRequests)} 次`} description={`人均 ${fmt(analysis.avgRequests)} 次`} />
        <CompactMetric label="总 Token" value={fmtTokens(analysis.totalTokens)} description={`人均 ${fmtTokens(analysis.avgTokens)}`} />
        <CompactMetric label="估算活跃时长" value={formatDuration(analysis.totalActiveTime)} description={`${fmt(analysis.activeTimePeople)} 人可计算`} />
        <CompactMetric label="使用集中度" value={fmtPct(analysis.headTokenShare)} description={`前 ${analysis.headCount} 人贡献 80% Token`} />
        <CompactMetric label="请求时长覆盖" value={fmtPct(analysis.durationCoverage)} description="依据 startedAt / completedAt" />
      </div>
    </Card>
  );
}

TeamSummary.propTypes = { analysis: PropTypes.object.isRequired, onExport: PropTypes.func.isRequired };

const BENCHMARK_METRICS = [
  { key: "referenceScore", label: "AI 使用投入指数", format: (value) => value.toFixed(0) },
  { key: "requests", label: "调用次数", format: (value) => `${fmt(value)} 次` },
  { key: "totalTokens", label: "Token 使用规模", format: fmtTokens },
  { key: "effectiveDurationMs", label: "估算活跃时长", format: formatDuration },
  { key: "activeDays", label: "活跃天数", format: (value) => `${value.toFixed(1)} 天` },
  { key: "successRate", label: "调用成功率", format: fmtPct },
  { key: "modelCount", label: "模型使用广度", format: (value) => `${value.toFixed(1)} 个` },
  { key: "cost", label: "预估成本", format: fmtCost },
];

function BenchmarkReport({ analysis, onOpenScoreRules }) {
  return (
    <Card padding="sm">
      <SectionTitle
        eyebrow="EVALUATION BENCHMARK"
        title="团队指标基准对比"
        description="均值反映团队整体水平；中位数更接近典型成员；P25–P75 用于判断主要人员群体的正常波动区间。"
        action={<button type="button" onClick={onOpenScoreRules} className="inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-semibold text-primary transition-colors hover:bg-primary/10"><span className="material-symbols-outlined text-[17px]">rule</span>评分标准<span className="material-symbols-outlined text-[14px]">arrow_forward</span></button>}
      />
      <div className="mt-4 overflow-x-auto rounded-lg border border-border-subtle custom-scrollbar">
        <table className="w-full min-w-[760px] border-collapse text-xs">
          <thead className="border-b border-border-subtle bg-bg text-[10px] font-bold uppercase tracking-wider text-text-muted">
            <tr><th className="px-3 py-2.5 text-left">对比维度</th><th className="px-3 py-2.5 text-right">平均数</th><th className="px-3 py-2.5 text-right">中位数</th><th className="px-3 py-2.5 text-right">P25–P75</th><th className="px-3 py-2.5 text-right">最低值</th><th className="px-3 py-2.5 text-right">最高值</th><th className="px-3 py-2.5 text-right">高低差额</th></tr>
          </thead>
          <tbody className="divide-y divide-border-subtle">
            {BENCHMARK_METRICS.map((metric) => {
              const result = analysis.benchmarks[metric.key];
              return <tr key={metric.key} className="hover:bg-primary/[0.025]"><td className="px-3 py-2.5 font-medium text-text-main">{metric.label}</td><td className="whitespace-nowrap px-3 py-2.5 text-right text-text-main">{metric.format(result.average)}</td><td className="whitespace-nowrap px-3 py-2.5 text-right font-semibold text-text-main">{metric.format(result.median)}</td><td className="whitespace-nowrap px-3 py-2.5 text-right text-text-muted">{metric.format(result.p25)} – {metric.format(result.p75)}</td><td className="whitespace-nowrap px-3 py-2.5 text-right text-text-muted">{metric.format(result.min)}</td><td className="whitespace-nowrap px-3 py-2.5 text-right text-text-main">{metric.format(result.max)}</td><td className="whitespace-nowrap px-3 py-2.5 text-right font-semibold text-primary">{metric.format(result.range)}</td></tr>;
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

BenchmarkReport.propTypes = { analysis: PropTypes.object.isRequired, onOpenScoreRules: PropTypes.func.isRequired };

function TeamAssessmentSummary({ analysis }) {
  const score = analysis.benchmarks.referenceScore;
  const concentrationNote = analysis.headTokenShare >= 0.8
    ? "使用资源主要集中在头部人员，建议结合岗位分工、账号覆盖和工具培训进一步复盘。"
    : "团队使用分布相对均衡，可进一步识别并沉淀高效工作流。";

  return (
    <Card padding="sm">
      <SectionTitle eyebrow="TEAM ASSESSMENT" title="团队结构评估" description="基于当前统计周期的成员分布生成，用于快速定位差异与后续管理动作。" />
      <div className="mt-4 grid gap-4 sm:grid-cols-3">
        <div className="min-w-0 rounded-lg bg-bg px-4 py-3"><p className="text-[11px] text-text-muted">投入指数高低差额</p><p className="mt-1 text-xl font-bold text-text-main">{score.range.toFixed(0)} 分</p><p className="mt-1 text-[11px] leading-4 text-text-muted">最高 {score.max.toFixed(0)} · 最低 {score.min.toFixed(0)} · 中位数 {score.median.toFixed(0)}</p></div>
        <div className="min-w-0 rounded-lg bg-bg px-4 py-3"><p className="text-[11px] text-text-muted">人员分层结构</p><p className="mt-1 text-xl font-bold text-text-main">{analysis.highCount} / {analysis.mediumCount} / {analysis.lowCount}</p><p className="mt-1 text-[11px] leading-4 text-text-muted">高投入 / 中投入 / 低投入人员数</p></div>
        <div className="min-w-0 rounded-lg bg-bg px-4 py-3"><p className="text-[11px] text-text-muted">资源集中度评估</p><p className="mt-1 text-xl font-bold text-text-main">{fmtPct(analysis.headTokenShare)}</p><p className="mt-1 text-[11px] leading-4 text-text-muted">{concentrationNote}</p></div>
      </div>
    </Card>
  );
}

TeamAssessmentSummary.propTypes = { analysis: PropTypes.object.isRequired };

function ScoreRulesDrawer({ isOpen, onClose }) {
  const rules = [
    ["Token 使用规模", "35%", "成员 Token / 本周期最高 Token × 35"],
    ["调用次数", "20%", "成员调用次数 / 本周期最高调用次数 × 20"],
    ["估算活跃时长", "18%", "连续会话时长 / 本周期最高活跃时长 × 18"],
    ["活跃天数", "12%", "成员活跃天数 / 本周期最高活跃天数 × 12"],
    ["模型使用广度", "5%", "成员使用模型数 / 本周期最高模型数 × 5"],
    ["调用成功率", "10%", "成员成功率 × 10"],
  ];
  return (
    <Drawer isOpen={isOpen} onClose={onClose} title="AI 使用投入指数评分标准" width="lg" zIndex="z-[60]">
      <div className="space-y-5">
        <div className="rounded-xl border border-primary/15 bg-primary/[0.05] p-4"><p className="text-sm font-semibold text-text-main">评分定位</p><p className="mt-1 text-xs leading-5 text-text-muted">该指数用于量化当前统计周期内可观测到的 AI 使用投入，帮助做团队内横向对比、识别培训需求和沉淀工作流；它不等同于业务产出、交付质量或最终绩效分。</p></div>
        <div><p className="text-sm font-semibold text-text-main">计算维度与权重</p><p className="mt-1 text-xs text-text-muted">前五项按当前人员集合的相对最高值归一化；成功率按实际成功调用占比计算。</p><div className="mt-3 divide-y divide-border-subtle rounded-xl border border-border-subtle"><div className="grid grid-cols-[minmax(0,1fr)_56px] gap-3 bg-bg px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-text-muted"><span>维度与计算方式</span><span className="text-right">权重</span></div>{rules.map(([label, weight, formula]) => <div key={label} className="grid grid-cols-[minmax(0,1fr)_56px] gap-3 px-3 py-3"><div><p className="text-xs font-semibold text-text-main">{label}</p><p className="mt-1 text-[11px] leading-4 text-text-muted">{formula}</p></div><b className="text-right text-sm text-primary">{weight}</b></div>)}</div></div>
        <div><p className="text-sm font-semibold text-text-main">人员分层标准</p><div className="mt-3 space-y-2 text-xs"><div className="flex items-center justify-between rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-3 py-2"><span className="font-semibold text-emerald-600">高投入</span><span className="text-text-main">≥ 70 分</span></div><div className="flex items-center justify-between rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2"><span className="font-semibold text-amber-600">中投入</span><span className="text-text-main">40–69 分</span></div><div className="flex items-center justify-between rounded-lg border border-slate-500/20 bg-slate-500/10 px-3 py-2"><span className="font-semibold text-text-muted">低投入</span><span className="text-text-main">&lt; 40 分</span></div></div></div>
        <div className="rounded-xl border border-amber-500/20 bg-amber-500/[0.06] p-4 text-xs leading-5 text-text-muted"><p className="font-semibold text-text-main">使用建议</p><p className="mt-1">建议仅在岗位职责相近、统计周期一致的人员之间横向比较，并与项目成果、交付质量、协作贡献、角色分工共同纳入复盘。低使用并不必然代表低绩效，可能与岗位适用性、账号接入或是否使用其他工具有关。</p></div>
      </div>
    </Drawer>
  );
}

ScoreRulesDrawer.propTypes = { isOpen: PropTypes.bool.isRequired, onClose: PropTypes.func.isRequired };

function ComparisonView({ analysis, query, onQueryChange, tierFilter, onTierFilterChange, sortBy, onSortByChange, onSelectPerson, onOpenScoreRules, onExportTeam }) {
  const filteredRows = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    const sorted = [...analysis.rows].filter((person) => {
      const matchesName = !normalized || person.displayName.toLocaleLowerCase().includes(normalized);
      return matchesName && (tierFilter === "all" || person.tier.id === tierFilter);
    });
    const sorters = {
      score: (a, b) => b.referenceScore - a.referenceScore,
      tokens: (a, b) => b.totalTokens - a.totalTokens,
      requests: (a, b) => b.requests - a.requests,
      duration: (a, b) => b.effectiveDurationMs - a.effectiveDurationMs,
      activeDays: (a, b) => b.activeDays - a.activeDays,
      success: (a, b) => b.successRate - a.successRate,
      cost: (a, b) => b.cost - a.cost,
    };
    return sorted.sort(sorters[sortBy] || sorters.score);
  }, [analysis.rows, query, tierFilter, sortBy]);

  return (
    <div className="flex flex-col gap-5">
      <TeamSummary analysis={analysis} onExport={onExportTeam} />
      <BenchmarkReport analysis={analysis} onOpenScoreRules={onOpenScoreRules} />
      <TeamAssessmentSummary analysis={analysis} />

      <Card padding="sm">
        <SectionTitle
          eyebrow="ALL MEMBERS"
          title="全员详细对比"
          description="支持按投入、规模、持续性、稳定性和成本排序；点击任意人员进入单人报告。"
          action={<span className="rounded-md bg-bg px-2.5 py-1 text-xs text-text-muted">展示 {fmt(filteredRows.length)} / {fmt(analysis.rows.length)} 人</span>}
        />
        <div className="mt-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <label className="flex h-9 min-w-0 items-center gap-2 rounded-lg border border-border-subtle bg-bg px-3 lg:w-72">
            <span className="material-symbols-outlined text-[18px] text-text-muted">search</span>
            <input value={query} onChange={(event) => onQueryChange(event.target.value)} className="min-w-0 flex-1 bg-transparent text-xs text-text-main outline-none placeholder:text-text-muted" placeholder="搜索人员名称" />
          </label>
          <div className="flex flex-wrap items-center gap-2">
            {[{ id: "all", label: "全部" }, { id: "high", label: "高投入" }, { id: "medium", label: "中投入" }, { id: "low", label: "低投入" }].map((item) => (
              <button key={item.id} type="button" onClick={() => onTierFilterChange(item.id)} className={cn("rounded-md border px-2.5 py-1.5 text-xs font-semibold transition-colors", tierFilter === item.id ? "border-primary/25 bg-primary/10 text-primary" : "border-border-subtle bg-surface text-text-muted hover:bg-bg")}>{item.label}</button>
            ))}
            <select value={sortBy} onChange={(event) => onSortByChange(event.target.value)} className="h-8 rounded-md border border-border-subtle bg-bg px-2 text-xs text-text-main outline-none">
              <option value="score">按参考分排序</option>
              <option value="tokens">按 Token 排序</option>
              <option value="requests">按调用次数排序</option>
              <option value="duration">按活跃时长排序</option>
              <option value="activeDays">按活跃天数排序</option>
              <option value="success">按成功率排序</option>
              <option value="cost">按成本排序</option>
            </select>
          </div>
        </div>

        <div className="mt-4 overflow-x-auto rounded-lg border border-border-subtle custom-scrollbar">
          <table className="w-full min-w-[1120px] border-collapse text-xs">
            <thead className="border-b border-border-subtle bg-bg text-[10px] font-bold uppercase tracking-wider text-text-muted">
              <tr>
                <th className="px-3 py-2.5 text-left">全员排名</th>
                <th className="px-3 py-2.5 text-left">成员 / 分层</th>
                <th className="px-3 py-2.5 text-right">投入参考分</th>
                <th className="px-3 py-2.5 text-right">调用 / 成功率</th>
                <th className="px-3 py-2.5 text-right">Token / 成本</th>
                <th className="px-3 py-2.5 text-right">估算活跃时长</th>
                <th className="px-3 py-2.5 text-right">活跃天 / 会话</th>
                <th className="px-3 py-2.5 text-left">Token 贡献</th>
                <th className="px-3 py-2.5 text-right">报告</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {filteredRows.map((person) => (
                <tr key={person.key} className="transition-colors hover:bg-primary/[0.025]">
                  <td className="px-3 py-2.5"><span className={`grid size-6 place-items-center rounded text-[10px] font-black ${person.rank <= 3 ? "bg-primary/10 text-primary" : "bg-bg-subtle text-text-muted"}`}>{person.rank}</span></td>
                  <td className="max-w-[190px] px-3 py-2.5"><p className="truncate font-semibold text-text-main" title={person.displayName}>{person.displayName}</p><div className="mt-1"><TierBadge tier={person.tier} /></div></td>
                  <td className="px-3 py-2.5 text-right"><p className="font-black text-primary">{person.referenceScore}<span className="ml-1 text-[10px] font-normal text-text-muted">/100</span></p><p className="mt-0.5 text-[10px] text-text-muted">前 {fmtPct(person.percentile, 0)}</p></td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-right"><p className="font-medium text-text-main">{fmt(person.requests)} 次</p><div className="mt-1"><SuccessBadge rate={person.successRate} /></div></td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-right"><p className="font-medium text-text-main">{fmtTokens(person.totalTokens)}</p><p className="mt-0.5 text-[10px] text-text-muted">{fmtCost(person.cost)}</p></td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-right"><p className="font-medium text-text-main">{formatDuration(person.effectiveDurationMs)}</p><p className="mt-0.5 text-[10px] text-text-muted">请求耗时 {formatDuration(person.requestDurationMs)}</p></td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-right"><p className="font-medium text-text-main">{fmt(person.activeDays)} 天 / {fmt(person.sessionCount)} 次</p><p className="mt-0.5 text-[10px] text-text-muted">模型 {fmt(person.modelCount)} 个</p></td>
                  <td className="w-44 px-3 py-2.5"><div className="flex items-center gap-2"><Bar value={person.tokenShare} /><span className="w-10 shrink-0 text-right text-[10px] text-text-muted">{fmtPct(person.tokenShare)}</span></div></td>
                  <td className="px-3 py-2.5 text-right"><button type="button" onClick={() => onSelectPerson(person.key)} className="inline-flex items-center gap-1 rounded-md border border-primary/20 bg-primary/10 px-2 py-1 text-[11px] font-semibold text-primary hover:bg-primary/15"><span className="material-symbols-outlined text-[15px]">person</span>查看</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!filteredRows.length ? <p className="py-10 text-center text-sm text-text-muted">没有符合条件的人员。</p> : null}
      </Card>
    </div>
  );
}

ComparisonView.propTypes = {
  analysis: PropTypes.object.isRequired,
  query: PropTypes.string.isRequired,
  onQueryChange: PropTypes.func.isRequired,
  tierFilter: PropTypes.string.isRequired,
  onTierFilterChange: PropTypes.func.isRequired,
  sortBy: PropTypes.string.isRequired,
  onSortByChange: PropTypes.func.isRequired,
  onSelectPerson: PropTypes.func.isRequired,
  onOpenScoreRules: PropTypes.func.isRequired,
  onExportTeam: PropTypes.func.isRequired,
};

function MemberList({ rows, selectedKey, onSelect }) {
  return (
    <aside className="min-w-0 rounded-xl border border-border-subtle bg-bg/60 p-2">
      <p className="px-2 py-2 text-[10px] font-bold uppercase tracking-[0.12em] text-text-muted">全员名单 · {fmt(rows.length)} 人</p>
      <div className="max-h-[min(70vh,760px)] space-y-1 overflow-y-auto pr-1 custom-scrollbar">
        {rows.map((person) => (
          <button key={person.key} type="button" onClick={() => onSelect(person.key)} className={cn("w-full rounded-lg px-3 py-2.5 text-left transition-colors", selectedKey === person.key ? "bg-primary/10" : "hover:bg-surface") }>
            <div className="flex items-center justify-between gap-2"><p className="min-w-0 truncate text-xs font-semibold text-text-main">{person.rank}. {person.displayName}</p><span className="shrink-0 text-xs font-black text-primary">{person.referenceScore}</span></div>
            <p className="mt-1 truncate text-[10px] text-text-muted">{fmtTokens(person.totalTokens)} Token · {formatDuration(person.effectiveDurationMs)}</p>
          </button>
        ))}
      </div>
    </aside>
  );
}

MemberList.propTypes = { rows: PropTypes.array.isRequired, selectedKey: PropTypes.string, onSelect: PropTypes.func.isRequired };

function RhythmView({ person }) {
  const maxWeekday = Math.max(...(person.weekdays || []), 1);
  const maxPeriod = Math.max(...(person.periods || []), 1);
  return (
    <Card padding="sm">
      <SectionTitle eyebrow="USAGE RHYTHM" title="使用节奏与连续性" description="查看该成员在哪些日期和时段集中使用 AI。" />
      <div className="mt-4 grid gap-5 lg:grid-cols-2">
        <div>
          <p className="mb-3 text-xs font-semibold text-text-main">工作日分布</p>
          <div className="space-y-2.5">
            {WEEKDAY_LABELS.map((label, index) => <div key={label} className="flex items-center gap-2"><span className="w-8 text-[11px] text-text-muted">{label}</span><Bar value={(person.weekdays?.[index] || 0) / maxWeekday} color="bg-violet-500" /><span className="w-8 text-right text-[11px] text-text-muted">{fmt(person.weekdays?.[index])}</span></div>)}
          </div>
        </div>
        <div>
          <p className="mb-3 text-xs font-semibold text-text-main">一天内使用时段</p>
          <div className="space-y-2.5">
            {PERIOD_LABELS.map((label, index) => <div key={label} className="flex items-center gap-2"><span className="w-8 text-[11px] text-text-muted">{label}</span><Bar value={(person.periods?.[index] || 0) / maxPeriod} color="bg-sky-500" /><span className="w-8 text-right text-[11px] text-text-muted">{fmt(person.periods?.[index])}</span></div>)}
          </div>
        </div>
      </div>
      <div className="mt-4 border-t border-border-subtle pt-3 text-xs text-text-muted">主要使用时间：<b className="text-text-main">{WEEKDAY_LABELS[topIndex(person.weekdays)] || "—"} · {PERIOD_LABELS[topIndex(person.periods)] || "—"}</b>；统计跨度：<b className="text-text-main">{formatDateTime(person.firstUsed)} — {formatDateTime(person.lastUsed)}</b>。</div>
    </Card>
  );
}

RhythmView.propTypes = { person: PropTypes.object.isRequired };

function buildReviewFindings(person, analysis) {
  const medianScore = analysis.benchmarks.referenceScore.median;
  const medianDuration = analysis.benchmarks.effectiveDurationMs.median;
  const topModel = topEntries(person.models, 1)[0]?.name || "暂无";
  const scoreState = person.referenceScore >= medianScore ? "高于或持平" : "低于";
  const durationState = person.effectiveDurationMs >= medianDuration ? "高于或持平" : "低于";
  const reliabilityState = person.successRate >= analysis.avgSuccessRate ? "高于或持平" : "低于";

  return [
    {
      icon: "trending_up",
      title: "投入水平",
      tone: "text-primary bg-primary/10",
      value: `${scoreState}团队中位数 ${medianScore.toFixed(0)} 分`,
      detail: `当前指数 ${person.referenceScore} 分，团队第 ${person.rank} 名；Token 占团队 ${fmtPct(person.tokenShare)}。`,
    },
    {
      icon: "timer",
      title: "持续投入",
      tone: "text-emerald-600 bg-emerald-500/10",
      value: person.effectiveDurationMs ? `${durationState}团队时长中位数` : "时长数据暂不可用",
      detail: person.effectiveDurationMs
        ? `估算活跃 ${formatDuration(person.effectiveDurationMs)}，${fmt(person.activeDays)} 个活跃日、${fmt(person.sessionCount)} 个连续会话。`
        : "当前记录缺少完整 startedAt / completedAt 生命周期，建议后续请求产生后再观察。",
    },
    {
      icon: "verified",
      title: "调用稳定性",
      tone: "text-violet-600 bg-violet-500/10",
      value: `${reliabilityState}团队成功率均值 ${fmtPct(analysis.avgSuccessRate)}`,
      detail: `当前成功率 ${fmtPct(person.successRate)}；成功 ${fmt(person.completedRequests)} 次，失败 ${fmt(person.failedRequests)} 次，取消 ${fmt(person.cancelledRequests)} 次。`,
    },
    {
      icon: "model_training",
      title: "使用策略",
      tone: "text-amber-600 bg-amber-500/10",
      value: `${fmt(person.modelCount)} 个模型 · 常用 ${topModel}`,
      detail: person.modelCount <= 1
        ? "模型选择较集中，建议结合任务类型确认是否存在更匹配的模型或备用方案。"
        : "具备一定模型探索广度，可进一步沉淀不同任务下的模型选择经验。",
    },
  ];
}

function MemberProfile({ person, analysis, recentCalls, onExport }) {
  const topModels = topEntries(person.models, 5);
  const topApps = topEntries(person.apps, 4);
  const topIps = topEntries(person.sourceIps, 3, "requests");
  const reviewFindings = buildReviewFindings(person, analysis);

  return (
    <div className="min-w-0 space-y-4">
      <Card className="overflow-hidden" padding="sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-primary">INDIVIDUAL REPORT</p>
            <div className="mt-1 flex flex-wrap items-center gap-2"><h2 className="truncate text-xl font-bold text-text-main">{person.displayName}</h2><TierBadge tier={person.tier} /><SuccessBadge rate={person.successRate} /></div>
            <p className="mt-1 text-xs text-text-muted">全员第 {person.rank} 名 · Token 第 {person.tokenRank} 名 · 活跃时长第 {person.durationRank} 名 · 成功率第 {person.successRank} 名</p>
          </div>
          <div className="flex shrink-0 items-start gap-2"><button type="button" onClick={onExport} className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium text-text-muted transition-colors hover:bg-bg hover:text-text-main"><span className="material-symbols-outlined text-[16px]">download</span>导出</button><div className="rounded-lg border border-primary/15 bg-primary/[0.06] px-4 py-2 text-right"><p className="text-[10px] font-bold uppercase tracking-wider text-primary">AI 使用投入指数（参考）</p><p className="mt-1 text-2xl font-black text-text-main">{person.referenceScore}<span className="ml-1 text-xs font-medium text-text-muted">/100</span></p></div></div>
        </div>
        <div className="mt-5 grid grid-cols-2 gap-y-4 sm:grid-cols-3 xl:grid-cols-6">
          <CompactMetric label="调用次数" value={`${fmt(person.requests)} 次`} description={`团队均值 ${fmt(analysis.avgRequests)} 次`} />
          <CompactMetric label="Token" value={fmtTokens(person.totalTokens)} description={`占团队 ${fmtPct(person.tokenShare)}`} />
          <CompactMetric label="估算活跃时长" value={formatDuration(person.effectiveDurationMs)} description={`${fmt(person.sessionCount)} 个连续会话`} />
          <CompactMetric label="活跃天数" value={`${fmt(person.activeDays)} 天`} description={`团队均值 ${analysis.avgActiveDays.toFixed(1)} 天`} />
          <CompactMetric label="模型广度" value={`${fmt(person.modelCount)} 个`} description={`最常用：${topModels[0]?.name || "—"}`} />
          <CompactMetric label="预估成本" value={fmtCost(person.cost)} description={`单次 ${fmtCost(person.requests ? person.cost / person.requests : 0)}`} />
        </div>
      </Card>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card padding="sm">
          <SectionTitle eyebrow="TEAM COMPARISON" title="相对团队对标" description="同一统计周期内，与团队人均水平做横向比较。" />
          <div className="mt-4 divide-y divide-border-subtle">
            <ComparisonMetric label="调用次数" personValue={person.requests} averageValue={analysis.avgRequests} personText={`${fmt(person.requests)} 次`} averageText={`${fmt(analysis.avgRequests)} 次`} color="bg-sky-500" />
            <ComparisonMetric label="Token 使用规模" personValue={person.totalTokens} averageValue={analysis.avgTokens} personText={fmtTokens(person.totalTokens)} averageText={fmtTokens(analysis.avgTokens)} color="bg-violet-500" />
            <ComparisonMetric label="估算活跃时长" personValue={person.effectiveDurationMs} averageValue={analysis.avgDuration} personText={formatDuration(person.effectiveDurationMs)} averageText={formatDuration(analysis.avgDuration)} color="bg-emerald-500" />
            <ComparisonMetric label="调用成功率" personValue={person.successRate} averageValue={analysis.avgSuccessRate} personText={fmtPct(person.successRate)} averageText={fmtPct(analysis.avgSuccessRate)} color="bg-amber-500" />
          </div>
        </Card>

        <Card padding="sm">
          <SectionTitle eyebrow="RELIABILITY & EFFICIENCY" title="调用稳定性与使用强度" description="用于识别高频试错、稳定使用或渠道质量异常等情况。" />
          <dl className="mt-4 divide-y divide-border-subtle text-xs">
            {[
              ["成功调用", `${fmt(person.completedRequests)} 次`, `失败 ${fmt(person.failedRequests)} · 取消 ${fmt(person.cancelledRequests)}`],
              ["调用成功率", fmtPct(person.successRate), `团队均值 ${fmtPct(analysis.avgSuccessRate)}`],
              ["单次 Token", fmtTokens(person.tokensPerRequest), `输入 ${(person.promptTokens || 0) >= (person.completionTokens || 0) ? "偏多" : "输出偏多"}`],
              ["平均请求耗时", formatDuration(person.averageRequestDurationMs), `累计请求耗时 ${formatDuration(person.requestDurationMs)}`],
              ["时长投入口径", formatDuration(person.activeSessionDurationMs), `相邻请求 ≤ ${SESSION_GAP_MINUTES} 分钟合并会话`],
              ["成本效率", fmtCost(person.cost), `${fmtCost(person.totalTokens ? person.cost / person.totalTokens * 1000 : 0)} / 1K Token`],
            ].map(([label, value, note]) => <div key={label} className="flex items-center justify-between gap-4 py-3 first:pt-0"><dt className="text-text-muted">{label}<p className="mt-0.5 text-[10px]">{note}</p></dt><dd className="shrink-0 text-right font-semibold text-text-main">{value}</dd></div>)}
          </dl>
        </Card>
      </div>

      <RhythmView person={person} />

      <Card padding="sm">
        <SectionTitle eyebrow="USAGE PREFERENCES" title="模型、应用与访问来源画像" description="用于识别模型偏好、工具接入方式以及潜在的访问环境差异。" />
        <div className="mt-4 grid gap-5 lg:grid-cols-3">
          <RankedBreakdown title="常用模型" rows={topModels} color="bg-primary" />
          <RankedBreakdown title="来源应用" rows={topApps} labelKey="appName" color="bg-violet-500" />
          <RankedBreakdown title="来源 IP" rows={topIps} color="bg-sky-500" empty="暂无采集到来源 IP" />
        </div>
      </Card>

      <Card padding="sm">
        <SectionTitle eyebrow="MANAGER NOTES" title="自动化复盘提示" description="基于当前人员与团队基准自动生成。仅辅助管理判断，不能替代对实际交付物、岗位职责和协作贡献的评价。" />
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {reviewFindings.map((finding) => (
            <div key={finding.title} className="min-w-0 rounded-lg border border-border-subtle bg-bg p-3">
              <div className="flex items-start gap-2.5">
                <span className={cn("material-symbols-outlined grid size-8 shrink-0 place-items-center rounded-md text-[17px]", finding.tone)}>{finding.icon}</span>
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-text-main">{finding.title}</p>
                  <p className="mt-1 text-xs font-medium leading-5 text-text-main">{finding.value}</p>
                  <p className="mt-1 text-[11px] leading-5 text-text-muted">{finding.detail}</p>
                </div>
              </div>
            </div>
          ))}
        </div>
      </Card>

      <Card padding="sm">
        <SectionTitle eyebrow="AUDIT TRAIL" title="最近调用证据" description="仅展示当前统计周期内已加载的最近调用记录，不包含请求内容。" />
        {!recentCalls.length ? <p className="mt-4 rounded-lg bg-bg px-3 py-7 text-center text-xs text-text-muted">当前周期没有可展示的最近调用明细。</p> : (
          <div className="mt-4 overflow-x-auto rounded-lg border border-border-subtle custom-scrollbar">
            <table className="w-full min-w-[760px] border-collapse text-xs"><thead className="border-b border-border-subtle bg-bg text-[10px] font-bold uppercase tracking-wider text-text-muted"><tr><th className="px-3 py-2.5 text-left">时间</th><th className="px-3 py-2.5 text-left">模型 / 应用</th><th className="px-3 py-2.5 text-right">输入 / 输出</th><th className="px-3 py-2.5 text-right">耗时</th><th className="px-3 py-2.5 text-right">成本</th><th className="px-3 py-2.5 text-right">状态</th></tr></thead>
              <tbody className="divide-y divide-border-subtle">{recentCalls.slice(0, 15).map((call) => <tr key={call.id}><td className="whitespace-nowrap px-3 py-2.5 font-mono text-[11px] text-text-muted">{formatDateTime(call.timestamp)}</td><td className="max-w-[240px] px-3 py-2.5"><p className="truncate font-medium text-text-main">{call.model}</p><p className="mt-0.5 truncate text-[10px] text-text-muted">{call.appName || call.provider}</p></td><td className="whitespace-nowrap px-3 py-2.5 text-right"><span className="text-indigo-500">{fmtTokens(call.promptTokens)}</span><span className="px-1 text-text-muted">/</span><span className="text-emerald-500">{fmtTokens(call.completionTokens)}</span></td><td className="whitespace-nowrap px-3 py-2.5 text-right text-text-main">{formatDuration(call.durationMs)}</td><td className="whitespace-nowrap px-3 py-2.5 text-right text-text-main">{fmtCost(call.cost)}</td><td className="px-3 py-2.5 text-right"><span className={cn("rounded px-2 py-0.5 text-[10px] font-semibold", call.status === "error" ? "bg-rose-500/10 text-rose-600" : call.status === "cancelled" ? "bg-amber-500/10 text-amber-600" : "bg-emerald-500/10 text-emerald-600")}>{call.status}</span></td></tr>)}</tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

MemberProfile.propTypes = { person: PropTypes.object.isRequired, analysis: PropTypes.object.isRequired, recentCalls: PropTypes.array.isRequired, onExport: PropTypes.func.isRequired };

function ProfileView({ analysis, selectedKey, onSelectPerson, searchQuery, onSearchQueryChange, stats, onExportMember }) {
  const roster = useMemo(() => {
    const query = searchQuery.trim().toLocaleLowerCase();
    return analysis.rows.filter((person) => !query || person.displayName.toLocaleLowerCase().includes(query));
  }, [analysis.rows, searchQuery]);
  const person = analysis.rows.find((item) => item.key === selectedKey) || roster[0] || analysis.rows[0];
  const recentCalls = useMemo(() => (stats.recentCallDetails || []).filter((call) => call.userId === person?.userId), [stats.recentCallDetails, person?.userId]);

  if (!person) return <p className="py-12 text-center text-sm text-text-muted">当前统计周期没有人员使用数据。</p>;

  return (
    <div className="grid min-w-0 gap-4 xl:grid-cols-[270px_minmax(0,1fr)]">
      <div className="min-w-0 space-y-3 xl:sticky xl:top-0 xl:self-start"><label className="flex h-9 items-center gap-2 rounded-lg border border-border-subtle bg-bg px-3"><span className="material-symbols-outlined text-[18px] text-text-muted">search</span><input value={searchQuery} onChange={(event) => onSearchQueryChange(event.target.value)} className="min-w-0 flex-1 bg-transparent text-xs text-text-main outline-none placeholder:text-text-muted" placeholder="搜索成员" /></label><MemberList rows={roster} selectedKey={person.key} onSelect={onSelectPerson} /></div>
      <MemberProfile person={person} analysis={analysis} recentCalls={recentCalls} onExport={() => onExportMember(person)} />
    </div>
  );
}

ProfileView.propTypes = { analysis: PropTypes.object.isRequired, selectedKey: PropTypes.string, onSelectPerson: PropTypes.func.isRequired, searchQuery: PropTypes.string.isRequired, onSearchQueryChange: PropTypes.func.isRequired, stats: PropTypes.object.isRequired, onExportMember: PropTypes.func.isRequired };

export default function PersonAnalysisReport({ stats, timeRange }) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState("comparison");
  const [selectedKey, setSelectedKey] = useState(null);
  const [query, setQuery] = useState("");
  const [tierFilter, setTierFilter] = useState("all");
  const [sortBy, setSortBy] = useState("score");
  const [memberSearch, setMemberSearch] = useState("");
  const [scoreRulesOpen, setScoreRulesOpen] = useState(false);
  const drawerBodyRef = useRef(null);

  const analysis = useMemo(() => buildPersonUsageAnalysisFromStats(stats), [stats]);

  const openReport = () => {
    setSelectedKey((current) => current || analysis.rows[0]?.key || null);
    setOpen(true);
  };
  const selectPerson = (key) => {
    setSelectedKey(key);
    setView("profile");
  };
  const selectedPerson = analysis.rows.find((person) => person.key === selectedKey) || analysis.rows[0] || null;
  const exportTeamReport = () => downloadTeamHtmlReport(analysis, timeRange);
  const exportMemberReport = (person = selectedPerson) => {
    if (person) downloadMemberHtmlReport(analysis, timeRange, person);
  };

  useEffect(() => {
    if (view !== "profile") return;
    const frame = requestAnimationFrame(() => {
      drawerBodyRef.current?.scrollTo({ top: 0, behavior: "smooth" });
    });
    return () => cancelAnimationFrame(frame);
  }, [selectedKey, view]);

  return (
    <>
      <button type="button" onClick={openReport} className="inline-flex items-center gap-1.5 rounded-md border border-primary/20 bg-primary/10 px-2.5 py-1 text-xs font-semibold text-primary transition-colors hover:bg-primary/15"><span className="material-symbols-outlined text-[16px]">analytics</span>查看分析报告</button>
      <Drawer isOpen={open} onClose={() => { setOpen(false); setScoreRulesOpen(false); }} title="人员使用分析报告" width="3xl" bodyRef={drawerBodyRef}>
        <div className="flex min-h-0 flex-col gap-5">
          <header className="flex flex-col gap-4 border-b border-border-subtle pb-4 lg:flex-row lg:items-end lg:justify-between"><div><p className="text-[10px] font-bold uppercase tracking-[0.15em] text-primary">PERSONNEL PERFORMANCE REFERENCE</p><h1 className="mt-1 text-xl font-bold text-text-main">全员对比与成员使用报告</h1><p className="mt-1 text-xs text-text-muted">{formatDateRange(timeRange)} · 以 AI 使用规模、持续投入和调用稳定性作为辅助观察维度</p></div><div className="flex flex-wrap items-center justify-between gap-3 lg:max-w-[620px] lg:justify-end"><p className="max-w-md text-xs leading-5 text-text-muted">数据用于绩效复盘参考，不应单独等同于业务产出或最终绩效；建议与岗位目标、交付质量和协作贡献联合评估。</p><nav className="flex shrink-0 rounded-md border border-border-subtle bg-bg p-0.5" aria-label="人员分析报告视图">{[{ id: "comparison", icon: "groups", label: "团队" }, { id: "profile", icon: "person", label: "成员" }].map((item) => <button key={item.id} type="button" onClick={() => setView(item.id)} className={cn("inline-flex items-center gap-1 rounded px-2.5 py-1.5 text-xs font-semibold transition-colors", view === item.id ? "bg-surface text-primary shadow-[var(--shadow-soft)]" : "text-text-muted hover:text-text-main")}><span className="material-symbols-outlined text-[16px]">{item.icon}</span>{item.label}</button>)}</nav></div></header>

          {view === "comparison" ? <ComparisonView analysis={analysis} query={query} onQueryChange={setQuery} tierFilter={tierFilter} onTierFilterChange={setTierFilter} sortBy={sortBy} onSortByChange={setSortBy} onSelectPerson={selectPerson} onOpenScoreRules={() => setScoreRulesOpen(true)} onExportTeam={exportTeamReport} /> : <ProfileView analysis={analysis} selectedKey={selectedKey} onSelectPerson={selectPerson} searchQuery={memberSearch} onSearchQueryChange={setMemberSearch} stats={stats} onExportMember={exportMemberReport} />}
        </div>
      </Drawer>
      <ScoreRulesDrawer isOpen={scoreRulesOpen} onClose={() => setScoreRulesOpen(false)} />
    </>
  );
}

PersonAnalysisReport.propTypes = { stats: PropTypes.object.isRequired, timeRange: PropTypes.shape({ startDate: PropTypes.string, endDate: PropTypes.string }) };
