"use client";

import PropTypes from "prop-types";
import { formatRate } from "@/shared/hooks/useModelPricing";

export default function ModelPricingBadge({ pricing, loaded = false }) {
  if (!loaded) return null;
  return pricing ? (
    <span
      className="shrink-0 rounded border border-emerald-500/25 bg-emerald-500/10 px-1.5 py-0.5 font-mono text-[10px] text-emerald-600"
      title={`输入 ${formatRate(pricing.input)} / 输出 ${formatRate(pricing.output)} 每百万 token`}
    >
      {formatRate(pricing.input)}/{formatRate(pricing.output)}
    </span>
  ) : (
    <span
      className="shrink-0 rounded border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 font-mono text-[10px] text-amber-600"
      title="未配置定价，该模型的所有请求成本都会记为 $0。可在本页「同步定价」或计费设置中补全。"
    >
      未定价
    </span>
  );
}

ModelPricingBadge.propTypes = {
  pricing: PropTypes.shape({ input: PropTypes.number, output: PropTypes.number }),
  loaded: PropTypes.bool,
};
