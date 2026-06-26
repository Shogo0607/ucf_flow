import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
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

function request(port, { method = "GET", path = "/api/health", headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port,
      method,
      path,
      headers
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString("utf8")
        });
      });
    });

    req.on("error", reject);
    req.end();
  });
}

async function withServer(options, fn) {
  const server = createBackendServer(options);
  const port = await listen(server);
  try {
    await fn(port);
  } finally {
    await close(server);
  }
}

test("backend CORS allows local frontend origins by default without wildcarding", async () => {
  const previousOrigins = process.env.BACKEND_CORS_ORIGINS;
  delete process.env.BACKEND_CORS_ORIGINS;

  try {
    await withServer(undefined, async (port) => {
      const response = await request(port, {
        headers: { Origin: "http://127.0.0.1:8000" }
      });

      assert.equal(response.statusCode, 200);
      assert.equal(response.headers["access-control-allow-origin"], "http://127.0.0.1:8000");
      assert.equal(response.headers.vary, "Origin");
      assert.notEqual(response.headers["access-control-allow-origin"], "*");
    });
  } finally {
    if (previousOrigins === undefined) delete process.env.BACKEND_CORS_ORIGINS;
    else process.env.BACKEND_CORS_ORIGINS = previousOrigins;
  }
});

test("backend CORS rejects unconfigured origins and failed preflights", async () => {
  await withServer({ corsOrigins: ["http://localhost:8000"] }, async (port) => {
    const getResponse = await request(port, {
      headers: { Origin: "https://example.invalid" }
    });

    assert.equal(getResponse.statusCode, 200);
    assert.equal(getResponse.headers["access-control-allow-origin"], undefined);
    assert.equal(getResponse.headers.vary, "Origin");

    const preflightResponse = await request(port, {
      method: "OPTIONS",
      headers: {
        Origin: "https://example.invalid",
        "Access-Control-Request-Method": "GET"
      }
    });

    assert.equal(preflightResponse.statusCode, 403);
    assert.equal(preflightResponse.headers["access-control-allow-origin"], undefined);
  });
});

test("backend CORS supports configured origins and preflights", async () => {
  await withServer({ corsOrigins: ["https://ops.example"] }, async (port) => {
    const preflightResponse = await request(port, {
      method: "OPTIONS",
      headers: {
        Origin: "https://ops.example",
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "Content-Type"
      }
    });

    assert.equal(preflightResponse.statusCode, 204);
    assert.equal(preflightResponse.headers["access-control-allow-origin"], "https://ops.example");
    assert.equal(preflightResponse.headers["access-control-allow-methods"], "GET,POST,PATCH,OPTIONS");
    assert.equal(preflightResponse.headers["access-control-allow-headers"], "Content-Type");
    assert.equal(preflightResponse.headers["access-control-allow-credentials"], "true");

    const getResponse = await request(port, {
      headers: { Origin: "http://localhost:8000" }
    });

    assert.equal(getResponse.statusCode, 200);
    assert.equal(getResponse.headers["access-control-allow-origin"], undefined);
  });
});
