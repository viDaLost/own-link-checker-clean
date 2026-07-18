import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { EventEmitter } from "node:events";
import handler from "../api/check-batch.js";
import { clearRateLimits } from "../lib/rate-limit.js";
import { clearResultCache } from "../lib/checker.js";
import { clearDnsCache } from "../lib/security.js";

process.env.NODE_ENV = "test";
process.env.ALLOW_PRIVATE_NETWORKS_FOR_TESTS = "true";
process.env.ALLOWED_HOSTS = "*";
process.env.RATE_LIMIT_PER_MINUTE = "1000";
process.env.URL_RATE_LIMIT_PER_MINUTE = "100000";
process.env.CACHE_TTL_MS = "0";
process.env.CHECK_RETRIES = "0";

let server;
let port;

test.before(async () => {
  server = http.createServer((req, res) => {
    const path = new URL(req.url, "http://localhost").pathname;
    if (path === "/redirect") {
      res.writeHead(302, { location: "/ok" });
      res.end();
    } else {
      res.writeHead(path === "/missing" ? 404 : 200, { "content-type": "text/plain" });
      res.end();
    }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  port = server.address().port;
  process.env.ALLOWED_PORTS = `80,443,${port}`;
});

test.beforeEach(() => {
  clearRateLimits();
  clearResultCache();
  clearDnsCache();
});

test.after(() => new Promise(resolve => server.close(resolve)));

test("streams start, deduplicated results and completion", async () => {
  const req = new EventEmitter();
  req.method = "POST";
  req.headers = {};
  req.socket = { remoteAddress: "test-client" };
  req.body = {
    urls: [
      `http://127.0.0.1:${port}/ok`,
      `http://127.0.0.1:${port}/ok`,
      `http://127.0.0.1:${port}/missing`,
      `http://127.0.0.1:${port}/redirect`
    ],
    concurrency: 3,
    mode: "quick"
  };

  const res = new EventEmitter();
  res.headers = {};
  res.chunks = [];
  res.writableEnded = false;
  res.destroyed = false;
  res.setHeader = (name, value) => { res.headers[name.toLowerCase()] = value; };
  res.flushHeaders = () => {};
  res.write = chunk => { res.chunks.push(String(chunk)); return true; };
  res.end = chunk => {
    if (chunk) res.chunks.push(String(chunk));
    res.writableEnded = true;
  };

  await handler(req, res);
  const events = res.chunks.join("").trim().split("\n").map(line => JSON.parse(line));
  assert.equal(events[0].type, "start");
  assert.equal(events[0].stats.inputTotal, 4);
  assert.equal(events[0].stats.total, 3);
  assert.equal(events.filter(event => event.type === "result").length, 3);
  assert.equal(events.at(-1).type, "done");
  assert.equal(events.at(-1).stats.checked, 3);
});
