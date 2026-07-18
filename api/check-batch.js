import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { checkUrl, prepareUniqueUrls } from "../lib/checker.js";
import { getConfig } from "../lib/config.js";
import { HostLimiter } from "../lib/host-limiter.js";
import { parseBody, sendJson, setCors } from "../lib/api-utils.js";
import { acquireJobSlot, consumeRateLimit, getClientIp, releaseJobSlot } from "../lib/rate-limit.js";

function getHost(value) {
  try { return new URL(value).hostname; } catch { return "invalid"; }
}

function updateStats(stats, result) {
  stats.checked += 1;
  stats.remaining = Math.max(0, stats.total - stats.checked);
  if (result.category === "redirect") stats.redirects += 1;
  else if (result.ok) stats.success += 1;
  else stats.errors += 1;
  if (result.cached) stats.cached += 1;
}

async function writeLine(res, payload) {
  if (res.writableEnded || res.destroyed) return false;
  const canContinue = res.write(`${JSON.stringify(payload)}\n`);
  if (!canContinue) await once(res, "drain");
  return true;
}

export default async function handler(req, res) {
  setCors(req, res);

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }
  if (req.method !== "POST") {
    sendJson(res, 405, { ok: false, error: "Используйте POST." });
    return;
  }

  const config = getConfig();
  const body = parseBody(req);
  if (!Array.isArray(body.urls) || body.urls.length === 0) {
    sendJson(res, 400, { ok: false, error: "Передайте непустой массив urls." });
    return;
  }
  if (body.urls.length > config.maxUrlsPerRun) {
    sendJson(res, 413, {
      ok: false,
      kind: "limit_exceeded",
      error: `За один запуск разрешено не более ${config.maxUrlsPerRun} URL.`
    });
    return;
  }

  const ip = getClientIp(req);
  const limited = consumeRateLimit(ip, config, body.urls.length);
  res.setHeader("X-RateLimit-Remaining", String(limited.remainingRuns));
  res.setHeader("X-URL-RateLimit-Remaining", String(limited.remainingUrls));
  if (!limited.allowed) {
    sendJson(res, 429, {
      ok: false,
      kind: "rate_limited",
      error: "Превышен минутный лимит запусков или URL.",
      resetAt: new Date(limited.resetAt).toISOString()
    });
    return;
  }
  if (!acquireJobSlot(ip, config)) {
    sendJson(res, 429, {
      ok: false,
      kind: "too_many_active_jobs",
      error: "Уже выполняется максимальное число проверок для этого IP."
    });
    return;
  }

  const runId = randomUUID();
  const entries = prepareUniqueUrls(body.urls, config);
  const concurrency = Math.min(
    config.maxConcurrency,
    Math.max(1, Number(body.concurrency) || config.defaultConcurrency),
    entries.length
  );
  const mode = body.mode === "full" ? "full" : "quick";
  const controller = new AbortController();
  const hostLimiter = new HostLimiter(config.perHostConcurrency);
  const startedAt = performance.now();
  let cursor = 0;
  let clientDisconnected = false;

  const stats = {
    total: entries.length,
    inputTotal: body.urls.length,
    duplicatesRemoved: body.urls.length - entries.length,
    checked: 0,
    success: 0,
    redirects: 0,
    errors: 0,
    cached: 0,
    remaining: entries.length
  };

  res.statusCode = 200;
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-store, no-transform");
  res.setHeader("X-Accel-Buffering", "no");
  res.setHeader("X-Run-Id", runId);
  res.flushHeaders?.();

  res.on("close", () => {
    if (!res.writableEnded) {
      clientDisconnected = true;
      controller.abort(new DOMException("Client disconnected", "AbortError"));
    }
  });

  try {
    await writeLine(res, {
      type: "start",
      runId,
      mode,
      concurrency,
      perHostConcurrency: config.perHostConcurrency,
      stats
    });

    const worker = async () => {
      while (!controller.signal.aborted) {
        const index = cursor;
        cursor += 1;
        if (index >= entries.length) return;
        const entry = entries[index];
        let release = () => {};
        try {
          release = await hostLimiter.acquire(getHost(entry.normalizedUrl), controller.signal);
          const result = await checkUrl(entry.originalUrl, {
            mode,
            force: body.force === true,
            signal: controller.signal,
            config
          });
          updateStats(stats, result);
          const elapsedSeconds = Math.max(0.001, (performance.now() - startedAt) / 1000);
          const speed = stats.checked / elapsedSeconds;
          const etaSeconds = speed > 0 ? stats.remaining / speed : null;
          await writeLine(res, {
            type: "result",
            runId,
            index,
            entry,
            result,
            stats: { ...stats, speed, etaSeconds }
          });
        } catch (error) {
          if (controller.signal.aborted) return;
          const result = {
            ok: false,
            category: "network_error",
            label: "Ошибка сети",
            originalUrl: entry.originalUrl,
            normalizedUrl: entry.normalizedUrl,
            diagnostic: error?.message || "Не удалось выполнить проверку.",
            checkedAt: new Date().toISOString(),
            latency: 0
          };
          updateStats(stats, result);
          await writeLine(res, { type: "result", runId, index, entry, result, stats });
        } finally {
          release();
        }
      }
    };

    await Promise.all(Array.from({ length: concurrency }, worker));
    if (!clientDisconnected) {
      await writeLine(res, {
        type: controller.signal.aborted ? "cancelled" : "done",
        runId,
        stats,
        durationMs: Math.round(performance.now() - startedAt)
      });
      res.end();
    }
  } catch (error) {
    if (!clientDisconnected && !res.writableEnded) {
      await writeLine(res, { type: "error", runId, error: error?.message || "Ошибка пакетной проверки." });
      res.end();
    }
  } finally {
    releaseJobSlot(ip);
  }
}
