import test from "node:test";
import assert from "node:assert/strict";
import { clearDnsCache, isPublicIp, normalizeUrl, resolvePublicAddresses, validateUrlTarget } from "../lib/security.js";

const config = {
  allowedHosts: ["*"],
  allowedPorts: ["80", "443"],
  maxUrlLength: 4096,
  dnsTimeoutMs: 200,
  dnsCacheTtlMs: 1000
};

test.beforeEach(() => {
  delete process.env.ALLOW_PRIVATE_NETWORKS_FOR_TESTS;
  clearDnsCache();
});

test("accepts public HTTP/HTTPS URLs and normalizes host casing", () => {
  assert.equal(normalizeUrl(" HTTPS://EXAMPLE.COM/path ", config).toString(), "https://example.com/path");
});

test("rejects unsupported protocols and credentials", () => {
  assert.throws(() => normalizeUrl("file:///etc/passwd", config), /HTTP и HTTPS/);
  assert.throws(() => normalizeUrl("https://user:pass@example.com", config), /логином или паролем/);
});

test("rejects localhost and internal hostnames", () => {
  assert.throws(() => normalizeUrl("http://localhost", config), /Локальные/);
  assert.throws(() => normalizeUrl("http://service.internal", config), /Локальные/);
  assert.throws(() => normalizeUrl("http://metadata.google.internal", config), /Локальные/);
});

test("recognizes private, loopback, link-local and public IP ranges", () => {
  assert.equal(isPublicIp("127.0.0.1"), false);
  assert.equal(isPublicIp("10.0.0.1"), false);
  assert.equal(isPublicIp("169.254.169.254"), false);
  assert.equal(isPublicIp("192.168.1.1"), false);
  assert.equal(isPublicIp("::1"), false);
  assert.equal(isPublicIp("fc00::1"), false);
  assert.equal(isPublicIp("fe80::1"), false);
  assert.equal(isPublicIp("8.8.8.8"), true);
  assert.equal(isPublicIp("2606:4700:4700::1111"), true);
});

test("blocks literal private IPv4 and IPv6 targets", async () => {
  await assert.rejects(validateUrlTarget("http://127.0.0.1", config), /приватным/);
  await assert.rejects(validateUrlTarget("http://[::1]", config), /приватным/);
});

test("blocks a hostname when any DNS answer is private", async () => {
  const resolver = async () => [
    { address: "93.184.216.34", family: 4 },
    { address: "10.0.0.8", family: 4 }
  ];
  await assert.rejects(resolvePublicAddresses("example.com", config, resolver), /приватный/);
});

test("enforces optional host allowlist and allowed ports", () => {
  const restricted = { ...config, allowedHosts: ["example.com"], allowedPorts: ["443"] };
  assert.equal(normalizeUrl("https://sub.example.com/a", restricted).hostname, "sub.example.com");
  assert.throws(() => normalizeUrl("https://other.test", restricted), /ALLOWED_HOSTS/);
  assert.throws(() => normalizeUrl("https://example.com:8443", restricted), /Порт 8443/);
});
