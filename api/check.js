import { checkUrl } from "../lib/checker.js";
import { getConfig } from "../lib/config.js";
import { parseBody, sendJson, setCors } from "../lib/api-utils.js";
import { consumeRateLimit, getClientIp } from "../lib/rate-limit.js";

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
  const limited = consumeRateLimit(getClientIp(req), config, 1);
  res.setHeader("X-RateLimit-Remaining", String(limited.remainingRuns));
  if (!limited.allowed) {
    sendJson(res, 429, {
      ok: false,
      kind: "rate_limited",
      error: "Превышен лимит проверок. Повторите попытку после сброса лимита.",
      resetAt: new Date(limited.resetAt).toISOString()
    });
    return;
  }

  const body = parseBody(req);
  const result = await checkUrl(body.url, {
    mode: body.mode,
    force: body.force === true
  });
  sendJson(res, 200, result);
}
