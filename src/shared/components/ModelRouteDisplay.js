"use client";

import PropTypes from "prop-types";
import { cn } from "@/shared/utils/cn";
import { isModelRouted, normalizeModelRouting } from "@/shared/utils/modelRouting.js";

function clean(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

/**
 * Compact, shared rendering for the model the client requested and the model
 * that actually handled the request. Older rows only have `model`, so those
 * naturally render as a single model name.
 */
export default function ModelRouteDisplay({
  record = {},
  className = "",
  compact = false,
  showLabels = true,
  wrap = false,
}) {
  const { originalModel, executedModel } = normalizeModelRouting(record);
  const originalLabel = originalModel || clean(record.model) || "—";
  const executedLabel = executedModel || originalLabel;
  const routed = isModelRouted(record);
  const modelClassName = wrap ? "break-words" : "truncate";

  if (!routed) {
    return (
      <div className={cn("min-w-0", className)} title={originalLabel}>
        <span className={cn("block font-mono text-text-main", modelClassName)}>{originalLabel}</span>
      </div>
    );
  }

  return (
    <div className={cn("min-w-0 space-y-0.5", className)} title={`原始：${originalLabel} → 实际：${executedLabel}`}>
      <div className="flex min-w-0 items-start gap-1">
        {showLabels && <span className="shrink-0 text-[10px] font-semibold text-primary">原始：</span>}
        <span className={cn("min-w-0", modelClassName, "font-medium text-primary")}>{originalLabel}</span>
      </div>
      <div className="flex min-w-0 items-start gap-1">
        <span className="shrink-0 text-[10px] font-semibold text-text-muted">→{showLabels ? " 实际：" : ""}</span>
        <span className={cn("min-w-0", modelClassName, "font-mono text-text-main", compact ? "text-[11px]" : "text-xs")}>{executedLabel}</span>
      </div>
    </div>
  );
}

ModelRouteDisplay.propTypes = {
  record: PropTypes.shape({
    model: PropTypes.string,
    originalModel: PropTypes.string,
    executedModel: PropTypes.string,
    routing: PropTypes.shape({
      originalModel: PropTypes.string,
      executedModel: PropTypes.string,
    }),
  }),
  className: PropTypes.string,
  compact: PropTypes.bool,
  showLabels: PropTypes.bool,
  wrap: PropTypes.bool,
};
