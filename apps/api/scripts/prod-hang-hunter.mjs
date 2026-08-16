#!/usr/bin/env node
// prod-hang-hunter.mjs
//
// Reproduces and diagnoses the intermittent /api/me hang against
// production. Runs a controlled request loop and captures enough
// data on each failure to distinguish between:
//
//   • Neon compute suspend/wake latency
//   • Vercel Fluid function cold-start latency
//   • Per-instance stuck pool (some Vercel instances broken, others not)
//   • Client-side network path variance
//   • Something we haven't thought of yet
//
// Usage:
//   Get your JWT from browser devtools:
//     Application -> Cookies -> __session   (copy the value)
//
//   CLERK_JWT="eyJhbG..." API_URL="https://app.seedlings.pro" \
//     node apps/api/scripts/prod-hang-hunter.mjs
//
//   Options via env:
//     CLERK_JWT      required — your session token
//     API_URL        required — the frontend origin (proxy). Defaults
//                     to https://app.seedlings.pro
//     DIRECT_API_URL optional — the API's own origin (bypasses the
//                     Next.js proxy). If set, we hit BOTH so we can
//                     tell if the failure is in the proxy or in the API.
//     ITERATIONS     default 200 — number of loops
//     DELAY_MS       default 1500 — pause between requests
//     TIMEOUT_MS     default 13000 — per-request timeout
//     CONCURRENCY    default 1 — fire N requests in parallel each tick
//                     (useful for reproducing the pool race)
//     ENDPOINTS      default "hello,healthz,me" — comma-separated
//                     list of paths (each is prefixed with /api/).
//                     hello    = no DB, no auth (isolates function boot)
//                     healthz  = DB only, no auth  (isolates Neon path)
//                     me       = full auth + DB    (matches user reports)
//                     Comparing which of these hang lets us pinpoint
//                     WHERE in the request pipeline the failure lives.
//
// The script writes a JSONL log next to it: prod-hang-<timestamp>.jsonl
// One line per HTTP call. Use `jq` / `grep` to slice it.

import { writeFileSync, appendFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const JWT = process.env.CLERK_JWT;
const API_URL = (process.env.API_URL || "").replace(/\/+$/, "");
const DIRECT_API_URL = process.env.DIRECT_API_URL ? process.env.DIRECT_API_URL.replace(/\/+$/, "") : null;
const ITERATIONS = Number(process.env.ITERATIONS || 200);
const DELAY_MS = Number(process.env.DELAY_MS || 1500);
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 13000);
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || 1));
const ENDPOINTS = (process.env.ENDPOINTS || "hello,healthz,me").split(",").map((s) => s.trim()).filter(Boolean);

if (!JWT) {
  console.error("ERROR: CLERK_JWT is required.");
  console.error("Get it from browser devtools:");
  console.error("  Application -> Cookies -> __session   (copy the value)");
  process.exit(1);
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const logFile = join(scriptDir, `prod-hang-${stamp}.jsonl`);

console.log(`Target (proxy):   ${API_URL}`);
if (DIRECT_API_URL) console.log(`Target (direct):  ${DIRECT_API_URL}`);
console.log(`Iterations:       ${ITERATIONS}`);
console.log(`Concurrency:      ${CONCURRENCY} per tick`);
console.log(`Delay:            ${DELAY_MS}ms between ticks`);
console.log(`Per-req timeout:  ${TIMEOUT_MS}ms`);
console.log(`Endpoints:        ${ENDPOINTS.join(", ")}`);
console.log(`Log file:         ${logFile}`);
console.log("");
console.log("Legend: OK=✓  BADSTATUS=✗  TIMEOUT=⏱  ERROR=💥");
console.log("");

writeFileSync(logFile, "");

const authHeader = { Authorization: `Bearer ${JWT}` };

async function timedFetch(url, { requireAuth }) {
  const start = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("client-timeout")), TIMEOUT_MS);
  const startedAt = new Date().toISOString();
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        ...(requireAuth ? authHeader : {}),
        "user-agent": "prod-hang-hunter/1.0",
        accept: "application/json",
      },
      signal: controller.signal,
      redirect: "manual",
      cache: "no-store",
    });
    const body = await res.text();
    const ms = performance.now() - start;
    const headers = Object.fromEntries(res.headers.entries());
    // Parse Server-Timing header. Format: "name;dur=45, other;dur=200, total;dur=250"
    const serverTiming = {};
    const st = headers["server-timing"];
    if (st) {
      for (const entry of st.split(",").map((s) => s.trim())) {
        const m = entry.match(/^([^;]+);dur=([\d.]+)/);
        if (m) serverTiming[m[1].trim()] = Number(m[2]);
      }
    }
    // On failure, keep MORE body + ALL headers so we can see exactly
    // what the server said. Successes we trim to keep the log small.
    const isFailure = !res.ok;
    return {
      url,
      startedAt,
      ms: Math.round(ms),
      status: res.status,
      ok: res.ok,
      bodyBytes: body.length,
      body: isFailure
        ? (body.length <= 10000 ? body : body.slice(0, 10000) + "...(truncated at 10KB)")
        : (body.length <= 300 ? body : body.slice(0, 300) + "...(truncated)"),
      serverTiming,
      // Failures: capture EVERY header (may reveal rate-limit / retry-after / vercel info)
      // Successes: only Vercel-specific ones (cheap breadcrumbs)
      allHeaders: isFailure ? headers : undefined,
      vercelHeaders: Object.fromEntries(
        Object.entries(headers).filter(([k]) => k.startsWith("x-vercel") || k.startsWith("x-matched") || k === "server" || k === "cf-ray")
      ),
      rateLimit: Object.fromEntries(
        Object.entries(headers).filter(([k]) =>
          k.startsWith("x-ratelimit") ||
          k === "retry-after" ||
          k === "ratelimit-limit" ||
          k === "ratelimit-remaining" ||
          k === "ratelimit-reset"
        )
      ),
      error: null,
    };
  } catch (err) {
    const ms = performance.now() - start;
    const isAbort = err.name === "AbortError";
    return {
      url,
      startedAt,
      ms: Math.round(ms),
      status: null,
      ok: false,
      bodyBytes: 0,
      bodyExcerpt: null,
      vercelHeaders: null,
      error: isAbort ? "TIMEOUT" : `${err.name}: ${err.message}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

function summarizeResult(r) {
  const stStr = r.serverTiming && Object.keys(r.serverTiming).length
    ? ` [srv:${Object.entries(r.serverTiming).map(([k, v]) => `${k}=${v}`).join(",")}]`
    : "";
  if (r.error === "TIMEOUT") return `⏱  TIMEOUT ${r.ms}ms${stStr}`;
  if (r.error) return `💥 ${r.error} ${r.ms}ms${stStr}`;
  if (!r.ok) return `✗  ${r.status} ${r.ms}ms${stStr}`;
  return `✓  ${r.status} ${r.ms}ms${stStr}`;
}

const results = [];

async function runOne(iter) {
  const bases = DIRECT_API_URL ? [{ label: "prx", base: API_URL }, { label: "dir", base: DIRECT_API_URL }] : [{ label: "prx", base: API_URL }];
  const lineParts = [`[${String(iter).padStart(3, "0")}/${ITERATIONS}]`];
  for (const b of bases) {
    for (const ep of ENDPOINTS) {
      const url = `${b.base}/api/${ep.replace(/^\/+/, "")}`;
      const requireAuth = ep === "me" || ep.startsWith("me/");
      const r = await timedFetch(url, { requireAuth });
      const record = { iteration: iter, target: b.label, endpoint: ep, ...r };
      results.push(record);
      appendFileSync(logFile, JSON.stringify(record) + "\n");
      lineParts.push(`${b.label}:${ep}=${summarizeResult(r)}`);
    }
  }
  console.log(lineParts.join("  |  "));
}

async function runConcurrent(iter, n) {
  await Promise.all(Array.from({ length: n }, () => runOne(iter)));
}

const globalStart = Date.now();
for (let i = 1; i <= ITERATIONS; i++) {
  if (CONCURRENCY === 1) {
    await runOne(i);
  } else {
    await runConcurrent(i, CONCURRENCY);
  }
  if (i < ITERATIONS) await new Promise((r) => setTimeout(r, DELAY_MS));
}
const wallSec = Math.round((Date.now() - globalStart) / 1000);

// ─── Summary ─────────────────────────────────────────────────────────
console.log("");
console.log("=== SUMMARY ===");
console.log(`Wall clock: ${wallSec}s`);
const byLabel = new Map();
for (const r of results) {
  const key = `${r.target}:${r.endpoint}`;
  if (!byLabel.has(key)) byLabel.set(key, []);
  byLabel.get(key).push(r);
}
for (const [key, arr] of byLabel) {
  const ok = arr.filter((r) => r.ok);
  const timeouts = arr.filter((r) => r.error === "TIMEOUT");
  const errors = arr.filter((r) => r.error && r.error !== "TIMEOUT");
  const badstatus = arr.filter((r) => !r.ok && !r.error);
  const times = ok.map((r) => r.ms).sort((a, b) => a - b);
  const p = (q) => times.length ? times[Math.min(times.length - 1, Math.floor(times.length * q))] : "-";
  console.log(
    `  ${key.padEnd(14)}  n=${arr.length}  ok=${ok.length}  timeout=${timeouts.length}  err=${errors.length}  4xx/5xx=${badstatus.length}  ` +
      `  p50=${p(0.5)}ms  p95=${p(0.95)}ms  max=${times[times.length - 1] ?? "-"}ms`
  );
}

// ─── Failure detail + window analysis ────────────────────────────────
const failures = results.filter((r) => !r.ok);
if (failures.length > 0) {
  console.log("");
  console.log("=== FAILURES ===");
  for (const f of failures) {
    console.log(
      `iter ${f.iteration} @ ${f.startedAt} ${f.target}:${f.endpoint}  ${summarizeResult(f)}`
    );
    if (f.vercelHeaders && Object.keys(f.vercelHeaders).length) {
      console.log(`  vercel: ${JSON.stringify(f.vercelHeaders)}`);
    }
    if (f.rateLimit && Object.keys(f.rateLimit).length) {
      console.log(`  RATELIMIT: ${JSON.stringify(f.rateLimit)}`);
    }
    if (f.allHeaders) {
      // Highlight interesting server-side headers we don't otherwise track
      const interesting = Object.fromEntries(
        Object.entries(f.allHeaders).filter(([k]) =>
          k === "x-robots-tag" ||
          k.startsWith("x-clerk") ||
          k === "www-authenticate" ||
          k === "cache-control" ||
          k === "content-type" ||
          k === "server-timing"
        )
      );
      if (Object.keys(interesting).length) console.log(`  headers: ${JSON.stringify(interesting)}`);
    }
    if (f.body) console.log(`  body: ${f.body.split("\n").slice(0, 3).join(" | ")}`);
  }

  // ─── Failure-window analysis ───────────────────────────────────────
  // The user described a "works, works, works, then STOPS working for a
  // while, then works again" pattern. That's classic rate-limit /
  // resource-exhaustion. Detect consecutive failure runs and their
  // duration, so we can see if this reproduces.
  console.log("");
  console.log("=== FAILURE WINDOWS ===");
  const meResults = results.filter((r) => r.endpoint === "me" && r.target === "prx").sort((a, b) => a.iteration - b.iteration);
  const windows = [];
  let currentWindow = null;
  for (const r of meResults) {
    if (!r.ok) {
      if (!currentWindow) currentWindow = { startIter: r.iteration, startedAt: r.startedAt, count: 0, samples: [] };
      currentWindow.count++;
      currentWindow.endIter = r.iteration;
      currentWindow.endedAt = r.startedAt;
      currentWindow.samples.push({ iter: r.iteration, ms: r.ms, status: r.status, error: r.error });
    } else if (currentWindow) {
      windows.push(currentWindow);
      currentWindow = null;
    }
  }
  if (currentWindow) windows.push(currentWindow);

  if (windows.length === 0) {
    console.log("  (no /me failures on the proxy target)");
  } else {
    for (const w of windows) {
      const durMs = new Date(w.endedAt).getTime() - new Date(w.startedAt).getTime();
      console.log(
        `  window: iters ${w.startIter}..${w.endIter}  count=${w.count}  span=${Math.round(durMs / 1000)}s  ` +
          `first=${w.startedAt}  last=${w.endedAt}`
      );
    }
    // Gaps between windows — the "recovery time"
    if (windows.length > 1) {
      console.log("");
      console.log("  Recovery gaps (time between last failure of window N and first failure of window N+1):");
      for (let i = 1; i < windows.length; i++) {
        const gap = new Date(windows[i].startedAt).getTime() - new Date(windows[i - 1].endedAt).getTime();
        console.log(`    window ${i}->${i + 1}: ${Math.round(gap / 1000)}s`);
      }
    }
  }
}

console.log("");
console.log(`Full log: ${logFile}`);
console.log(`Analyze with:`);
console.log(`  jq -c 'select(.ok == false)' ${logFile}                  # all failures`);
console.log(`  jq -c 'select(.endpoint == "me") | {iter: .iteration, ms, status, error, vercelHeaders}' ${logFile}`);
