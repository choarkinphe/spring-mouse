"use client";

import PropTypes from "prop-types";
import { formatRate } from "@/shared/hooks/useModelPricing";

export default function ModelPricingBadge({ pricing, creditBilling, billingMode, loaded = false }) {
  if (creditBilling?.unit === "credits") {
    const rate = creditBilling.multiplier;
    const known = typeof rate === "number" && Number.isFinite(rate) && rate >= 0;
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded border border-emerald-500/25 bg-emerald-500/10 px-1.5 py-0.5 font-mono text-[10px] text-emerald-600"
        title={known ? "官方积分消耗倍率，不是美元/token 单价；实际扣点以供应商账单为准" : "使用积分计费；请同步官方模型目录获取倍率，不套用美元/token 价格"}>
        {known ? (rate === 0 ? "免费" : `积分 ${rate}×`) : "积分 · 倍率未知"}
        {known && creditBilling.originalMultiplier > rate && <del className="text-text-muted">{creditBilling.originalMultiplier}×</del>}
      </span>
    );
  }
  if (billingMode === "subscription" || billingMode === "free") {
    return <span className="shrink-0 rounded border border-border-subtle bg-surface-2 px-1.5 py-0.5 text-[10px] text-text-muted" title="Token 用量照常统计；订阅费用在账号中记录，不使用模型单价计算实际支出">{billingMode === "free" ? "免费账号" : "订阅内使用"}</span>;
  }
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
      title="尚无适用的模型费率，无法估算按量费用；不代表免费。可同步参考定价或手动配置实际渠道费率。"
    >
      未定价
    </span>
  );
}

ModelPricingBadge.propTypes = {
  pricing: PropTypes.shape({ input: PropTypes.number, output: PropTypes.number }),
  loaded: PropTypes.bool,
  billingMode: PropTypes.string,
  creditBilling: PropTypes.shape({ unit: PropTypes.string, multiplier: PropTypes.number, originalMultiplier: PropTypes.number }),
};
