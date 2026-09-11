// Boolean capability flags exposed by the capability editor, grouped for display.
// `key` matches the runtime capability names in open-sse/providers/capabilities.js
// and MODEL_CAPABILITY_KEYS in shared/utils/modelCatalog.js.
//
// Single source of truth shared by ModelCapabilitiesModal (per-model editor) and
// AddModelDrawer (add-model flow) so the two never drift apart.
export const CAPABILITY_GROUPS = [
  {
    title: "输入模态",
    items: [
      { key: "vision", label: "视觉 / 图片", hint: "可读图片（多模态）" },
      { key: "pdf", label: "PDF / 文档", hint: "可读 PDF、文档" },
      { key: "audioInput", label: "音频输入", hint: "可读音频" },
      { key: "videoInput", label: "视频输入", hint: "可读视频" },
    ],
  },
  {
    title: "输出模态",
    items: [
      { key: "imageOutput", label: "图像生成", hint: "可输出图片" },
      { key: "audioOutput", label: "音频生成", hint: "可输出语音" },
    ],
  },
  {
    title: "能力特性",
    items: [
      { key: "reasoning", label: "思考 / 推理", hint: "支持 thinking" },
      { key: "search", label: "联网搜索", hint: "自带联网检索" },
      { key: "tools", label: "工具调用", hint: "支持 function calling" },
    ],
  },
];

export const CAPABILITY_BOOLEAN_KEYS = CAPABILITY_GROUPS.flatMap((group) => group.items.map((item) => item.key));

export function createCapabilityDraft(caps = {}) {
  const draft = {};
  for (const key of CAPABILITY_BOOLEAN_KEYS) draft[key] = caps?.[key] === true;
  draft.contextWindow = Number.isFinite(caps?.contextWindow) && caps.contextWindow > 0 ? String(caps.contextWindow) : "";
  draft.maxOutput = Number.isFinite(caps?.maxOutput) && caps.maxOutput > 0 ? String(caps.maxOutput) : "";
  return draft;
}

export function capabilitiesFromDraft(draft = {}) {
  const out = {};
  for (const key of CAPABILITY_BOOLEAN_KEYS) {
    if (draft[key] === true) out[key] = true;
  }
  const contextWindow = Number.parseInt(draft.contextWindow, 10);
  if (Number.isFinite(contextWindow) && contextWindow > 0) out.contextWindow = contextWindow;
  const maxOutput = Number.parseInt(draft.maxOutput, 10);
  if (Number.isFinite(maxOutput) && maxOutput > 0) out.maxOutput = maxOutput;
  return out;
}
