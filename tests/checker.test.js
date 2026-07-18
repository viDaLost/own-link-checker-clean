import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import { readFile } from "node:fs/promises";
import { checkUrl, clearResultCache, prepareUniqueUrls } from "../lib/checker.js";
import { clearDnsCache } from "../lib/security.js";

process.env.NODE_ENV = "test";
process.env.ALLOW_PRIVATE_NETWORKS_FOR_TESTS = "true";

let server;
let tlsServer;
let baseUrl;
let port;
let tlsPort;
const counters = new Map();

function count(path) {
  const next = (counters.get(path) || 0) + 1;
  counters.set(path, next);
  return next;
}

function makeConfig(overrides = {}) {
  return {
    allowedHosts: ["*"],
    allowedPorts: ["80", "443", String(port), String(tlsPort)],
    maxUrlLength: 4096,
    maxUrlsPerRun: 1000,
    defaultConcurrency: 12,
    maxConcurrency: 24,
    perHostConcurrency: 4,
    connectTimeoutMs: 500,
    headersTimeoutMs: 500,
    readTimeoutMs: 500,
    totalTimeoutMs: 1000,
    tlsTimeoutMs: 500,
    dnsTimeoutMs: 500,
    dnsCacheTtlMs: 1000,
    retries: 2,
    retryBaseMs: 5,
    maxRedirects: 3,
    maxResponseBytes: 64,
    slowThresholdMs: 100,
    cacheTtlMs: 0,
    cacheMaxEntries: 100,
    connectionsPerOrigin: 4,
    ...overrides
  };
}

test.before(async () => {
  server = http.createServer((req, res) => {
    const path = new URL(req.url, "http://localhost").pathname;
    const requestNumber = count(`${req.method} ${path}`);

    if (path === "/ok") {
      res.writeHead(200, { "content-type": "text/html", "content-length": "2" });
      if (req.method === "HEAD") res.end(); else res.end("ok");
      return;
    }
    if (path === "/not-found") {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end(req.method === "HEAD" ? undefined : "missing");
      return;
    }
    if (path === "/fallback") {
      if (req.method === "HEAD") {
        res.writeHead(405, { allow: "GET" });
        res.end();
      } else {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("fallback-ok");
      }
      return;
    }
    if (path === "/redirect") {
      res.writeHead(302, { location: "/ok" });
      res.end();
      return;
    }
    if (path === "/loop") {
      res.writeHead(302, { location: "/loop" });
      res.end();
      return;
    }
    if (path === "/redirect-private") {
      process.env.ALLOW_PRIVATE_NETWORKS_FOR_TESTS = "false";
      res.writeHead(302, { location: "/ok" });
      res.end();
      return;
    }
    if (path === "/retry") {
      if (requestNumber <= 2) {
        res.writeHead(503, { "retry-after": "0" });
        res.end();
      } else {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end(req.method === "HEAD" ? undefined : "ok");
      }
      return;
    }
    if (path === "/large") {
      if (req.method === "HEAD") {
        res.writeHead(405);
        res.end();
      } else {
        const body = "x".repeat(4096);
        res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(body.length) });
        res.end(body);
      }
      return;
    }
    if (path === "/slow") {
      setTimeout(() => {
        res.writeHead(200);
        res.end();
      }, 250);
      return;
    }
    res.writeHead(500);
    res.end();
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;

  tlsServer = https.createServer({
    key: await readFile(new URL("./fixtures/selfsigned-key.pem", import.meta.url)),
    cert: await readFile(new URL("./fixtures/selfsigned-cert.pem", import.meta.url))
  }, (_req, res) => {
    res.writeHead(200);
    res.end();
  });
  await new Promise(resolve => tlsServer.listen(0, "127.0.0.1", resolve));
  tlsPort = tlsServer.address().port;
});

test.beforeEach(() => {
  process.env.ALLOW_PRIVATE_NETWORKS_FOR_TESTS = "true";
  counters.clear();
  clearResultCache();
  clearDnsCache();
});

test.after(async () => {
  await Promise.all([
    new Promise(resolve => server.close(resolve)),
    new Promise(resolve => tlsServer.close(resolve))
  ]);
});

test("checks a successful URL with HEAD", async () => {
  const result = await checkUrl(`${baseUrl}/ok`, { config: makeConfig() });
  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.equal(result.method, "HEAD");
  assert.equal(result.category, "working");
});

test("falls back from HEAD to a limited GET", async () => {
  const result = await checkUrl(`${baseUrl}/fallback`, { config: makeConfig() });
  assert.equal(result.ok, true);
  assert.equal(result.method, "GET");
  assert.equal(counters.get("HEAD /fallback"), 1);
  assert.equal(counters.get("GET /fallback"), 1);
});

test("tracks redirect chains and final URL", async () => {
  const result = await checkUrl(`${baseUrl}/redirect`, { config: makeConfig() });
  assert.equal(result.ok, true);
  assert.equal(result.category, "redirect");
  assert.equal(result.redirectCount, 1);
  assert.equal(result.finalUrl, `${baseUrl}/ok`);
});

test("reports redirect loops", async () => {
  const result = await checkUrl(`${baseUrl}/loop`, { config: makeConfig() });
  assert.equal(result.ok, false);
  assert.equal(result.category, "redirect_error");
  assert.match(result.diagnostic, /циклический/i);
});

test("blocks a redirect that changes to a private target", async () => {
  try {
    const result = await checkUrl(`${baseUrl}/redirect-private`, { config: makeConfig() });
    assert.equal(result.ok, false);
    assert.equal(result.category, "blocked");
  } finally {
    process.env.ALLOW_PRIVATE_NETWORKS_FOR_TESTS = "true";
  }
});

test("retries temporary 503 responses", async () => {
  const result = await checkUrl(`${baseUrl}/retry`, { config: makeConfig() });
  assert.equal(result.ok, true);
  assert.equal(result.retries, 2);
  assert.equal(counters.get("HEAD /retry"), 3);
});

test("limits response body size in full mode", async () => {
  const result = await checkUrl(`${baseUrl}/large`, { config: makeConfig({ maxResponseBytes: 64 }), mode: "full" });
  assert.equal(result.ok, true);
  assert.equal(result.method, "GET");
  assert.equal(result.contentLength, 4096);
  assert.equal(result.responseTruncated, true);
});

test("classifies 404 and timeout failures", async () => {
  const missing = await checkUrl(`${baseUrl}/not-found`, { config: makeConfig() });
  assert.equal(missing.category, "not_found");
  const timeout = await checkUrl(`${baseUrl}/slow`, { config: makeConfig({ totalTimeoutMs: 50, retries: 0 }) });
  assert.equal(timeout.category, "timeout");
});

test("supports explicit cancellation", async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(new DOMException("Cancelled", "AbortError")), 20);
  const result = await checkUrl(`${baseUrl}/slow`, { config: makeConfig(), signal: controller.signal });
  assert.equal(result.category, "cancelled");
});

test("classifies invalid TLS certificates", async () => {
  const result = await checkUrl(`https://127.0.0.1:${tlsPort}/`, { config: makeConfig(), mode: "full" });
  assert.equal(result.ok, false);
  assert.equal(result.category, "tls_error");
});

test("returns a fresh cached result unless force is set", async () => {
  const config = makeConfig({ cacheTtlMs: 10000 });
  const first = await checkUrl(`${baseUrl}/ok`, { config });
  const second = await checkUrl(`${baseUrl}/ok`, { config });
  const forced = await checkUrl(`${baseUrl}/ok`, { config, force: true });
  assert.equal(first.cached, false);
  assert.equal(second.cached, true);
  assert.equal(forced.cached, false);
  assert.equal(counters.get("HEAD /ok"), 2);
});

test("deduplicates normalized URLs and preserves occurrence count", () => {
  const entries = prepareUniqueUrls(["https://EXAMPLE.com", "https://example.com/", "bad", "bad"], makeConfig());
  assert.equal(entries.length, 2);
  assert.equal(entries[0].occurrences, 2);
  assert.equal(entries[1].occurrences, 2);
});
