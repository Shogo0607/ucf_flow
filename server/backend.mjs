import http from "node:http";

const DEFAULT_HOST = process.env.BACKEND_HOST || "127.0.0.1";
const DEFAULT_PORT = Number(process.env.BACKEND_PORT || 3001);
const DEFAULT_CORS_ORIGINS = [
  "http://127.0.0.1:8000",
  "http://localhost:8000",
  "http://[::1]:8000"
];
const CORS_METHODS = "GET,POST,OPTIONS";
const CORS_HEADERS = "Content-Type,Authorization";

function parseCorsOrigins(value) {
  if (!value) return DEFAULT_CORS_ORIGINS;
  return value
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function createCorsPolicy(origins = parseCorsOrigins(process.env.BACKEND_CORS_ORIGINS)) {
  const allowedOrigins = new Set(origins);
  const allowAnyOrigin = allowedOrigins.has("*");

  return {
    isOriginAllowed(origin) {
      return Boolean(origin && (allowAnyOrigin || allowedOrigins.has(origin)));
    },

    headersFor(req) {
      const origin = req.headers.origin;
      const headers = { Vary: "Origin" };
      if (!this.isOriginAllowed(origin)) return headers;

      headers["Access-Control-Allow-Origin"] = allowAnyOrigin ? "*" : origin;
      headers["Access-Control-Allow-Methods"] = CORS_METHODS;
      headers["Access-Control-Allow-Headers"] = req.headers["access-control-request-headers"] || CORS_HEADERS;
      return headers;
    }
  };
}

function sendJson(req, res, status, body, corsPolicy) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    ...corsPolicy.headersFor(req)
  });
  res.end(payload);
}

export function createBackendServer({ corsOrigins } = {}) {
  const corsPolicy = createCorsPolicy(corsOrigins);

  return http.createServer((req, res) => {
    if (req.method === "OPTIONS") {
      const origin = req.headers.origin;
      const isCorsRequest = Boolean(origin);
      const status = !isCorsRequest || corsPolicy.isOriginAllowed(origin) ? 204 : 403;
      res.writeHead(status, corsPolicy.headersFor(req));
      res.end();
      return;
    }

    const url = new URL(req.url || "/", "http://localhost");

    if (req.method === "GET" && url.pathname === "/api/health") {
      sendJson(req, res, 200, {
        ok: true,
        service: "ucf-flow-backend",
        time: new Date().toISOString()
      }, corsPolicy);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api") {
      sendJson(req, res, 200, {
        ok: true,
        endpoints: ["/api/health"]
      }, corsPolicy);
      return;
    }

    sendJson(req, res, 404, {
      ok: false,
      error: "Not found"
    }, corsPolicy);
  });
}

export function listenBackend({ host = DEFAULT_HOST, port = DEFAULT_PORT, corsOrigins } = {}) {
  const server = createBackendServer({ corsOrigins });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve({ server, host, port });
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  listenBackend()
    .then(({ host, port }) => {
      console.log(`Backend: http://${host}:${port}`);
      console.log(`Health:  http://${host}:${port}/api/health`);
    })
    .catch((err) => {
      console.error(`Backend failed to start: ${err.message}`);
      process.exit(1);
    });
}
