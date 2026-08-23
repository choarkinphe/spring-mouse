// Provider connections may still carry a direct, per-connection proxy for
// backwards compatibility. The retired proxy-pool / relay feature is no
// longer resolved or available to provider requests.
function normalizeString(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

export async function resolveConnectionProxyConfig(providerSpecificData = {}) {
  const connectionProxyEnabled = providerSpecificData?.connectionProxyEnabled === true;
  const connectionProxyUrl = normalizeString(providerSpecificData?.connectionProxyUrl);
  const connectionNoProxy = normalizeString(providerSpecificData?.connectionNoProxy);

  if (connectionProxyEnabled && connectionProxyUrl) {
    return {
      source: "connection",
      connectionProxyEnabled,
      connectionProxyUrl,
      connectionNoProxy,
      strictProxy: false,
    };
  }

  return {
    source: "none",
    connectionProxyEnabled: false,
    connectionProxyUrl: "",
    connectionNoProxy: "",
    strictProxy: false,
  };
}
