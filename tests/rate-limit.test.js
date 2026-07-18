import test from "node:test";
import assert from "node:assert/strict";
import { acquireJobSlot, clearRateLimits, consumeRateLimit, releaseJobSlot } from "../lib/rate-limit.js";

const config = {
  runsPerMinute: 2,
  urlsPerMinute: 5,
  maxActiveJobs: 1
};

test.beforeEach(() => clearRateLimits());

test("limits both run count and URL volume", () => {
  assert.equal(consumeRateLimit("ip", config, 2).allowed, true);
  assert.equal(consumeRateLimit("ip", config, 2).allowed, true);
  assert.equal(consumeRateLimit("ip", config, 1).allowed, false);
});

test("limits active jobs per client", () => {
  assert.equal(acquireJobSlot("ip", config), true);
  assert.equal(acquireJobSlot("ip", config), false);
  releaseJobSlot("ip");
  assert.equal(acquireJobSlot("ip", config), true);
});
