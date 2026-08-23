export const WENYAN_LOCALES = ["zh-CN", "zh-TW"];

export const CAVEMAN_LEVELS = [
  { id: "lite", label: "轻度", desc: "去掉口水词，保留完整语法" },
  { id: "full", label: "标准", desc: "省略冠词，允许碎片化短句" },
  { id: "ultra", label: "极限", desc: "电报体，最大压缩" },
  { id: "wenyan-lite", label: "文言·轻", desc: "文言文轻度压缩", wenyan: true },
  { id: "wenyan", label: "文言·重", desc: "文言文重度压缩，省 80-90%", wenyan: true },
  { id: "wenyan-ultra", label: "文言·极", desc: "文言文极限压缩", wenyan: true },
];

export const PONYTAIL_LEVELS = [
  { id: "lite", label: "轻度", desc: "只做被要求的事，顺带提示更省的做法" },
  { id: "full", label: "标准", desc: "强制选型阶梯：标准库/原生优先" },
  { id: "ultra", label: "极限", desc: "YAGNI 极端化，删除优先" },
];
