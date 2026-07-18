import test from "node:test";
import assert from "node:assert/strict";
import { canonicalizeForDedupe, chunkArray, csvEscape, dedupeUrls, extractUrls, parseInputCandidates } from "../assets/utils.js";

test("extracts URLs from text, CSV and sitemap XML", () => {
  const text = '<url><loc>https://example.com/a?x=1&amp;y=2</loc></url>\n"https://example.com/b","https://example.com/c"';
  const urls = extractUrls(text);
  assert.ok(urls.includes("https://example.com/a?x=1&y=2"));
  assert.ok(urls.includes("https://example.com/b"));
  assert.ok(urls.includes("https://example.com/c"));
});

test("keeps isolated invalid lines so the server can diagnose them", () => {
  const values = parseInputCandidates("https://example.com\nnot-a-url");
  assert.deepEqual(values, ["https://example.com", "not-a-url"]);
});

test("deduplicates canonical URL variants", () => {
  assert.equal(canonicalizeForDedupe("HTTPS://EXAMPLE.COM"), "https://example.com/");
  const values = dedupeUrls(["HTTPS://EXAMPLE.COM", "https://example.com/", "bad", "bad"]);
  assert.equal(values.length, 2);
  assert.equal(values[0].occurrences, 2);
  assert.equal(values[1].occurrences, 2);
});

test("escapes quotes and neutralizes CSV formulas", () => {
  assert.equal(csvEscape('a"b'), '"a""b"');
  assert.equal(csvEscape('=HYPERLINK("x")'), "\"'=HYPERLINK(\"\"x\"\")\"");
});

test("splits large runs into stable API-sized chunks", () => {
  const values = Array.from({ length: 10000 }, (_, index) => index);
  const chunks = chunkArray(values, 500);
  assert.equal(chunks.length, 20);
  assert.equal(chunks[0].length, 500);
  assert.equal(chunks.at(-1).length, 500);
  assert.deepEqual(chunks.flat(), values);
});
