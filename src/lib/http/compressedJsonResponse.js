import { gzipSync } from "node:zlib";

// Next compresses rendered pages and static assets, but App Router *route
// handlers* return straight to the socket and bypass that middleware. The big
// dashboard JSON reads (/api/models is ~890KB, /api/models/custom ~770KB) were
// therefore sent uncompressed — 17x and 8x larger than they need to be, which
// is what made the model list crawl over a slow link.
//
// Compression is applied per response here rather than globally so streaming
// routes (SSE) keep flowing unbuffered: only the buffered JSON reads opt in.

// Below this size the gzip header overhead outweighs the saving, and tiny
// payloads are not what makes the dashboard slow.
const MIN_COMPRESS_BYTES = 1400;

function acceptsGzip(request) {
  const header = request?.headers?.get?.("accept-encoding") || "";
  if (!header) return false;
  // "gzip;q=0" is an explicit refusal; a bare "gzip" (no q) is an acceptance.
  return header.split(",").some((part) => {
    const [token, ...params] = part.trim().toLowerCase().split(";");
    if (token !== "gzip" && token !== "*") return false;
    const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
    return !q || Number.parseFloat(q.slice(2)) > 0;
  });
}

/**
 * JSON response that gzips when the client accepts it and the body is worth
 * compressing. Falls back to a plain JSON response otherwise (and if anything
 * about the compression path throws), so callers never regress to an error.
 *
 * @param {Request} request  the incoming request (for Accept-Encoding)
 * @param {unknown} data     the JSON-serializable body
 * @param {object} [options] { status, headers }
 */
export function compressedJsonResponse(request, data, { status = 200, headers = {} } = {}) {
  const body = JSON.stringify(data);

  if (!acceptsGzip(request)) {
    return new Response(body, {
      status,
      headers: { ...headers, "Content-Type": "application/json" },
    });
  }

  const raw = Buffer.from(body, "utf8");
  if (raw.byteLength < MIN_COMPRESS_BYTES) {
    return new Response(body, {
      status,
      headers: { ...headers, "Content-Type": "application/json" },
    });
  }

  try {
    const compressed = gzipSync(raw);
    return new Response(compressed, {
      status,
      headers: {
        ...headers,
        "Content-Type": "application/json",
        "Content-Encoding": "gzip",
        // Caches must key on the encoding, or a gzip body gets served to a
        // client that asked for identity.
        Vary: headers.Vary ? `${headers.Vary}, Accept-Encoding` : "Accept-Encoding",
      },
    });
  } catch {
    return new Response(body, {
      status,
      headers: { ...headers, "Content-Type": "application/json" },
    });
  }
}
