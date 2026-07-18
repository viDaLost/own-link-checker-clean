import dns from "node:dns/promises";
import net from "node:net";
import ipaddr from "ipaddr.js";

export class SecurityError extends Error {
  constructor(message, kind = "blocked") {
    super(message);
    this.name = "SecurityError";
    this.kind = kind;
  }
}

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata.google.internal",
  "metadata.google.internal.",
  "instance-data",
  "instance-data.ec2.internal"
]);

const dnsCache = new Map();

function normalizedHostname(hostname) {
  return String(hostname || "").trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

function isTestPrivateNetworkAllowed() {
  return process.env.NODE_ENV === "test" && process.env.ALLOW_PRIVATE_NETWORKS_FOR_TESTS === "true";
}

export function isPublicIp(address) {
  if (isTestPrivateNetworkAllowed()) return true;

  let parsed;
  try {
    parsed = ipaddr.parse(address);
  } catch {
    return false;
  }

  if (parsed.kind() === "ipv6" && parsed.isIPv4MappedAddress()) {
    parsed = parsed.toIPv4Address();
  }

  return parsed.range() === "unicast";
}

export function normalizeUrl(input, config) {
  const raw = String(input ?? "").trim();
  if (!raw) throw new SecurityError("URL не указан.", "invalid_url");
  if (raw.length > config.maxUrlLength) {
    throw new SecurityError(`URL длиннее допустимых ${config.maxUrlLength} символов.`, "invalid_url");
  }

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new SecurityError("Некорректный URL.", "invalid_url");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SecurityError("Разрешены только протоколы HTTP и HTTPS.", "invalid_url");
  }
  if (url.username || url.password) {
    throw new SecurityError("URL с логином или паролем не поддерживается.", "blocked");
  }

  const host = normalizedHostname(url.hostname);
  if (!host) throw new SecurityError("В URL отсутствует домен.", "invalid_url");
  if (
    BLOCKED_HOSTNAMES.has(host) ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".lan") ||
    host.endsWith(".home")
  ) {
    throw new SecurityError("Локальные и служебные адреса запрещены.", "blocked");
  }

  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  if (!config.allowedPorts.includes("*") && !config.allowedPorts.includes(port)) {
    throw new SecurityError(`Порт ${port} не разрешён конфигурацией сервера.`, "blocked");
  }

  const allowed = config.allowedHosts.includes("*") || config.allowedHosts.some(entry => {
    const allowedHost = normalizedHostname(entry);
    return host === allowedHost || host.endsWith(`.${allowedHost}`);
  });
  if (!allowed) {
    throw new SecurityError(`Домен ${host} не входит в ALLOWED_HOSTS.`, "blocked");
  }

  url.hostname = host;
  return url;
}

export async function resolvePublicAddresses(hostname, config, resolver = dns.lookup) {
  const host = normalizedHostname(hostname);
  if (net.isIP(host)) {
    if (!isPublicIp(host)) throw new SecurityError("Запросы к приватным или служебным IP-адресам запрещены.");
    return [{ address: host, family: net.isIP(host) }];
  }

  const cached = dnsCache.get(host);
  if (cached && cached.expiresAt > Date.now()) return cached.records;

  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new SecurityError("DNS-разрешение превысило лимит времени.", "dns_error")), config.dnsTimeoutMs);
    timeoutId.unref?.();
  });

  let records;
  try {
    records = await Promise.race([
      resolver(host, { all: true, verbatim: true }),
      timeout
    ]);
  } catch (error) {
    if (error instanceof SecurityError) throw error;
    const wrapped = new SecurityError("Не удалось разрешить доменное имя.", "dns_error");
    wrapped.cause = error;
    throw wrapped;
  } finally {
    clearTimeout(timeoutId);
  }

  if (!Array.isArray(records) || records.length === 0) {
    throw new SecurityError("Домен не вернул IP-адресов.", "dns_error");
  }
  if (records.some(record => !isPublicIp(record.address))) {
    throw new SecurityError("Домен разрешается в приватный или служебный IP-адрес.", "blocked");
  }

  const safeRecords = records.map(record => ({ address: record.address, family: record.family }));
  if (dnsCache.size >= 5000) dnsCache.delete(dnsCache.keys().next().value);
  dnsCache.set(host, { records: safeRecords, expiresAt: Date.now() + config.dnsCacheTtlMs });
  return safeRecords;
}

export async function validateUrlTarget(input, config) {
  const url = input instanceof URL ? input : normalizeUrl(input, config);
  await resolvePublicAddresses(url.hostname, config);
  return url;
}

export function createSafeLookup(config) {
  return (hostname, options, callback) => {
    resolvePublicAddresses(hostname, config)
      .then(records => {
        if (options?.all) callback(null, records);
        else callback(null, records[0].address, records[0].family);
      })
      .catch(error => callback(error));
  };
}

export function clearDnsCache() {
  dnsCache.clear();
}
