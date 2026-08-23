// x-sm-real-ip is only trustworthy when custom-server.js stamped it from the TCP socket.
// It proves that by echoing the per-process secret it generated at boot, which a client
// cannot guess. Accept the legacy x-9r alias while local clients complete migration.
export function hasTrustedPeerHeaders(request) {
  const token = process.env.SPRING_MOUSE_PEER_TOKEN || process.env.NINEROUTER_PEER_TOKEN;
  if (!token) return false;
  return request.headers.get("x-sm-peer-token") === token
    || request.headers.get("x-9r-peer-token") === token;
}
