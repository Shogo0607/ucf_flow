import http from "node:http";

const DEFAULT_HOST = process.env.BACKEND_HOST || "127.0.0.1";
const DEFAULT_PORT = Number(process.env.BACKEND_PORT || 3001);

function sendJson(res, status, body) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization"
  });
  res.end(payload);
}

export function createBackendServer() {
  return http.createServer((req, res) => {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type,Authorization"
      });
      res.end();
      return;
    }

    const url = new URL(req.url || "/", "http://localhost");

    if (req.method === "GET" && url.pathname === "/api/health") {
      sendJson(res, 200, {
        ok: true,
        service: "ucf-flow-backend",
        time: new Date().toISOString()
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api") {
      sendJson(res, 200, {
        ok: true,
        endpoints: ["/api/health"]
      });
      return;
    }

    sendJson(res, 404, {
      ok: false,
      error: "Not found"
    });
  });
}

export function listenBackend({ host = DEFAULT_HOST, port = DEFAULT_PORT } = {}) {
  const server = createBackendServer();
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
