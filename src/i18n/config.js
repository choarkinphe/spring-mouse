// 多语言支持已移除：应用固定使用简体中文
export const LOCALES = ["zh-CN"];
export const DEFAULT_LOCALE = "zh-CN";
export const LOCALE_COOKIE = "locale";

export const LOCALE_NAMES = {
  "zh-CN": "简体中文",
};

// 兼容保留：规范化locale，非中统一回落 zh-CN
export function normalizeLocale(locale) {
  return locale === "zh-CN" ? "zh-CN" : "zh-CN";
}
