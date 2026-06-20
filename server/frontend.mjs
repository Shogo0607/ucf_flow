import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_HOST = process.env.FRONTEND_HOST || "127.0.0.1";
const DEFAULT_PORT = Number(process.env.FRONTEND_PORT || 8000);
const DEFAULT_ROOT = path.resolve(__dirname, "..", "src");
const DEFAULT_ENTRY = "フロー化ツール（A・パイプライン）.dc.html";

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp"
};

function send(res, status, body, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function resolveRequestPath(root, pathname) {
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    return null;
  }

  const requestedPath = decodedPath === "/" ? DEFAULT_ENTRY : decodedPath.replace(/^\/+/, "");
  const filePath = path.resolve(root, requestedPath);
  const relative = path.relative(root, filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return filePath;
}

export function createFrontendServer({ root = DEFAULT_ROOT } = {}) {
  return http.createServer((req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      send(res, 405, "Method not allowed");
      return;
    }

    const url = new URL(req.url || "/", "http://localhost");

    const filePath = resolveRequestPath(root, url.pathname);
    if (!filePath) {
      send(res, 400, "Bad request");
      return;
    }

    fs.stat(filePath, (statErr, stats) => {
      if (statErr || !stats.isFile()) {
        send(res, 404, "Not found");
        return;
      }

      const contentType = MIME_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream";
      res.writeHead(200, {
        "Content-Type": contentType,
        "Content-Length": stats.size,
        "Cache-Control": "no-store"
      });

      if (req.method === "HEAD") {
        res.end();
        return;
      }

      fs.createReadStream(filePath).pipe(res);
    });
  });
}

export function listenFrontend({ host = DEFAULT_HOST, port = DEFAULT_PORT, root = DEFAULT_ROOT } = {}) {
  const server = createFrontendServer({ root });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve({ server, host, port, root });
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  listenFrontend()
    .then(({ host, port, root }) => {
      console.log(`Frontend: http://${host}:${port}`);
      console.log(`Serving:  ${root}`);
    })
    .catch((err) => {
      console.error(`Frontend failed to start: ${err.message}`);
      process.exit(1);
    });
}
