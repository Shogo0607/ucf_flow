import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createAuthStore } from "../server/auth-store.mjs";
import { createBackendServer } from "../server/backend.mjs";

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server.address().port);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function cookieFrom(response) {
  const value = response.headers["set-cookie"];
  const first = Array.isArray(value) ? value[0] : value;
  return first ? first.split(";")[0] : "";
}

function request(port, { method = "GET", path = "/api/health", body, cookie, headers = {} } = {}) {
  const payload = body == null ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port,
      method,
      path,
      headers: {
        ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...headers
      }
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: raw ? JSON.parse(raw) : null
        });
      });
    });

    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function withAuthServer(fn) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ucf-auth-"));
  const authStore = createAuthStore({
    filePath: path.join(tempDir, "auth.json"),
    seedDemoAccounts: true
  });
  const server = createBackendServer({ authStore, corsOrigins: ["http://127.0.0.1:8000"] });
  const port = await listen(server);
  try {
    await fn(port);
  } finally {
    await close(server);
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

test("demo admin and user accounts are seeded and can log in", async () => {
  await withAuthServer(async (port) => {
    const admin = await request(port, {
      method: "POST",
      path: "/api/auth/login",
      body: { email: "admin@example.test", password: "Password123!" }
    });

    assert.equal(admin.statusCode, 200);
    assert.equal(admin.body.user.role, "admin");
    assert.match(cookieFrom(admin), /^ucf_session=/);

    const user = await request(port, {
      method: "POST",
      path: "/api/auth/login",
      body: { email: "user@example.test", password: "Password123!" }
    });

    assert.equal(user.statusCode, 200);
    assert.equal(user.body.user.role, "user");
  });
});

test("registration creates a normal user, rejects duplicates, and exposes /me through the session", async () => {
  await withAuthServer(async (port) => {
    const created = await request(port, {
      method: "POST",
      path: "/api/auth/register",
      body: { email: "new@example.test", name: "新規ユーザ", password: "Password123!" }
    });

    assert.equal(created.statusCode, 201);
    assert.equal(created.body.user.role, "user");
    assert.equal(created.body.user.email, "new@example.test");

    const me = await request(port, {
      path: "/api/auth/me",
      cookie: cookieFrom(created)
    });
    assert.equal(me.statusCode, 200);
    assert.equal(me.body.user.email, "new@example.test");

    const duplicate = await request(port, {
      method: "POST",
      path: "/api/auth/register",
      body: { email: "new@example.test", name: "重複", password: "Password123!" }
    });
    assert.equal(duplicate.statusCode, 409);
    assert.equal(duplicate.body.code, "email_exists");
  });
});

test("admin user management requires admin role and supports create, update, disable, enable, and password reset", async () => {
  await withAuthServer(async (port) => {
    const normalLogin = await request(port, {
      method: "POST",
      path: "/api/auth/login",
      body: { email: "user@example.test", password: "Password123!" }
    });
    const denied = await request(port, {
      path: "/api/admin/users",
      cookie: cookieFrom(normalLogin)
    });
    assert.equal(denied.statusCode, 403);

    const adminLogin = await request(port, {
      method: "POST",
      path: "/api/auth/login",
      body: { email: "admin@example.test", password: "Password123!" }
    });
    const adminCookie = cookieFrom(adminLogin);

    const created = await request(port, {
      method: "POST",
      path: "/api/admin/users",
      cookie: adminCookie,
      body: { email: "managed@example.test", name: "管理対象", password: "Password123!", role: "user" }
    });
    assert.equal(created.statusCode, 201);
    const userId = created.body.user.id;

    const updated = await request(port, {
      method: "PATCH",
      path: `/api/admin/users/${userId}`,
      cookie: adminCookie,
      body: { name: "更新済み", role: "admin" }
    });
    assert.equal(updated.statusCode, 200);
    assert.equal(updated.body.user.name, "更新済み");
    assert.equal(updated.body.user.role, "admin");

    const disabled = await request(port, {
      method: "POST",
      path: `/api/admin/users/${userId}/disable`,
      cookie: adminCookie
    });
    assert.equal(disabled.statusCode, 200);
    assert.equal(disabled.body.user.status, "disabled");

    const disabledLogin = await request(port, {
      method: "POST",
      path: "/api/auth/login",
      body: { email: "managed@example.test", password: "Password123!" }
    });
    assert.equal(disabledLogin.statusCode, 403);

    const enabled = await request(port, {
      method: "POST",
      path: `/api/admin/users/${userId}/enable`,
      cookie: adminCookie
    });
    assert.equal(enabled.statusCode, 200);
    assert.equal(enabled.body.user.status, "active");

    const reset = await request(port, {
      method: "POST",
      path: `/api/admin/users/${userId}/reset-password`,
      cookie: adminCookie,
      body: { password: "Changed123!" }
    });
    assert.equal(reset.statusCode, 200);

    const relogin = await request(port, {
      method: "POST",
      path: "/api/auth/login",
      body: { email: "managed@example.test", password: "Changed123!" }
    });
    assert.equal(relogin.statusCode, 200);
  });
});

test("logout clears the active session", async () => {
  await withAuthServer(async (port) => {
    const login = await request(port, {
      method: "POST",
      path: "/api/auth/login",
      body: { email: "user@example.test", password: "Password123!" }
    });
    const cookie = cookieFrom(login);

    const logout = await request(port, {
      method: "POST",
      path: "/api/auth/logout",
      cookie
    });
    assert.equal(logout.statusCode, 200);

    const me = await request(port, {
      path: "/api/auth/me",
      cookie
    });
    assert.equal(me.statusCode, 200);
    assert.equal(me.body.user, null);
  });
});

test("parallel registration keeps email unique", async () => {
  await withAuthServer(async (port) => {
    const email = "parallel@example.test";
    const results = await Promise.all(Array.from({ length: 8 }, (_, index) => request(port, {
      method: "POST",
      path: "/api/auth/register",
      body: { email, name: `並行${index}`, password: "Password123!" }
    })));

    assert.equal(results.filter((result) => result.statusCode === 201).length, 1);
    assert.equal(results.filter((result) => result.statusCode === 409).length, 7);
  });
});

test("state changing requests reject unconfigured browser origins", async () => {
  await withAuthServer(async (port) => {
    const response = await request(port, {
      method: "POST",
      path: "/api/auth/login",
      headers: { Origin: "https://example.invalid" },
      body: { email: "admin@example.test", password: "Password123!" }
    });

    assert.equal(response.statusCode, 403);
    assert.equal(response.body.code, "invalid_origin");
  });
});

test("admin cannot change own role/status or reset own password through admin endpoints", async () => {
  await withAuthServer(async (port) => {
    const login = await request(port, {
      method: "POST",
      path: "/api/auth/login",
      body: { email: "admin@example.test", password: "Password123!" }
    });
    const cookie = cookieFrom(login);
    const adminId = login.body.user.id;

    const demote = await request(port, {
      method: "PATCH",
      path: `/api/admin/users/${adminId}`,
      cookie,
      body: { role: "user" }
    });
    assert.equal(demote.statusCode, 400);
    assert.equal(demote.body.code, "self_admin_change");

    const disable = await request(port, {
      method: "POST",
      path: `/api/admin/users/${adminId}/disable`,
      cookie
    });
    assert.equal(disable.statusCode, 400);
    assert.equal(disable.body.code, "self_admin_change");

    const reset = await request(port, {
      method: "POST",
      path: `/api/admin/users/${adminId}/reset-password`,
      cookie,
      body: { password: "Changed123!" }
    });
    assert.equal(reset.statusCode, 400);
    assert.equal(reset.body.code, "self_password_reset");
  });
});

test("demo account seeding is opt-in for AuthStore", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ucf-auth-no-seed-"));
  try {
    const authStore = createAuthStore({
      filePath: path.join(tempDir, "auth.json")
    });
    await authStore.ensureReady();
    assert.equal(authStore.listUsers().length, 0);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
