import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { after, before, test } from "node:test";

let app;
let baseUrl;
let serverOutput = "";

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

async function waitForApplication(url) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (app?.exitCode !== null) {
      throw new Error(`Next.js exited before startup:\n${serverOutput}`);
    }
    try {
      const response = await fetch(url);
      if (response.status === 200) return;
    } catch {
      // The server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Next.js did not start in time:\n${serverOutput}`);
}

before(async () => {
  const port = await reservePort();
  baseUrl = `http://127.0.0.1:${port}`;
  app = spawn(
    process.execPath,
    ["node_modules/next/dist/bin/next", "start", "-H", "127.0.0.1", "-p", String(port)],
    {
      cwd: new URL("..", import.meta.url),
      env: {
        ...process.env,
        NODE_ENV: "production",
        NEXT_TELEMETRY_DISABLED: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  app.stdout.on("data", (chunk) => {
    serverOutput += chunk;
  });
  app.stderr.on("data", (chunk) => {
    serverOutput += chunk;
  });
  await waitForApplication(baseUrl);
});

after(async () => {
  if (!app || app.exitCode !== null) return;
  app.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => app.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (app.exitCode === null) app.kill("SIGKILL");
});

test("serves the LinkPulse application from the root route", async () => {
  const response = await fetch(baseUrl);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  assert.equal(response.headers.get("x-frame-options"), "DENY");

  const html = await response.text();
  assert.match(html, /LINKPULSE/);
  assert.match(html, /Проверьте все ссылки/);
  assert.match(html, /10(?:\s|&nbsp;|\u00a0)*000/);
});

test("streams safe diagnostics from the Vercel route handler", async () => {
  const response = await fetch(`${baseUrl}/api/check-batch`, {
    method: "POST",
    headers: {
      accept: "application/x-ndjson",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      urls: ["not a url", "http://localhost/private"],
      mode: "quick",
      concurrency: 2,
    }),
  });

  assert.equal(response.status, 200);
  assert.match(
    response.headers.get("content-type") ?? "",
    /^application\/x-ndjson\b/i,
  );

  const events = (await response.text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const results = events
    .filter((event) => event.type === "result")
    .map((event) => event.result);

  assert.equal(results.length, 2);
  assert.deepEqual(
    new Set(results.map((result) => result.category)),
    new Set(["invalid_url", "blocked"]),
  );
  assert.equal(events.at(-1)?.type, "done");
});

test("accepts a 10,000 URL run across Vercel-sized batches", async () => {
  const batchSize = 200;
  const batchCount = 50;
  let checked = 0;

  for (let batch = 0; batch < batchCount; batch += 1) {
    const urls = Array.from(
      { length: batchSize },
      (_, index) => `http://localhost/run-${batch}/url-${index}`,
    );
    const response = await fetch(`${baseUrl}/api/check-batch`, {
      method: "POST",
      headers: {
        accept: "application/x-ndjson",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        urls,
        mode: "quick",
        concurrency: 12,
      }),
    });

    assert.equal(response.status, 200, `batch ${batch + 1} was rejected`);
    const events = (await response.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const results = events.filter((event) => event.type === "result");
    assert.equal(results.length, batchSize);
    assert.equal(events.at(-1)?.type, "done");
    checked += results.length;
  }

  assert.equal(checked, 10_000);
});
