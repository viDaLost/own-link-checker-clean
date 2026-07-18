const decodeEntities = value => value
  .replaceAll("&amp;", "&")
  .replaceAll("&lt;", "<")
  .replaceAll("&gt;", ">")
  .replaceAll("&quot;", '"')
  .replaceAll("&#39;", "'");

self.onmessage = event => {
  const text = String(event.data?.text || "");
  const urls = [];
  const locPattern = /<loc(?:\s[^>]*)?>([\s\S]*?)<\/loc>/gi;
  let match;
  while ((match = locPattern.exec(text))) urls.push(decodeEntities(match[1].trim()));

  const urlPattern = /https?:\/\/[^\s<>"'`]+/gi;
  while ((match = urlPattern.exec(text))) urls.push(match[0].replace(/[),.;\]}]+$/g, ""));

  self.postMessage({ urls: [...new Set(urls.filter(Boolean))] });
};
