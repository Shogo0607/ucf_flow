import http from "node:http";
import { AuthError, createAuthStore } from "./auth-store.mjs";

const DEFAULT_HOST = process.env.BACKEND_HOST || "127.0.0.1";
const DEFAULT_PORT = Number(process.env.BACKEND_PORT || 3001);
const DEFAULT_FRONTEND_PORT = process.env.FRONTEND_PORT || 8000;
const DEFAULT_CORS_ORIGINS = [
  `http://127.0.0.1:${DEFAULT_FRONTEND_PORT}`,
  `http://localhost:${DEFAULT_FRONTEND_PORT}`,
  `http://[::1]:${DEFAULT_FRONTEND_PORT}`
];
const CORS_METHODS = "GET,POST,PATCH,OPTIONS";
const CORS_HEADERS = "Content-Type,Authorization";
const SESSION_COOKIE = "ucf_session";
const MAX_BODY_BYTES = 1024 * 1024;

function isLoopbackHost(host) {
  return ["127.0.0.1", "localhost", "::1", "[::1]"].includes(String(host || "").toLowerCase());
}

function shouldSeedDemoAccounts(host = DEFAULT_HOST) {
  if (process.env.NODE_ENV === "production") return false;
  if (process.env.AUTH_SEED_DEMO === "1") return true;
  if (process.env.AUTH_SEED_DEMO === "0") return false;
  return isLoopbackHost(host);
}

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
      headers["Access-Control-Allow-Credentials"] = "true";
      return headers;
    }
  };
}

function sendJson(req, res, status, body, corsPolicy, headers = {}) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    ...corsPolicy.headersFor(req),
    ...headers
  });
  res.end(payload);
}

function parseCookie(header) {
  const cookies = {};
  String(header || "").split(";").forEach((part) => {
    const index = part.indexOf("=");
    if (index === -1) return;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) cookies[key] = decodeURIComponent(value);
  });
  return cookies;
}

function sessionCookie(token, expiresAt) {
  const attrs = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Expires=${new Date(expiresAt).toUTCString()}`
  ];
  if (process.env.AUTH_COOKIE_SECURE === "1") attrs.push("Secure");
  return attrs.join("; ");
}

function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new AuthError(413, "body_too_large", "リクエストが大きすぎます。"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("error", reject);
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new AuthError(400, "invalid_json", "JSON の形式が正しくありません。"));
      }
    });
  });
}

async function currentUser(req, authStore) {
  const cookies = parseCookie(req.headers.cookie);
  return authStore.getUserForSession(cookies[SESSION_COOKIE]);
}

async function requireUser(req, authStore) {
  const user = await currentUser(req, authStore);
  if (!user) throw new AuthError(401, "unauthorized", "ログインが必要です。");
  return user;
}

async function requireAdmin(req, authStore) {
  const user = await requireUser(req, authStore);
  if (user.role !== "admin") throw new AuthError(403, "forbidden", "管理者権限が必要です。");
  return user;
}

function authErrorResponse(error) {
  if (error instanceof AuthError) {
    return {
      status: error.status,
      body: { ok: false, code: error.code, error: error.message }
    };
  }
  return {
    status: 500,
    body: { ok: false, code: "internal_error", error: "Internal server error" }
  };
}

function requireAllowedStateChange(req, corsPolicy) {
  if (!["POST", "PATCH"].includes(req.method)) return;
  const origin = req.headers.origin;
  if (origin && !corsPolicy.isOriginAllowed(origin)) {
    throw new AuthError(403, "invalid_origin", "許可されていない Origin からのリクエストです。");
  }
}

export function createBackendServer({ corsOrigins, authStore = createAuthStore() } = {}) {
  const corsPolicy = createCorsPolicy(corsOrigins);

  return http.createServer(async (req, res) => {
    if (req.method === "OPTIONS") {
      const origin = req.headers.origin;
      const isCorsRequest = Boolean(origin);
      const status = !isCorsRequest || corsPolicy.isOriginAllowed(origin) ? 204 : 403;
      res.writeHead(status, corsPolicy.headersFor(req));
      res.end();
      return;
    }

    try {
      await authStore.ensureReady();
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
          endpoints: [
            "/api/health",
            "/api/auth/config",
            "/api/auth/register",
            "/api/auth/login",
            "/api/auth/logout",
            "/api/auth/me",
            "/api/admin/users"
          ]
        }, corsPolicy);
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/auth/config") {
        sendJson(req, res, 200, {
          ok: true,
          demoAccountsEnabled: !!authStore.seedDemoAccounts
        }, corsPolicy);
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/auth/register") {
        requireAllowedStateChange(req, corsPolicy);
        const body = await readJsonBody(req);
        const user = await authStore.createUser(body);
        const login = await authStore.authenticate(body.email, body.password);
        sendJson(req, res, 201, { ok: true, user }, corsPolicy, {
          "Set-Cookie": sessionCookie(login.session.token, login.session.expiresAt)
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/auth/login") {
        requireAllowedStateChange(req, corsPolicy);
        const body = await readJsonBody(req);
        const login = await authStore.authenticate(body.email, body.password);
        sendJson(req, res, 200, { ok: true, user: login.user }, corsPolicy, {
          "Set-Cookie": sessionCookie(login.session.token, login.session.expiresAt)
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/auth/logout") {
        requireAllowedStateChange(req, corsPolicy);
        const cookies = parseCookie(req.headers.cookie);
        if (cookies[SESSION_COOKIE]) await authStore.deleteSession(cookies[SESSION_COOKIE]);
        sendJson(req, res, 200, { ok: true }, corsPolicy, {
          "Set-Cookie": clearSessionCookie()
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/auth/me") {
        const user = await currentUser(req, authStore);
        sendJson(req, res, 200, { ok: true, user }, corsPolicy);
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/admin/users") {
        await requireAdmin(req, authStore);
        sendJson(req, res, 200, { ok: true, users: authStore.listUsers() }, corsPolicy);
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/admin/users") {
        requireAllowedStateChange(req, corsPolicy);
        await requireAdmin(req, authStore);
        const body = await readJsonBody(req);
        const user = await authStore.createUser(body, { allowAdmin: true });
        sendJson(req, res, 201, { ok: true, user }, corsPolicy);
        return;
      }

      const adminUserMatch = url.pathname.match(/^\/api\/admin\/users\/([^/]+)$/);
      if (adminUserMatch && req.method === "PATCH") {
        requireAllowedStateChange(req, corsPolicy);
        const actor = await requireAdmin(req, authStore);
        const body = await readJsonBody(req);
        if (adminUserMatch[1] === actor.id && (body.role != null || body.status != null)) {
          throw new AuthError(400, "self_admin_change", "自分自身のロールまたは状態は変更できません。");
        }
        const user = await authStore.updateUser(adminUserMatch[1], body);
        sendJson(req, res, 200, { ok: true, user }, corsPolicy);
        return;
      }

      const resetMatch = url.pathname.match(/^\/api\/admin\/users\/([^/]+)\/reset-password$/);
      if (resetMatch && req.method === "POST") {
        requireAllowedStateChange(req, corsPolicy);
        const actor = await requireAdmin(req, authStore);
        if (resetMatch[1] === actor.id) {
          throw new AuthError(400, "self_password_reset", "自分自身のパスワードは管理画面から再設定できません。");
        }
        const body = await readJsonBody(req);
        const user = await authStore.resetPassword(resetMatch[1], body.password);
        sendJson(req, res, 200, { ok: true, user }, corsPolicy);
        return;
      }

      const statusMatch = url.pathname.match(/^\/api\/admin\/users\/([^/]+)\/(disable|enable)$/);
      if (statusMatch && req.method === "POST") {
        requireAllowedStateChange(req, corsPolicy);
        const actor = await requireAdmin(req, authStore);
        if (statusMatch[1] === actor.id) {
          throw new AuthError(400, "self_admin_change", "自分自身の状態は変更できません。");
        }
        const user = await authStore.updateUser(statusMatch[1], {
          status: statusMatch[2] === "disable" ? "disabled" : "active"
        });
        sendJson(req, res, 200, { ok: true, user }, corsPolicy);
        return;
      }

      sendJson(req, res, 404, {
        ok: false,
        error: "Not found"
      }, corsPolicy);
    } catch (error) {
      const response = authErrorResponse(error);
      if (response.status === 500) console.error(error);
      sendJson(req, res, response.status, response.body, corsPolicy);
    }
  });
}

export function listenBackend({ host = DEFAULT_HOST, port = DEFAULT_PORT, corsOrigins, authStore } = {}) {
  const store = authStore || createAuthStore({ seedDemoAccounts: shouldSeedDemoAccounts(host) });
  const server = createBackendServer({ corsOrigins, authStore: store });
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
