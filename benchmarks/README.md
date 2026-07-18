# Benchmark methodology

The benchmark uses a local controlled HTTP fixture with deterministic 20–68 ms delays, mixed HTTP 200/404 responses, redirects and endpoints that force HEAD→GET fallback. The same URL set and machine were used for each before/after pair.

| Dataset | Before | After | Throughput |
|---|---:|---:|---:|
| 100 URL | 32.271 s | 1.251 s | 3.10 → 79.93 URL/s |
| 1,000 URL | 317.430 s | 12.022 s | 3.15 → 83.18 URL/s |

These numbers isolate application overhead and concurrency behavior. Public-internet performance will vary with DNS, origin latency, rate limits and geographic distance.
