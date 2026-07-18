import http from "node:http";
import { performance } from "node:perf_hooks";

const count = Number(process.argv[2] || 100);
const upstreamPort = 4301;
const apiPort = 4300;

process.env.NODE_ENV = "test";
process.env.ALLOW_PRIVATE_NETWORKS_FOR_TESTS = "true";
process.env.ALLOWED_HOSTS = "*";
process.env.ALLOWED_PORTS = `80,443,${upstreamPort}`;
process.env.RATE_LIMIT_PER_MINUTE = "100000";
process.env.URL_RATE_LIMIT_PER_MINUTE = "100000";
process.env.MAX_URLS_PER_RUN = "1000";
process.env.CHECK_CONCURRENCY = "12";
process.env.MAX_CHECK_CONCURRENCY = "24";
process.env.PER_HOST_CONCURRENCY = "4";
process.env.CACHE_TTL_MS = "0";
process.env.CHECK_TIMEOUT_MS = "3000";
process.env.CHECK_RETRIES = "1";
process.env.RETRY_BASE_MS = "5";

const { default: batchHandler } = await import("../api/check-batch.js");
const { clearRateLimits } = await import("../lib/rate-limit.js");
const { clearResultCache } = await import("../lib/checker.js");
const { clearDnsCache } = await import("../lib/security.js");

clearRateLimits();
clearResultCache();
clearDnsCache();

const upstream = http.createServer((req, res) => {
  const id = Number(new URL(req.url, "http://127.0.0.1").pathname.slice(1)) || 0;
  const delay = 20 + (id % 7) * 8;
  setTimeout(() => {
    if (id % 20 === 0) {
      res.writeHead(404, { "content-type": "text/html", "content-length": "9" });
      res.end(req.method === "HEAD" ? undefined : "not found");
      return;
    }
    if (id % 25 === 0 && req.method === "HEAD") {
      res.writeHead(405, { allow: "GET" });
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "text/html", "content-length": "2" });
    res.end(req.method === "HEAD" ? undefined : "ok");
  }, delay);
});
await new Promise(resolve => upstream.listen(upstreamPort, "127.0.0.1", resolve));

const api = http.createServer((req, res) => {
  let raw = "";
  req.on("data", chunk => { raw += chunk; });
  req.on("end", async () => {
    try { req.body = raw ? JSON.parse(raw) : {}; } catch { req.body = {}; }
    await batchHandler(req, res);
  });
});
await new Promise(resolve => api.listen(apiPort, "127.0.0.1", resolve));

const urls = Array.from({ length: count }, (_, index) => `http://127.0.0.1:${upstreamPort}/${index + 1}`);
const latencies = [];
let errors = 0;
let peakRss = process.memoryUsage().rss;
const memorySampler = setInterval(() => {
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
}, 10);
memorySampler.unref?.();
const rssStart = process.memoryUsage().rss;
const cpuStart = process.cpuUsage();
const startedAt = performance.now();

const response = await fetch(`http://127.0.0.1:${apiPort}/api/check-batch`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ urls, mode: "quick", concurrency: 12, force: true })
});
if (!response.ok) throw new Error(`API HTTP ${response.status}: ${await response.text()}`);

const reader = response.body.getReader();
const decoder = new TextDecoder();
let buffer = "";
let doneEvent = null;
while (true) {
  const { value, done } = await reader.read();
  buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
  const lines = buffer.split("\n");
  buffer = lines.pop() || "";
  for (const line of lines) {
    if (!line) continue;
    const event = JSON.parse(line);
    if (event.type === "result") {
      latencies.push(Number(event.result.latency) || 0);
      if (!event.result.ok) errors += 1;
    }
    if (event.type === "done") doneEvent = event;
  }
  if (done) break;
}
clearInterval(memorySampler);
const durationMs = performance.now() - startedAt;
const cpu = process.cpuUsage(cpuStart);
const rssEnd = process.memoryUsage().rss;
latencies.sort((a, b) => a - b);
const percentile = value => latencies[Math.min(latencies.length - 1, Math.floor((latencies.length - 1) * value))] || 0;

console.log(JSON.stringify({
  count,
  durationMs: Math.round(durationMs),
  urlsPerSecond: +(count / (durationMs / 1000)).toFixed(2),
  medianMs: +percentile(0.5).toFixed(1),
  p95Ms: +percentile(0.95).toFixed(1),
  rssStartMb: +(rssStart / 1024 / 1024).toFixed(2),
  rssEndMb: +(rssEnd / 1024 / 1024).toFixed(2),
  peakRssMb: +(peakRss / 1024 / 1024).toFixed(2),
  rssDeltaMb: +((rssEnd - rssStart) / 1024 / 1024).toFixed(2),
  cpuMs: +((cpu.user + cpu.system) / 1000).toFixed(1),
  errors,
  endpointDurationMs: doneEvent?.durationMs ?? null
}, null, 2));

await Promise.all([
  new Promise(resolve => api.close(resolve)),
  new Promise(resolve => upstream.close(resolve))
]);
