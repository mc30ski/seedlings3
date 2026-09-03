// ─────────────────────────────────────────────────────────────────────────────
// Weather alerts build gate
//
// The weather bar renders on EVERY screen in the app. Severe-weather alerts
// were added on top of it as a second, independent service (NWS), and the
// whole point of that design is that the new service can never take the old
// one down.
//
// The specific trap: the OpenWeather fetch is a `Promise.all` that throws on
// any non-ok response. Folding the NWS call into it — the obvious thing to do
// when adding a third fetch — would mean an NWS outage blanks the temperature
// for every worker. This gate makes that impossible to reintroduce.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join, resolve } from "path";
import { kindFor } from "./weatherAlerts";

const REPO_ROOT = resolve(__dirname, "../../../..");
const SERVICE = readFileSync(join(REPO_ROOT, "apps/api/src/services/weatherAlerts.ts"), "utf8");
const WORKER = readFileSync(join(REPO_ROOT, "apps/api/src/routes/worker.ts"), "utf8");

describe("weather alerts build gate — alerts can never break the weather bar", () => {
  it("the NWS call is NOT inside the Promise.all that throws on a bad response", () => {
    const i = WORKER.indexOf("const [currentRes, forecastRes] = await Promise.all([");
    expect(i, "the OpenWeather Promise.all should still exist").toBeGreaterThan(-1);
    const block = WORKER.slice(i, WORKER.indexOf("]);", i));
    expect(block, "fetchWeatherAlerts must not be awaited inside the throwing Promise.all")
      .not.toMatch(/fetchWeatherAlerts|weather\.gov/);
  });

  it("the alert fetch is wrapped so nothing propagates to the caller", () => {
    // Every exit from fetchWeatherAlerts must be an array. A throw here
    // surfaces as a 500 on /weather, which is the whole failure mode.
    expect(SERVICE).toMatch(/export async function fetchWeatherAlerts[\s\S]*?try \{/);
    expect(SERVICE).toMatch(/\} catch \{[\s\S]*?return \[\];[\s\S]*?\}/);
  });

  it("has a timeout, so a hanging NWS cannot stall the weather response", () => {
    expect(SERVICE).toMatch(/AbortSignal\.timeout\(/);
  });

  it("sends a User-Agent — NWS throttles callers without one", () => {
    expect(SERVICE).toMatch(/"User-Agent"/);
  });

  it("caches through the shared cache, so every worker's poll is not an NWS request", () => {
    // Was a private in-memory Map, which died on every serverless cold start
    // — near-useless against an API that throttles. Now goes through
    // lib/cache.ts, which adds a DB tier and stale-on-error.
    expect(SERVICE).toMatch(/from "\.\.\/lib\/cache"/);
    expect(SERVICE).toMatch(/cached\("nwsAlerts"/);
    expect(SERVICE).not.toMatch(/const cache = new Map</);
  });

  it("a malformed keyword setting shows every alert rather than none", () => {
    // Failing closed here would silently suppress a real advisory.
    const i = SERVICE.indexOf("NWS_ALERTS_EVENT_KEYWORDS");
    const parse = SERVICE.slice(SERVICE.indexOf("let keywords", i));
    expect(parse).toMatch(/catch \{[\s\S]*?keywords = \[\];/);
    expect(SERVICE).toMatch(/keywords\.length === 0 \|\|/);
  });
});

describe("weather alerts — event classification", () => {
  it("maps the events an outdoor crew actually cares about", () => {
    expect(kindFor("Heat Advisory")).toBe("heat");
    expect(kindFor("Excessive Heat Warning")).toBe("heat");
    expect(kindFor("Severe Thunderstorm Warning")).toBe("storm");
    expect(kindFor("Tornado Warning")).toBe("tornado");
    expect(kindFor("Flash Flood Warning")).toBe("flood");
    expect(kindFor("Air Quality Alert")).toBe("air");
    expect(kindFor("Dense Fog Advisory")).toBe("fog");
    expect(kindFor("Red Flag Warning")).toBe("fire");
    expect(kindFor("Freeze Warning")).toBe("cold");
  });

  it("tornado beats the generic storm rule", () => {
    // "Tornado Watch" contains neither "thunderstorm" nor "storm", but a
    // future NWS product might; order matters and this pins it.
    expect(kindFor("Tornado Watch")).toBe("tornado");
  });

  it("falls back to a generic kind rather than throwing on an unknown event", () => {
    expect(kindFor("Volcanic Ash Advisory")).toBe("other");
    expect(kindFor("")).toBe("other");
  });
});

describe("weather alerts — the /weather response stays additive", () => {
  it("every pre-existing field is still returned alongside alerts", () => {
    const i = WORKER.indexOf("        alerts,\n        current: {");
    expect(i, "alerts should sit beside current, not replace anything").toBeGreaterThan(-1);
    const block = WORKER.slice(i, i + 900);
    for (const field of ["temp:", "feelsLike:", "description:", "icon:", "humidity:", "windSpeed:"]) {
      expect(block, `current.${field} must survive`).toMatch(field);
    }
  });
});

// ── Deduping must never drop a day ────────────────────────────────────────
describe("weather alerts — repeated events merge their coverage", () => {
  const SRC = readFileSync(join(REPO_ROOT, "apps/api/src/services/weatherAlerts.ts"), "utf8");
  const block = SRC.slice(SRC.indexOf("Collapse repeats of the same event"), SRC.indexOf("const alerts = ["));

  it("unions dateKeys across instances of the same event", () => {
    // The bug: NWS had two Heat Advisories (today, and tomorrow). Keeping
    // only the longest-lived discarded today, so the title bar (not
    // date-scoped) showed the advisory while the Today section header
    // (date-scoped) did not.
    expect(block).toMatch(/dateKeys:\s*\[\.\.\.new Set\(\[\.\.\.prev\.dateKeys,\s*\.\.\.a\.dateKeys\]\)\]/);
  });

  it("widens the span rather than picking one instance's", () => {
    expect(block).toMatch(/onset:[\s\S]*?filter\(Boolean\)\.sort\(\)\[0\]/);
    expect(block).toMatch(/ends:[\s\S]*?filter\(Boolean\)\.sort\(\)\.pop\(\)/);
  });

  it("still emits one row per event name", () => {
    expect(block).toMatch(/byEvent\.set\(a\.event,/);
  });

  it("does NOT keep only the longest-lived instance", () => {
    // The exact shape of the old bug.
    expect(block).not.toMatch(/const rep = [\s\S]{0,80}\(a\.ends \?\? ""\) > \(prev\.ends \?\? ""\)[\s\S]{0,40}byEvent\.set\(a\.event, a\)/);
  });
});

// ── Every path that publishes weather must publish alerts with it ─────────
describe("weather alerts — reach every surface, including late mounters", () => {
  const BAR = readFileSync(
    join(REPO_ROOT, "apps/web/src/ui/components/WeatherBar.tsx"), "utf8",
  );

  it("BOTH __seedlingsWeather writes include alerts", () => {
    // WeatherBar populates this synchronous cache twice: once from
    // localStorage on mount, once after the network fetch. Components that
    // mount LATER read the cache rather than waiting for the next broadcast
    // event — so a write that omits alerts leaves them empty.
    //
    // The bug: only the cached-read path carried alerts. Switching role scope
    // remounted JobsTab, whose hook initialised from the post-fetch cache and
    // got nothing, while the title bar (already holding React state) kept
    // showing the advisory. Two surfaces, same data, disagreeing.
    const writes = [...BAR.matchAll(/__seedlingsWeather = \{[\s\S]*?\};/g)].map((m) => m[0]);
    expect(writes.length, "expected both cache writes to still exist").toBe(2);
    for (const w of writes) {
      expect(w, "every __seedlingsWeather write must carry alerts").toMatch(/alerts:/);
    }
  });

  it("BOTH broadcast events include alerts", () => {
    const events = [...BAR.matchAll(/detail: \{[\s\S]*?\}/g)].map((m) => m[0]);
    expect(events.length).toBeGreaterThanOrEqual(2);
    for (const e of events) {
      expect(e, "every seedlings:weather broadcast must carry alerts").toMatch(/alerts:/);
    }
  });
});

// ── The title bar must say WHEN ───────────────────────────────────────────
describe("weather alerts — the undated surface can't contradict the dated ones", () => {
  const LIB = readFileSync(join(REPO_ROOT, "apps/web/src/lib/weatherAlerts.ts"), "utf8");
  const BADGE = readFileSync(join(REPO_ROOT, "apps/web/src/ui/components/WeatherAlertBadge.tsx"), "utf8");

  it("topAlert prefers an alert covering today", () => {
    // The bug: the title bar showed any active alert with no date awareness.
    // An advisory starting tomorrow lit it up while the Today section —
    // correctly — showed nothing, which makes the app look broken.
    expect(LIB).toMatch(/a\.dateKeys\.includes\(todayKey\)/);
    expect(LIB).toMatch(/return \{ alert: now, today: true \}/);
  });

  it("the title badge distinguishes now from upcoming", () => {
    expect(BADGE).toMatch(/topAlert\(alerts, today\)/);
    expect(BADGE).toMatch(/opacity=\{top\.today \? 1 : 0\.55\}/);
  });

  it("the tooltip and aria-label say when it applies", () => {
    expect(BADGE).toMatch(/whenLabel\(/);
    expect(BADGE).toMatch(/title=\{`\$\{a\.event\} — \$\{when\}/);
    expect(BADGE).toMatch(/aria-label=\{`\$\{a\.event\} \$\{when\}`\}/);
  });
});

// ── An alert must reach the feed even on a day with no work ───────────────
describe("weather alerts — the job feed shows alerts regardless of scheduling", () => {
  const JOBS = readFileSync(join(REPO_ROOT, "apps/web/src/ui/tabs/JobsTab.tsx"), "utf8");

  it("renders a feed-level banner, not only per-day badges", () => {
    // The bug: alerts were attached ONLY to day-section headers, so an alert
    // falling on a day with no scheduled jobs had nowhere to render and
    // disappeared from the feed. The title bar showed a Heat Advisory and the
    // feed showed nothing — because nothing was booked that day. An empty day
    // is exactly when the crew still needs to know; it's the day you'd add
    // work to.
    expect(JOBS).toMatch(/weatherAlerts\.length > 0 && \(/);
    expect(JOBS).toMatch(/weatherAlerts\.map\(\(al\) =>/);
  });

  it("the banner says which day the alert is for", () => {
    expect(JOBS).toMatch(/whenLabel\(al, bizToday\(\), bizTomorrow\(\)\)/);
  });

  it("per-day badges still exist for the days that do have work", () => {
    expect(JOBS).toMatch(/alertsForDate\(weatherAlerts, group\.key\)/);
  });
});

// ── Today's high/low must come from the same place as every other day ─────
describe("weather — today's high is a forecast, not a station spread", () => {
  it("does not use current.main.temp_max as the daily high", () => {
    // OpenWeather's CURRENT endpoint reports temp_max/temp_min as the spread
    // across nearby stations right now — not a daily forecast. Using them
    // showed "Today 83°/78°" on a day forecast to reach 97°, with a Heat
    // Advisory in force, while tomorrow correctly read 95° because tomorrow
    // was built from the forecast list.
    const block = WORKER.slice(WORKER.indexOf("const todayEntry = {"), WORKER.indexOf("const todayEntry = {") + 400);
    expect(block).not.toMatch(/high: Math\.round\(current\.main\?\.temp_max/);
    expect(block).not.toMatch(/low: Math\.round\(current\.main\?\.temp_min/);
  });

  it("derives today from the forecast entries for today", () => {
    expect(WORKER).toMatch(/const todayHighs = todayForecastEntries\.map/);
    expect(WORKER).toMatch(/const todayLows = todayForecastEntries\.map/);
    expect(WORKER).toMatch(/high: Math\.round\(todayHigh\)/);
    expect(WORKER).toMatch(/low: Math\.round\(todayLow\)/);
  });

  it("folds in what has already been observed", () => {
    // The forecast list starts at the current 3-hour block, so by evening it
    // no longer covers the morning. The displayed high must never be lower
    // than something already measured.
    expect(WORKER).toMatch(/Math\.max\(\.\.\.todayHighs, observedNow/);
    expect(WORKER).toMatch(/Math\.min\(\.\.\.todayLows, observedNow/);
  });
});
