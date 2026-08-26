export function compactJsonField(value, maxChars) {
  const normalized = value || {};
  const serialized = JSON.stringify(normalized);
  if (serialized.length <= maxChars) return normalized;

  return {
    _truncated: true,
    _originalSize: serialized.length,
    _preview: serialized.slice(0, 200),
  };
}
