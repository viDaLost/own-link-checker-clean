import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import checkHandler from "../api/check.js";
import batchHandler from "../api/check-batch.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const port = Number(process.env.PORT || 3000);
const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png"
};

async function parseJsonBody(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 2_000_000) throw new Error("Request body too large");
  }
  try { return raw ? JSON.parse(raw) : {}; } catch { return {}; }
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.url?.startsWith("/api/check-batch")) {
      req.body = await parseJsonBody(req);
      await batchHandler(req, res);
      return;
    }
    if (req.url?.startsWith("/api/check")) {
      req.body = await parseJsonBody(req);
      await checkHandler(req, res);
      return;
    }

    const pathname = new URL(req.url || "/", "http://localhost").pathname;
    const requested = pathname === "/" ? "/index.html" : pathname;
    const safePath = normalize(requested).replace(/^(\.\.[/\\])+/, "");
    const filePath = join(root, safePath);
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error("Not a file");
    res.statusCode = 200;
    res.setHeader("Content-Type", mime[extname(filePath)] || "application/octet-stream");
    res.setHeader("Cache-Control", "no-store");
    res.end(await readFile(filePath));
  } catch {
    res.statusCode = 404;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Not found");
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`LinkPulse dev server: http://127.0.0.1:${port}`);
});
