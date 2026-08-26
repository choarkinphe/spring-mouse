export function formatBytes(value, { maximumFractionDigits = 1 } = {}) {
  const bytes = Math.max(0, Number(value) || 0);
  if (bytes < 1024) return `${Math.round(bytes)} B`;

  const units = ["KB", "MB", "GB", "TB"];
  let size = bytes / 1024;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  return `${new Intl.NumberFormat("zh-CN", {
    maximumFractionDigits,
    minimumFractionDigits: size < 10 ? Math.min(1, maximumFractionDigits) : 0,
  }).format(size)} ${units[unitIndex]}`;
}
