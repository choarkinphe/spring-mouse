"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import PropTypes from "prop-types";
import { AI_PROVIDERS } from "@/shared/constants/providers";
import { getProviderIconSrc, markProviderIconMissing } from "@/shared/utils/providerIcon";

const FE_ACTIVE_TIMEOUT_MS = 60000;
const FE_ACTIVE_TICK_MS = 1000;
const STABLE_CALLER_TTL_MS = 60000;
const NODE_FADE_MS = 280;
const LINE_FADE_MS = 360;

function getProviderConfig(providerId) {
  return AI_PROVIDERS[providerId] || { color: "#6b7280", name: providerId };
}

function getProviderImageUrl(providerId) {
  return getProviderIconSrc(providerId);
}

function getRequestKey(request) {
  return [
    request.provider || "unknown",
    request.account || "",
    request.apiKey?.id || "local",
    request.apiKey?.name || "",
    request.model || "",
  ].join("|");
}

function getCallerRouteKey(request) {
  return [request.provider || "unknown", request.account || "", request.model || ""].join("|");
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
      title={`${provider.label}${provider.count > 1 ? ` · ${provider.count} active requests` : ""}`}
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
      title={`${caller.label}${caller.count > 1 ? ` · ${caller.count} active requests` : ""}`}
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

function makePath(x, y, direction = "outbound") {
  const middleY = 50;
  const verticalDirection = y < middleY ? -1 : 1;
  const bendY = middleY + verticalDirection * 10;
  const endBendY = y - verticalDirection * 8;

  // Providers receive traffic from Mouse (outbound); API keys send traffic
  // into Mouse (inbound), so particles always follow the real request path.
  if (direction === "inbound") {
    return `M ${x} ${y} C ${x} ${endBendY}, 50 ${bendY}, 50 ${middleY}`;
  }
  return `M 50 ${middleY} C 50 ${bendY}, ${x} ${endBendY}, ${x} ${y}`;
}

function buildProjection(requests, nodeMap = {}) {
  const providerMap = new Map();
  const callerMap = new Map();
  const callerFlows = [];
  const callerFlowKeys = new Set();

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
    };
    provider.count += request.count || 1;
    providerMap.set(providerId, provider);

    const callerId = request.apiKey?.id || "local";
    const callerLabel = getCallerLabel(request.apiKey);
    const callerKey = `${callerId}:${callerLabel}`;
    const caller = callerMap.get(callerKey) || { id: callerKey, label: callerLabel, count: 0 };
    caller.count += request.count || 1;
    callerMap.set(callerKey, caller);
    const flowKey = `${callerKey}|${providerId}`;
    if (!callerFlowKeys.has(flowKey)) {
      callerFlowKeys.add(flowKey);
      callerFlows.push({ callerKey, providerId, color: provider.color });
    }
  });

  const providers = [...providerMap.values()];
  const callers = [...callerMap.values()];
  const providerX = getProjectedPositions(providers.length);
  const callerX = getProjectedPositions(callers.length);
  const providerPositions = new Map(providers.map((provider, index) => [provider.id, providerX[index]]));
  const callerPositions = new Map(callers.map((caller, index) => [caller.id, callerX[index]]));

  return { providers, callers, providerPositions, callerPositions, callerFlows };
}

function ProjectionFlow({ id, x, y, color, direction = "outbound" }) {
  const path = makePath(x, y, direction);
  const startX = direction === "inbound" ? x : 50;
  const startY = direction === "inbound" ? y : 50;
  const endX = direction === "inbound" ? 50 : x;
  const endY = direction === "inbound" ? 50 : y;
  const gradientId = `topology-gradient-${id}`;
  const glowId = `topology-glow-${id}`;

  return (
    <g>
      <defs>
        <linearGradient id={gradientId} gradientUnits="userSpaceOnUse" x1={startX} y1={startY} x2={endX} y2={endY}>
          <stop offset="0%" stopColor={color} stopOpacity="0.95" />
          <stop offset="28%" stopColor={color} stopOpacity="0.62" />
          <stop offset="100%" stopColor={color} stopOpacity="0.16" />
        </linearGradient>
        <filter id={glowId} x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur stdDeviation="0.55" result="blur" />
          <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>
      <path d={path} fill="none" stroke={color} strokeWidth="1.65" strokeOpacity="0.08" strokeLinecap="round" />
      <path d={path} fill="none" stroke={`url(#${gradientId})`} strokeWidth="0.4" strokeLinecap="round" />
      <circle r="0.62" fill={color} filter={`url(#${glowId})`}>
        <animateMotion dur="1.35s" repeatCount="indefinite" path={path} />
        <animate attributeName="opacity" values="0;1;1;0" dur="1.35s" repeatCount="indefinite" />
      </circle>
      <circle r="0.38" fill="#f8fafc" opacity="0.92">
        <animateMotion dur="1.35s" repeatCount="indefinite" path={path} begin="0.42s" />
        <animate attributeName="opacity" values="0;1;1;0" dur="1.35s" begin="0.42s" repeatCount="indefinite" />
      </circle>
    </g>
  );
}

ProjectionFlow.propTypes = {
  id: PropTypes.string.isRequired,
  x: PropTypes.number.isRequired,
  y: PropTypes.number.isRequired,
  color: PropTypes.string.isRequired,
  direction: PropTypes.oneOf(["inbound", "outbound"]),
};

function ProjectionLines({ projection, visible }) {
  return (
    <svg className={`pointer-events-none absolute inset-0 z-0 h-full w-full overflow-visible transition-opacity ease-out ${visible ? "opacity-100" : "opacity-0"}`} style={{ transitionDuration: `${LINE_FADE_MS}ms` }} viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
      {projection.providers.map((provider) => (
        <ProjectionFlow key={`provider-line-${provider.id}`} id={`provider-${provider.id}`} x={projection.providerPositions.get(provider.id)} y={18} color={provider.color} />
      ))}
      {projection.callerFlows.map((flow, index) => (
        <ProjectionFlow key={`caller-line-${flow.callerKey}-${flow.providerId}`} id={`caller-${index}`} x={projection.callerPositions.get(flow.callerKey)} y={82} color={flow.color} direction="inbound" />
      ))}
    </svg>
  );
}

ProjectionLines.propTypes = {
  projection: PropTypes.object.isRequired,
  visible: PropTypes.bool.isRequired,
};

export default function ProviderTopology({ activeRequests = [], className = "" }) {
  const rawRequests = useMemo(() => activeRequests.filter((request) => request?.provider), [activeRequests]);
  const requestKey = useMemo(() => rawRequests.map(getRequestKey).sort().join(","), [rawRequests]);
  const firstSeenRef = useRef({});
  const callerMemoryRef = useRef({});
  const [tick, setTick] = useState(0);

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
    const now = Date.now();
    const nextKeys = new Set(rawRequests.map(getRequestKey));
    for (const request of rawRequests) {
      const key = getRequestKey(request);
      if (!firstSeenRef.current[key]) firstSeenRef.current[key] = now;

      // Keep a known key attached to the same provider/account/model route while
      // a stream sends a transient request update without its authorization data.
      if (request.apiKey?.id && request.apiKey.id !== "local") {
        callerMemoryRef.current[getCallerRouteKey(request)] = { apiKey: request.apiKey, seenAt: now };
      }
    }
    for (const key of Object.keys(firstSeenRef.current)) {
      if (!nextKeys.has(key)) delete firstSeenRef.current[key];
    }
    for (const [key, value] of Object.entries(callerMemoryRef.current)) {
      if (now - value.seenAt > STABLE_CALLER_TTL_MS) delete callerMemoryRef.current[key];
    }
  }, [rawRequests, requestKey]);

  useEffect(() => {
    if (!rawRequests.length) return undefined;
    const timer = setInterval(() => setTick((value) => value + 1), FE_ACTIVE_TICK_MS);
    return () => clearInterval(timer);
  }, [rawRequests.length]);

  const visibleRequests = useMemo(() => {
    const now = Date.now();
    return rawRequests
      .filter((request) => now - (firstSeenRef.current[getRequestKey(request)] || now) < FE_ACTIVE_TIMEOUT_MS)
      .map((request) => {
        if (request.apiKey?.id && request.apiKey.id !== "local") return request;
        const remembered = callerMemoryRef.current[getCallerRouteKey(request)];
        return remembered ? { ...request, apiKey: remembered.apiKey } : request;
      });
  }, [rawRequests, requestKey, tick]);

  const projection = useMemo(() => buildProjection(visibleRequests, nodeMap), [visibleRequests, nodeMap]);
  const [renderedProjection, setRenderedProjection] = useState(() => buildProjection([]));
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
      setRenderedProjection(projection);
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
      <div className="pointer-events-none absolute left-4 top-3 z-30 text-[10px] font-semibold uppercase tracking-[0.16em] text-text-muted">Responding providers</div>
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
  activeRequests: PropTypes.arrayOf(PropTypes.shape({
    provider: PropTypes.string,
    model: PropTypes.string,
    account: PropTypes.string,
    count: PropTypes.number,
    apiKey: PropTypes.shape({ id: PropTypes.string, name: PropTypes.string }),
  })),
};
