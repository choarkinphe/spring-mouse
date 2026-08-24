"use client";

import { usePathname } from "next/navigation";

const PAGE_META = [
  { match: (path) => path.startsWith("/dashboard/settings/pricing"), index: "12", title: "计费设置", description: "维护模型单价与成本统计使用的计费规则。", module: "PRICING" },
  { match: (path) => path === "/dashboard/endpoint", index: "01", title: "集成与凭据", description: "管理服务端点、访问密钥与调用安全策略。", module: "INTEGRATIONS" },
  { match: (path) => path.startsWith("/dashboard/providers/new"), index: "02", title: "新增渠道", description: "选择提供商并完成渠道认证配置。", module: "CHANNEL SETUP" },
  { match: (path) => path.startsWith("/dashboard/providers/"), index: "02", title: "渠道配置", description: "管理连接、模型能力与当前渠道的路由选项。", module: "CHANNEL CONFIG" },
  { match: (path) => path === "/dashboard/providers", index: "02", title: "渠道管理", description: "集中管理每个渠道配置、认证连接与可用配额。", module: "CHANNELS" },
  { match: (path) => path.startsWith("/dashboard/combos"), index: "03", title: "路由策略", description: "配置模型组合的调用策略，以及输入能力不足时的自动兜底。", module: "ROUTING" },
  { match: (path) => path.startsWith("/dashboard/media-providers"), index: "04", title: "媒体服务", description: "为图像、语音、视频与嵌入能力配置模型服务。", module: "MEDIA STACK" },
  { match: (path) => path.startsWith("/dashboard/usage"), index: "05", title: "使用情况", description: "查看请求流量、令牌消耗和运行分布。", module: "OBSERVABILITY" },
  { match: (path) => path.startsWith("/dashboard/translator"), index: "08", title: "翻译器", description: "检查不同协议格式之间的请求转换过程。", module: "TRANSLATION" },
  { match: (path) => path.startsWith("/dashboard/console-log"), index: "09", title: "控制台日志", description: "实时查看服务日志与运行状态输出。", module: "SYSTEM LOG" },
  { match: (path) => path.startsWith("/dashboard/basic-chat"), index: "10", title: "基础对话", description: "使用当前路由配置直接验证模型响应。", module: "CHAT" },
  { match: (path) => path.startsWith("/dashboard/pxpipe"), index: "11", title: "PXPIPE", description: "管理本地提示词压缩服务与运行状态。", module: "PROCESSING" },
];

function getPageMeta(pathname) {
  return PAGE_META.find((item) => item.match(pathname)) || {
    index: "00",
    title: "工作台",
    description: "管理 Spring Mouse 的服务能力与运行配置。",
    module: "CONTROL PLANE",
  };
}

export default function DashboardPageFrame({ children }) {
  const pathname = usePathname();
  const meta = getPageMeta(pathname || "");
  const isConsoleLog = pathname?.startsWith("/dashboard/console-log");
  const isWideWorkspace = pathname?.startsWith("/dashboard/usage") || pathname?.startsWith("/dashboard/media-providers") || pathname === "/dashboard/endpoint";

  return (
    <div className={`mx-auto w-full ${isConsoleLog ? "h-full min-h-0 max-w-none pb-0" : isWideWorkspace ? "max-w-[108rem] pb-8" : "max-w-6xl pb-8"}`}>
      {children}
    </div>
  );
}
