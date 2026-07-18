export function extractUrls(text) {
  const source = String(text || "");
  const values = [];
  const locPattern = /<loc(?:\s[^>]*)?>([\s\S]*?)<\/loc>/gi;
  let match;
  while ((match = locPattern.exec(source))) {
    values.push(decodeEntities(match[1].trim()));
  }

  const urlPattern = /https?:\/\/[^\s<>"'`]+/gi;
  while ((match = urlPattern.exec(source))) {
    values.push(match[0].replace(/[),.;\]}]+$/g, ""));
  }

  if (!values.length) {
    for (const line of source.split(/\r?\n/)) {
      const candidate = line.trim().replace(/^['"]|['"]$/g, "");
      if (/^https?:\/\//i.test(candidate)) values.push(candidate);
    }
  }

  return values.filter(Boolean);
}

function decodeEntities(value) {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'");
}

export function parseInputCandidates(text) {
  const source = String(text || "");
  const urls = extractUrls(source);
  const seenUrl = new Set(urls);
  const candidates = [...urls];
  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || seenUrl.has(trimmed)) continue;
    if (!/https?:\/\//i.test(trimmed) && !/[\s,;]/.test(trimmed)) candidates.push(trimmed);
  }
  return candidates;
}

export function canonicalizeForDedupe(input) {
  const trimmed = String(input || "").trim();
  try {
    return new URL(trimmed).toString();
  } catch {
    return trimmed;
  }
}

export function dedupeUrls(urls) {
  const map = new Map();
  for (const value of urls) {
    const original = String(value || "").trim();
    if (!original) continue;
    const key = canonicalizeForDedupe(original);
    const existing = map.get(key);
    if (existing) existing.occurrences += 1;
    else map.set(key, { url: original, key, occurrences: 1 });
  }
  return [...map.values()];
}

export function chunkArray(values, size) {
  const safeSize = Math.max(1, Math.floor(Number(size) || 1));
  const chunks = [];
  for (let index = 0; index < values.length; index += safeSize) {
    chunks.push(values.slice(index, index + safeSize));
  }
  return chunks;
}

export function domainOf(value) {
  try { return new URL(value).hostname; } catch { return ""; }
}

export function formatDuration(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value)) return "—";
  if (value < 1000) return `${Math.round(value)} мс`;
  return `${(value / 1000).toFixed(value < 10000 ? 1 : 0)} с`;
}

export function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return "—";
  if (value < 1024) return `${value} Б`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} КБ`;
  return `${(value / 1024 ** 2).toFixed(1)} МБ`;
}

export function csvEscape(value) {
  let text = String(value ?? "");
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
