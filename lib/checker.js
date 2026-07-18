import tls from "node:tls";
import { STATUS_CODES } from "node:http";
import { Agent, request } from "undici";
import { getConfig } from "./config.js";
import { SecurityError, createSafeLookup, normalizeUrl, validateUrlTarget } from "./security.js";

const resultCache = new Map();
let agentState = null;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const HEAD_FALLBACK_STATUSES = new Set([400, 403, 405, 406, 501]);
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const RETRYABLE_CODES = new Set([
  "EAI_AGAIN", "ECONNRESET", "ECONNREFUSED", "EPIPE", "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET"
]);

function getAgent(config) {
  const key = `${config.connectionsPerOrigin}:${config.connectTimeoutMs}:${config.dnsCacheTtlMs}`;
  if (agentState?.key === key) return agentState.agent;
  agentState?.agent?.close().catch(() => {});
  const agent = new Agent({
    connections: config.connectionsPerOrigin,
    pipelining: 1,
    keepAliveTimeout: 10_000,
    keepAliveMaxTimeout: 60_000,
    connect: {
      timeout: config.connectTimeoutMs,
      lookup: createSafeLookup(config)
    }
  });
  agentState = { key, agent };
  return agent;
}

function headerValue(headers, name) {
  const value = headers?.[name] ?? headers?.[name.toLowerCase()];
  return Array.isArray(value) ? value.join(", ") : String(value ?? "");
}

function destroyBody(body) {
  if (!body) return;
  body.on?.("error", () => {});
  body.destroy();
}

function parseRetryAfter(value) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason || new DOMException("Aborted", "AbortError"));
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(signal.reason || new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function isRetryableError(error) {
  const code = error?.code || error?.cause?.code;
  return RETRYABLE_CODES.has(code);
}

async function requestWithRetry(url, method, config, signal, deadline) {
  let lastError;
  for (let attempt = 0; attempt <= config.retries; attempt += 1) {
    try {
      const response = await request(url, {
        method,
        dispatcher: getAgent(config),
        maxRedirections: 0,
        signal,
        headersTimeout: Math.min(config.headersTimeoutMs, Math.max(250, deadline - Date.now())),
        bodyTimeout: config.readTimeoutMs,
        headers: {
          "user-agent": "OwnLinkChecker/2.0 (+safe-link-health-check)",
          accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.5",
          "accept-encoding": "identity",
          ...(method === "GET" ? { range: `bytes=0-${config.maxResponseBytes - 1}` } : {})
        }
      });

      if (!RETRYABLE_STATUSES.has(response.statusCode) || attempt >= config.retries) {
        return { statusCode: response.statusCode, headers: response.headers, body: response.body, trailers: response.trailers, retryCount: attempt };
      }

      const retryAfter = parseRetryAfter(headerValue(response.headers, "retry-after"));
      const exponential = config.retryBaseMs * (2 ** attempt);
      const jitter = Math.floor(Math.random() * Math.max(25, exponential * 0.3));
      const remainingMs = Math.max(0, deadline - Date.now() - 50);
      if (remainingMs <= 0) return { statusCode: response.statusCode, headers: response.headers, body: response.body, trailers: response.trailers, retryCount: attempt };
      const waitMs = Math.min(retryAfter ?? (exponential + jitter), remainingMs);
      destroyBody(response.body);
      if (waitMs > 0) await sleep(waitMs, signal);
    } catch (error) {
      lastError = error;
      if (attempt >= config.retries || !isRetryableError(error)) throw error;
      const waitMs = Math.min(
        config.retryBaseMs * (2 ** attempt) + Math.floor(Math.random() * 75),
        Math.max(0, deadline - Date.now() - 50)
      );
      if (waitMs <= 0) throw error;
      await sleep(waitMs, signal);
    }
  }
  throw lastError;
}

async function consumeBody(body, limit, capture = false) {
  if (!body) return { bytesRead: 0, truncated: false, sample: "" };
  let bytesRead = 0;
  let truncated = false;
  const chunks = [];
  try {
    for await (const chunk of body) {
      const buffer = Buffer.from(chunk);
      const remaining = Math.max(0, limit - bytesRead);
      if (capture && remaining > 0) chunks.push(buffer.subarray(0, remaining));
      bytesRead += buffer.length;
      if (bytesRead >= limit) {
        truncated = true;
        destroyBody(body);
        break;
      }
    }
  } catch (error) {
    if (!truncated) throw error;
  }
  return {
    bytesRead: Math.min(bytesRead, limit),
    truncated,
    sample: capture ? Buffer.concat(chunks).toString("utf8") : ""
  };
}

async function followRedirects(startUrl, method, config, signal, deadline) {
  let current = startUrl;
  const seen = new Set();
  const redirectChain = [];
  let retries = 0;

  for (let hop = 0; hop <= config.maxRedirects; hop += 1) {
    await validateUrlTarget(current, config);
    const key = current.toString();
    if (seen.has(key)) throw new SecurityError("Обнаружен циклический редирект.", "redirect_loop");
    seen.add(key);

    const response = await requestWithRetry(current, method, config, signal, deadline);
    retries += response.retryCount || 0;
    const location = headerValue(response.headers, "location");

    if (REDIRECT_STATUSES.has(response.statusCode) && location) {
      destroyBody(response.body);
      if (hop >= config.maxRedirects) {
        throw new SecurityError("Превышен лимит редиректов.", "too_many_redirects");
      }
      let next;
      try {
        next = new URL(location, current);
      } catch {
        throw new SecurityError("Сервер вернул некорректный адрес редиректа.", "invalid_redirect");
      }
      await validateUrlTarget(next, config);
      redirectChain.push({ status: response.statusCode, url: current.toString(), location: next.toString() });
      current = next;
      continue;
    }

    return { response, finalUrl: current, redirectChain, retries };
  }

  throw new SecurityError("Превышен лимит редиректов.", "too_many_redirects");
}

function tlsCertificateInfo(url, config, signal) {
  if (url.protocol !== "https:") return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      host: url.hostname,
      port: Number(url.port || 443),
      servername: url.hostname,
      rejectUnauthorized: true,
      lookup: createSafeLookup(config),
      timeout: config.tlsTimeoutMs
    });

    const cleanup = () => signal?.removeEventListener("abort", abort);
    const abort = () => {
      socket.destroy(signal.reason || new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });

    socket.once("secureConnect", () => {
      const cert = socket.getPeerCertificate();
      cleanup();
      socket.end();
      resolve({
        valid: socket.authorized !== false,
        validTo: cert?.valid_to ? new Date(cert.valid_to).toISOString() : null,
        issuer: cert?.issuer?.O || cert?.issuer?.CN || null
      });
    });
    socket.once("timeout", () => socket.destroy(Object.assign(new Error("TLS timeout"), { code: "ETIMEDOUT" })));
    socket.once("error", error => {
      cleanup();
      reject(error);
    });
  });
}

function classifyStatus(status, redirectCount, latency, config) {
  if (status >= 200 && status < 300) {
    if (latency >= config.slowThresholdMs) return { category: "slow", label: "Медленно", ok: true };
    if (redirectCount > 0) return { category: "redirect", label: "Перенаправление", ok: true };
    return { category: "working", label: "Работает", ok: true };
  }
  if (status >= 300 && status < 400) return { category: "redirect", label: "Редирект", ok: true };
  if (status === 404 || status === 410) return { category: "not_found", label: status === 410 ? "Удалена" : "Не найдена", ok: false };
  if (status >= 400 && status < 500) return { category: "client_error", label: "Ошибка клиента", ok: false };
  if (status >= 500) return { category: "server_error", label: "Ошибка сервера", ok: false };
  return { category: "network_error", label: "Ошибка сети", ok: false };
}

function classifyError(error, elapsed) {
  const code = error?.code || error?.cause?.code || "";
  const message = error?.message || "Неизвестная ошибка.";

  if (error instanceof SecurityError) {
    const mapping = {
      invalid_url: ["invalid_url", "Некорректный URL"],
      blocked: ["blocked", "Заблокировано"],
      dns_error: ["dns_error", "Ошибка DNS"],
      redirect_loop: ["redirect_error", "Циклический редирект"],
      too_many_redirects: ["redirect_error", "Слишком много редиректов"],
      invalid_redirect: ["redirect_error", "Некорректный редирект"]
    };
    const [category, label] = mapping[error.kind] || ["blocked", "Заблокировано"];
    return { kind: error.kind, category, label, diagnostic: message };
  }
  if (error?.name === "AbortError") {
    return { kind: "cancelled", category: "cancelled", label: "Отменено", diagnostic: "Проверка была отменена." };
  }
  if (error?.name === "TimeoutError" || code === "UND_ERR_HEADERS_TIMEOUT" || code === "UND_ERR_BODY_TIMEOUT" || code === "ETIMEDOUT") {
    return { kind: "timeout", category: "timeout", label: "Тайм-аут", diagnostic: "Сервер не ответил в установленный срок." };
  }
  if (["ENOTFOUND", "EAI_AGAIN", "EAI_FAIL"].includes(code)) {
    return { kind: "dns_error", category: "dns_error", label: "Ошибка DNS", diagnostic: "Не удалось определить IP-адрес домена." };
  }
  if (String(code).includes("CERT") || String(code).includes("TLS") || String(code).includes("SSL") || /certificate|tls|ssl/i.test(message)) {
    return { kind: "tls_error", category: "tls_error", label: "Ошибка TLS", diagnostic: "Не удалось установить безопасное TLS-соединение." };
  }
  return { kind: "network_error", category: "network_error", label: "Ошибка сети", diagnostic: message, latency: elapsed };
}

function cacheGet(key, config) {
  if (config.cacheTtlMs <= 0) return null;
  const entry = resultCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    resultCache.delete(key);
    return null;
  }
  return { ...entry.result, cached: true, cacheAgeMs: Date.now() - entry.savedAt };
}

function cacheSet(key, result, config) {
  if (config.cacheTtlMs <= 0) return;
  if (resultCache.size >= config.cacheMaxEntries) {
    const oldest = resultCache.keys().next().value;
    resultCache.delete(oldest);
  }
  resultCache.set(key, { result, savedAt: Date.now(), expiresAt: Date.now() + config.cacheTtlMs });
}

export async function checkUrl(input, options = {}) {
  const config = options.config || getConfig();
  const mode = options.mode === "full" ? "full" : "quick";
  const startedAt = performance.now();
  let normalized;

  try {
    normalized = normalizeUrl(input, config).toString();
  } catch (error) {
    const info = classifyError(error, 0);
    return {
      ok: false,
      originalUrl: String(input ?? ""),
      normalizedUrl: String(input ?? "").trim(),
      finalUrl: null,
      status: null,
      statusText: "",
      latency: 0,
      checkedAt: new Date().toISOString(),
      redirectCount: 0,
      redirectChain: [],
      contentType: "",
      contentLength: null,
      method: null,
      retries: 0,
      cached: false,
      ...info
    };
  }

  const cacheKey = `${mode}:${normalized}`;
  if (!options.force) {
    const cached = cacheGet(cacheKey, config);
    if (cached) return { ...cached, originalUrl: String(input), normalizedUrl: normalized };
  }

  const controller = new AbortController();
  const externalAbort = () => controller.abort(options.signal?.reason || new DOMException("Aborted", "AbortError"));
  options.signal?.addEventListener("abort", externalAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new DOMException("Timeout", "TimeoutError")), config.totalTimeoutMs);
  timer.unref?.();
  const deadline = Date.now() + config.totalTimeoutMs;

  try {
    const startUrl = await validateUrlTarget(normalized, config);
    let method = "HEAD";
    let chainResult = await followRedirects(startUrl, method, config, controller.signal, deadline);

    if (HEAD_FALLBACK_STATUSES.has(chainResult.response.statusCode)) {
      destroyBody(chainResult.response.body);
      method = "GET";
      chainResult = await followRedirects(startUrl, method, config, controller.signal, deadline);
    }

    const { response, finalUrl, redirectChain, retries } = chainResult;
    const contentType = headerValue(response.headers, "content-type");
    const rawLengthHeader = headerValue(response.headers, "content-length");
    const lengthHeader = rawLengthHeader === "" ? Number.NaN : Number(rawLengthHeader);
    let bodyInfo = { bytesRead: 0, truncated: false, sample: "" };
    if (method === "GET") {
      bodyInfo = await consumeBody(response.body, mode === "full" ? config.maxResponseBytes : 1, mode === "full");
    } else {
      destroyBody(response.body);
    }

    const latency = Math.round(performance.now() - startedAt);
    const statusInfo = classifyStatus(response.statusCode, redirectChain.length, latency, config);
    let tlsInfo = null;
    if (mode === "full" && finalUrl.protocol === "https:") {
      tlsInfo = await tlsCertificateInfo(finalUrl, config, controller.signal);
    }

    const result = {
      ok: statusInfo.ok,
      kind: "http",
      category: statusInfo.category,
      label: statusInfo.label,
      originalUrl: String(input),
      normalizedUrl: normalized,
      finalUrl: finalUrl.toString(),
      status: response.statusCode,
      statusText: STATUS_CODES[response.statusCode] || "",
      latency,
      checkedAt: new Date().toISOString(),
      redirectCount: redirectChain.length,
      redirectChain,
      contentType,
      contentLength: Number.isFinite(lengthHeader) && lengthHeader >= 0 ? lengthHeader : (method === "GET" ? bodyInfo.bytesRead : null),
      responseTruncated: bodyInfo.truncated,
      method,
      retries,
      tls: tlsInfo,
      cached: false,
      cacheAgeMs: 0,
      diagnostic: statusInfo.ok
        ? (redirectChain.length ? `Ссылка доступна после ${redirectChain.length} редирект(а/ов).` : "Ссылка доступна.")
        : `Сервер вернул HTTP ${response.statusCode} ${STATUS_CODES[response.statusCode] || ""}.`.trim()
    };

    cacheSet(cacheKey, result, config);
    return result;
  } catch (error) {
    if (process.env.DEBUG_CHECKER === "true") console.error(error?.stack || error);
    const latency = Math.round(performance.now() - startedAt);
    const info = classifyError(error, latency);
    return {
      ok: false,
      originalUrl: String(input),
      normalizedUrl: normalized,
      finalUrl: null,
      status: null,
      statusText: "",
      latency,
      checkedAt: new Date().toISOString(),
      redirectCount: 0,
      redirectChain: [],
      contentType: "",
      contentLength: null,
      responseTruncated: false,
      method: null,
      retries: 0,
      tls: null,
      cached: false,
      cacheAgeMs: 0,
      ...info
    };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", externalAbort);
  }
}

export function prepareUniqueUrls(inputs, config = getConfig()) {
  const list = Array.isArray(inputs) ? inputs : [];
  const map = new Map();
  list.slice(0, config.maxUrlsPerRun).forEach((input, sourceIndex) => {
    const original = String(input ?? "").trim();
    let key = original;
    try {
      key = normalizeUrl(original, config).toString();
    } catch {}
    const existing = map.get(key);
    if (existing) {
      existing.occurrences += 1;
      existing.sourceIndexes.push(sourceIndex);
    } else {
      map.set(key, {
        id: map.size + 1,
        originalUrl: original,
        normalizedUrl: key,
        occurrences: 1,
        sourceIndexes: [sourceIndex]
      });
    }
  });
  return [...map.values()];
}

export function clearResultCache() {
  resultCache.clear();
}
