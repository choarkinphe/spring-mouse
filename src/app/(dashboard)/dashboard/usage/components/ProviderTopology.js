"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import PropTypes from "prop-types";
import { AI_PROVIDERS } from "@/shared/constants/providers";
import { getProviderIconSrc, markProviderIconMissing } from "@/shared/utils/providerIcon";
import { getTokenMotion, getTopologyRequests, makeTokenPath, tokenCount, INPUT_FLOW_COLOR, OUTPUT_FLOW_COLOR } from "@/shared/utils/topologyTraffic";

const FE_ACTIVE_TICK_MS = 1000;
const EMPTY_REQUESTS = [];
const NODE_FADE_MS = 280;
const LINE_FADE_MS = 360;

function getProviderConfig(providerId) {
  return AI_PROVIDERS[providerId] || { color: "#6b7280", name: providerId };
}

function getProviderImageUrl(providerId) {
  return getProviderIconSrc(providerId);
}

function getCallerLabel(apiKey) {
  if (apiKey?.id === "local" || !apiKey?.id) return "No API key supplied";
  return apiKey.name || "API Key";
}

function ProjectedProvider({ provider, compact }) {
  const [imgError, setImgError] = useState(false);
  const iconSize = compact ? "h-5 w-5" : "h-6 w-6";

  return (
    <div
      className={`flex items-center rounded-lg border-2 bg-bg shadow-sm ${compact ? "gap-1.5 px-2 py-1.5" : "gap-2.5 px-3 py-2"}`}
      style={{ borderColor: provider.color, boxShadow: `0 0 16px ${provider.color}30`, minWidth: compact ? 104 : 150 }}
      title={`${provider.label} · ${provider.count} active requests · ${tokenSummary(provider)}`}
    >
      <div className={`${compact ? "h-6 w-6" : "h-8 w-8"} flex shrink-0 items-center justify-center rounded-md`} style={{ backgroundColor: `${provider.color}18` }}>
        {provider.imageUrl && !imgError ? (
          <img
            src={provider.imageUrl}
            alt={provider.label}
            className={`${iconSize} rounded-sm object-contain`}
            loading="lazy"
            decoding="async"
            onError={() => {
              if (provider.builtinIcon) {
                const match = provider.imageUrl?.match(/^\/providers\/([^/]+)\.png$/i);
                if (match) markProviderIconMissing(match[1]);
              }
              setImgError(true);
            }}
          />
        ) : (
          <span className={compact ? "text-xs font-bold" : "text-sm font-bold"} style={{ color: provider.color }}>{provider.textIcon}</span>
        )}
      </div>
      <span className={`${compact ? "max-w-[74px] text-xs" : "max-w-[120px] text-sm"} truncate font-semibold`} style={{ color: provider.color }}>{provider.label}</span>
      {provider.count > 1 && <span className="rounded-full px-1.5 py-0.5 text-[10px] font-bold text-bg" style={{ backgroundColor: provider.color }}>{provider.count}</span>}
    </div>
  );
}

ProjectedProvider.propTypes = {
  provider: PropTypes.object.isRequired,
  compact: PropTypes.bool.isRequired,
};

function ProjectedApiKey({ caller, compact }) {
  return (
    <div
      className={`flex items-center rounded-lg border border-border bg-bg shadow-sm ${compact ? "gap-1.5 px-2 py-1.5" : "gap-2 px-3 py-2"}`}
      style={{ minWidth: compact ? 108 : 156 }}
      title={`${caller.label} · ${caller.count} active requests · ${tokenSummary(caller)}`}
    >
      <span className={`${compact ? "text-[16px]" : "text-[19px]"} material-symbols-outlined shrink-0 text-primary`} aria-hidden="true">key</span>
      <span className={`${compact ? "max-w-[86px] text-xs" : "max-w-[135px] text-sm"} truncate font-medium text-text`}>{caller.label}</span>
      {caller.count > 1 && <span className="rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] font-bold text-primary">{caller.count}</span>}
    </div>
  );
}

ProjectedApiKey.propTypes = {
  caller: PropTypes.object.isRequired,
  compact: PropTypes.bool.isRequired,
};

function MouseNode({ expanded = false }) {
  return (
    <div className={`relative z-20 flex items-center justify-center transition-[width,height] duration-500 ease-out ${expanded ? "h-48 w-48" : "h-24 w-24"}`}>
      <img src="/favicon.svg" alt="Mouse" className={`topology-router-icon transition-[width,height] duration-500 ease-out ${expanded ? "h-24 w-24" : "h-12 w-12"}`} loading="lazy" decoding="async" />
    </div>
  );
}

MouseNode.propTypes = { expanded: PropTypes.bool };

function getProjectedPositions(count) {
  if (count <= 1) return [50];
  const span = count > 8 ? 88 : count > 5 ? 80 : 68;
  return Array.from({ length: count }, (_, index) => 50 - span / 2 + (span * index) / (count - 1));
}

function buildProjection(requests, nodeMap = {}) {
  const providerMap = new Map();
  const callerMap = new Map();

  requests.forEach((request) => {
    const providerId = request.provider?.toLowerCase() || "unknown";
    const config = getProviderConfig(providerId);
    const node = nodeMap[providerId];
    const isBuiltin = Boolean(AI_PROVIDERS[providerId]);
    const provider = providerMap.get(providerId) || {
      id: providerId,
      label: node?.name || config.name || request.provider || "Unknown provider",
      color: config.color || "#6b7280",
      imageUrl: node?.icon || (isBuiltin ? getProviderImageUrl(providerId) : null),
      builtinIcon: !node?.icon && isBuiltin,
      textIcon: config.textIcon || (node?.name || providerId).slice(0, 2).toUpperCase(),
      count: 0,
      inputTokens: 0,
      outputTokens: 0,
      estimated: false,
    };
    provider.count += request.count ?? 1;
    provider.inputTokens += tokenCount(request.inputTokens);
    provider.outputTokens += tokenCount(request.outputTokens);
    provider.estimated ||= request.tokensEstimated === true;
    providerMap.set(providerId, provider);

    const callerId = request.apiKey?.id || "local";
    const callerLabel = getCallerLabel(request.apiKey);
    const callerKey = `${callerId}:${callerLabel}`;
    const caller = callerMap.get(callerKey) || { id: callerKey, label: callerLabel, count: 0, inputTokens: 0, outputTokens: 0, estimated: false };
    caller.count += request.count ?? 1;
    caller.inputTokens += tokenCount(request.inputTokens);
    caller.outputTokens += tokenCount(request.outputTokens);
    caller.estimated ||= request.tokensEstimated === true;
    callerMap.set(callerKey, caller);
  });

  const providers = [...providerMap.values()];
  const callers = [...callerMap.values()];
  const providerX = getProjectedPositions(providers.length);
  const callerX = getProjectedPositions(callers.length);
  const providerPositions = new Map(providers.map((provider, index) => [provider.id, providerX[index]]));
  const callerPositions = new Map(callers.map((caller, index) => [caller.id, callerX[index]]));

  return { providers, callers, providerPositions, callerPositions };
}

function ProjectionFlow({ x, y, width, height, inputTokens, outputTokens, caller = false }) {
  return (
    <g>
      {[
        { name: "input", tokens: inputTokens, color: INPUT_FLOW_COLOR, inbound: caller, offset: -4 },
        { name: "output", tokens: outputTokens, color: OUTPUT_FLOW_COLOR, inbound: !caller, offset: 4 },
      ].map((lane) => {
        const path = makeTokenPath(x, y, width, height, lane.inbound, lane.offset);
        const motion = getTokenMotion(lane.tokens);
        return (
          <g key={lane.name} data-token-lane={lane.name}>
            <path d={path} fill="none" stroke={lane.color} strokeWidth="7" strokeOpacity={motion.count ? "0.045" : "0.02"} />
            <path d={path} fill="none" stroke={lane.color} strokeWidth="1.25" strokeOpacity={motion.count ? "0.48" : "0.16"} />
            {Array.from({ length: motion.count }, (_, index) => (
              <g
                key={index}
                className="topology-token-particle"
                style={{ offsetPath: `path('${path}')`, offsetRotate: "0deg", "--flow-duration": `${motion.duration}s`, "--flow-delay": `${-index * motion.duration / motion.count}s` }}
              >
                <circle r="5" fill={lane.color} opacity="0.14" />
                <circle r="2.2" fill={lane.color} />
                <circle r="0.85" fill="#f8fafc" opacity="0.95" />
              </g>
            ))}
          </g>
        );
      })}
    </g>
  );
}

ProjectionFlow.propTypes = {
  x: PropTypes.number.isRequired,
  y: PropTypes.number.isRequired,
  width: PropTypes.number.isRequired,
  height: PropTypes.number.isRequired,
  inputTokens: PropTypes.number,
  outputTokens: PropTypes.number,
  caller: PropTypes.bool,
};

function ProjectionLines({ projection, visible }) {
  const svgRef = useRef(null);
  const [size, setSize] = useState({ width: 1000, height: 640 });
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (width > 0 && height > 0) setSize({ width, height });
    });
    observer.observe(svgRef.current);
    return () => observer.disconnect();
  }, []);
  return (
    <svg ref={svgRef} className={`pointer-events-none absolute inset-0 z-0 h-full w-full overflow-visible transition-opacity ease-out ${visible ? "opacity-100" : "opacity-0"}`} style={{ transitionDuration: `${LINE_FADE_MS}ms` }} viewBox={`0 0 ${size.width} ${size.height}`} aria-hidden="true">
      {projection.providers.map((provider) => (
        <ProjectionFlow key={`provider-line-${provider.id}`} x={projection.providerPositions.get(provider.id) * size.width / 100} y={size.height * 0.18} {...size} inputTokens={provider.inputTokens} outputTokens={provider.outputTokens} />
      ))}
      {projection.callers.map((flow) => (
        <ProjectionFlow key={`caller-line-${flow.id}`} x={projection.callerPositions.get(flow.id) * size.width / 100} y={size.height * 0.82} {...size} inputTokens={flow.inputTokens} outputTokens={flow.outputTokens} caller />
      ))}
    </svg>
  );
}

ProjectionLines.propTypes = {
  projection: PropTypes.object.isRequired,
  visible: PropTypes.bool.isRequired,
};

function tokenSummary(item) {
  return `${item.estimated ? "≈ " : ""}输入 ${Math.round(item.inputTokens).toLocaleString()} · 输出 ${Math.round(item.outputTokens).toLocaleString()} Token`;
}

export default function ProviderTopology({ activeRequests = EMPTY_REQUESTS, recentRequests = EMPTY_REQUESTS, className = "" }) {
  const [now, setNow] = useState(() => Date.now());
  const rawRequests = useMemo(() => getTopologyRequests(activeRequests, recentRequests, now), [activeRequests, recentRequests, now]);

  // Custom compatible nodes (openai-compatible-*, anthropic-compatible-*, ...)
  // are not in the AI_PROVIDERS constant — resolve their display name/icon
  // from the provider-nodes table so the topology shows the user-defined
  // channel name instead of the raw node ID.
  const [nodeMap, setNodeMap] = useState({});

  useEffect(() => {
    let cancelled = false;
    fetch("/api/provider-nodes")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled || !data?.nodes) return;
        const map = {};
        for (const node of data.nodes) {
          if (node?.id) map[node.id.toLowerCase()] = { name: node.name, icon: node.icon };
        }
        setNodeMap(map);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    // Refresh the clock on an incoming snapshot too: a completed-only request
    // arriving after a long idle period must not be rejected as "in the future".
    const frame = requestAnimationFrame(() => setNow(Date.now()));
    const timer = rawRequests.length ? setInterval(() => setNow(Date.now()), FE_ACTIVE_TICK_MS) : null;
    return () => {
      cancelAnimationFrame(frame);
      if (timer) clearInterval(timer);
    };
  }, [activeRequests, recentRequests, rawRequests.length]);

  const visibleRequests = rawRequests;
  const projection = useMemo(() => buildProjection(visibleRequests, nodeMap), [visibleRequests, nodeMap]);
  const [renderedProjection, setRenderedProjection] = useState(projection);
  // Retain the last non-empty layout for the exit fade. Adjust it when input
  // changes, rather than cascading a second render from a synchronous effect.
  if (visibleRequests.length > 0 && renderedProjection !== projection) setRenderedProjection(projection);
  const compactProviders = renderedProjection.providers.length > 4;
  const compactCallers = renderedProjection.callers.length > 4;
  const [transitionPhase, setTransitionPhase] = useState("idle");
  const transitionPhaseRef = useRef("idle");
  const transitionTimersRef = useRef([]);

  const setPhase = (nextPhase) => {
    transitionPhaseRef.current = nextPhase;
    setTransitionPhase(nextPhase);
  };
  const clearTransitionTimers = () => {
    transitionTimersRef.current.forEach((timer) => clearTimeout(timer));
    transitionTimersRef.current = [];
  };

  useEffect(() => {
    const hasActiveRoutes = visibleRequests.length > 0;
    const currentPhase = transitionPhaseRef.current;

    if (hasActiveRoutes) {
      if (currentPhase === "idle" || currentPhase === "exit-lines" || currentPhase === "exit-nodes") {
        clearTransitionTimers();
        setPhase("enter-nodes");
        const revealNodes = setTimeout(() => setPhase("nodes-visible"), 20);
        const revealLines = setTimeout(() => setPhase("enter-lines"), NODE_FADE_MS);
        const finishConnection = setTimeout(() => setPhase("connected"), NODE_FADE_MS + LINE_FADE_MS);
        transitionTimersRef.current = [revealNodes, revealLines, finishConnection];
      }
      return undefined;
    }

    if (currentPhase !== "idle" && currentPhase !== "exit-lines" && currentPhase !== "exit-nodes") {
      clearTransitionTimers();
      setPhase("exit-lines");
      const fadeNodes = setTimeout(() => setPhase("exit-nodes"), LINE_FADE_MS);
      const finishExit = setTimeout(() => setPhase("idle"), LINE_FADE_MS + NODE_FADE_MS);
      transitionTimersRef.current = [fadeNodes, finishExit];
    }
    return undefined;
  }, [projection, visibleRequests.length]);

  useEffect(() => () => clearTransitionTimers(), []);

  const showProjection = transitionPhase !== "idle";
  const nodesVisible = ["nodes-visible", "enter-lines", "connected", "exit-lines"].includes(transitionPhase);
  const linesVisible = ["enter-lines", "connected"].includes(transitionPhase);
  const mouseExpanded = !["connected", "exit-lines"].includes(transitionPhase);

  return (
    <div className={`relative h-[427px] w-full min-w-0 overflow-hidden rounded-lg border border-border bg-bg-subtle/30 sm:h-[640px] ${className}`}>
      <div className="pointer-events-none absolute left-4 top-3 z-30 text-[10px] font-semibold uppercase tracking-[0.16em] text-text-muted"><span className="sm:hidden">Providers</span><span className="hidden sm:inline">Responding providers</span></div>
      <div className="absolute right-4 top-3 z-30 flex items-center gap-3 rounded-full border border-border/60 bg-bg/80 px-3 py-1.5 text-[10px] text-text-muted" title="光点数量和速度随活跃请求与最近 6 秒已完成请求的 Token 量变化；上游 usage 优先，缺失时按已接收内容估算，不表示精确 Token/s。悬停节点查看输入/输出量。">
        <span className="flex items-center gap-1.5"><i className="h-1.5 w-1.5 rounded-full bg-blue-500" />↑ 输入</span>
        <span className="flex items-center gap-1.5"><i className="h-1.5 w-1.5 rounded-full bg-emerald-500" />↓ 输出</span>
        <span className="hidden border-l border-border pl-3 sm:inline">Token 流量 · 含估算</span>
      </div>
      <div className="pointer-events-none absolute bottom-3 left-4 z-30 text-[10px] font-semibold uppercase tracking-[0.16em] text-text-muted">Calling API keys</div>

      {!showProjection ? (
        <div className="flex h-full items-center justify-center">
          <div className="topology-idle-state relative flex w-[210px] flex-col items-center text-center">
            <span className="topology-idle-orbit topology-idle-orbit-one" aria-hidden="true" />
            <span className="topology-idle-orbit topology-idle-orbit-two" aria-hidden="true" />
            <div className="relative z-[1] flex h-48 w-48 items-center justify-center">
              <img src="/favicon.svg" alt="Mouse" className="topology-idle-icon h-24 w-24" />
            </div>
            <div className="relative z-[1] mt-4 flex items-center gap-2">
              <span className="text-sm font-bold text-primary">Mouse</span>
              <span className="topology-idle-status flex gap-1" aria-label="Waiting"><i /><i /><i /></span>
            </div>
          </div>
        </div>
      ) : (
        <>
          <ProjectionLines projection={renderedProjection} visible={linesVisible} />
          {renderedProjection.providers.map((provider) => (
            <div
              key={provider.id}
              className={`absolute z-10 -translate-x-1/2 -translate-y-1/2 transition-opacity ease-out ${nodesVisible ? "opacity-100" : "opacity-0"}`}
              style={{ left: `${renderedProjection.providerPositions.get(provider.id)}%`, top: "18%", transitionDuration: `${NODE_FADE_MS}ms` }}
            >
              <ProjectedProvider provider={provider} compact={compactProviders} />
            </div>
          ))}
          <div className="absolute left-1/2 top-1/2 z-20 -translate-x-1/2 -translate-y-1/2">
            <MouseNode expanded={mouseExpanded} />
          </div>
          {renderedProjection.callers.map((caller) => (
            <div
              key={caller.id}
              className={`absolute z-10 -translate-x-1/2 -translate-y-1/2 transition-opacity ease-out ${nodesVisible ? "opacity-100" : "opacity-0"}`}
              style={{ left: `${renderedProjection.callerPositions.get(caller.id)}%`, top: "82%", transitionDuration: `${NODE_FADE_MS}ms` }}
            >
              <ProjectedApiKey caller={caller} compact={compactCallers} />
            </div>
          ))}
        </>
      )}
    </div>
  );
}

ProviderTopology.propTypes = {
  className: PropTypes.string,
  recentRequests: PropTypes.array,
  activeRequests: PropTypes.arrayOf(PropTypes.shape({
    provider: PropTypes.string,
    model: PropTypes.string,
    account: PropTypes.string,
    count: PropTypes.number,
    inputTokens: PropTypes.number,
    outputTokens: PropTypes.number,
    tokensEstimated: PropTypes.bool,
    apiKey: PropTypes.shape({ id: PropTypes.string, name: PropTypes.string }),
  })),
};
