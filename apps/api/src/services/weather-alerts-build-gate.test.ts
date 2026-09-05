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

  it("an alert on a day the feed isn't showing still renders", () => {
    // THE INVARIANT, unchanged: alerts were once attached ONLY to day-section
    // headers, so one falling on a day with no scheduled jobs had nowhere to
    // render and disappeared. The title bar showed a Heat Advisory and the
    // feed showed nothing — because nothing was booked that day. An empty day
    // is exactly when the crew still needs to know; it's the day you'd add
    // work to.
    //
    // The MECHANISM changed: the full-width panel that used to repeat every
    // alert above the feed is gone (details now sit behind the caret on each
    // day chip), so the feed renders only the LEFTOVERS — alerts no visible
    // day section covers. Same guarantee, nothing duplicated.
    expect(JOBS).toMatch(/const shownDays = new Set\(dayGroups\.map\(\(g\) => g\.key\)\)/);
    expect(JOBS).toMatch(/!al\.dateKeys\.some\(\(k\) => shownDays\.has\(k\)\)/);
    expect(JOBS).toMatch(/if \(!orphans\.length\) return null;/);
    expect(JOBS).toMatch(/alerts=\{orphans\}/);
  });

  it("the leftovers are labelled so they don't read as today", () => {
    expect(JOBS).toMatch(/Also ahead/);
  });

  it("the expanded detail still says which day the alert is for", () => {
    // whenLabel moved into the badge when the panel collapsed into it.
    const badge = readFileSync(
      join(REPO_ROOT, "apps/web/src/ui/components/WeatherAlertBadge.tsx"), "utf8",
    );
    expect(badge).toMatch(/whenLabel\(alert, today, tomorrow\)/);
    expect(badge).toMatch(/alert\.instruction/);
  });

  it("every surface that shows a chip can expand it", () => {
    // A chip you can't open is a dead end now that the panel is gone.
    const matches = JOBS.match(/<WeatherAlertBadge[\s\S]{0,420}?\/>/g) ?? [];
    expect(matches.length).toBeGreaterThan(0);
    for (const m of matches) expect(m, `missing expandable: ${m}`).toMatch(/expandable/);
  });

  it("the expanded body renders OUTSIDE the header flex row", () => {
    // The regression this replaced: the panel was emitted from inside the
    // badge, became a flex sibling of the date and the job count, and shoved
    // the whole header line sideways. The badge is controlled now and the
    // body is a separate component the caller places below the header.
    const badge = readFileSync(
      join(REPO_ROOT, "apps/web/src/ui/components/WeatherAlertBadge.tsx"), "utf8",
    );
    expect(badge).toMatch(/export function WeatherAlertDetail/);
    // No internal open state — it must be driven by the caller.
    expect(badge).not.toMatch(/useState/);
    expect(JOBS).toMatch(/<WeatherAlertDetail alerts=\{forDay\} \/>/);
  });

  it("the disclosure is the same filled triangle the day headers use", () => {
    const badge = readFileSync(
      join(REPO_ROOT, "apps/web/src/ui/components/WeatherAlertBadge.tsx"), "utf8",
    );
    expect(badge).toMatch(/open \? "\\u25BC" : "\\u25B6"/);
  });

  it("the most urgent advisory starts expanded", () => {
    // A collapsed chip says "Heat" and nothing about what to do; the NWS
    // instruction is the part that matters to someone about to spend the day
    // outside in it.
    expect(JOBS).toMatch(/const top = topAlert\(weatherAlerts, bizToday\(\)\);/);
    expect(JOBS).toMatch(/setOpenAlertId\(top\.alert\.id\)/);
  });

  it("the weather poll cannot reopen a panel the crew closed", () => {
    // weatherAlerts gets a new array identity on every refresh. Without the
    // once-per-mount guard, the default would re-fire and the panel would keep
    // springing back open while someone is trying to read the feed.
    expect(JOBS).toMatch(/alertDefaultedRef/);
    expect(JOBS).toMatch(/if \(alertDefaultedRef\.current \|\| !weatherAlerts\.length\) return;/);
  });

  it("a day with several advisories shows ONE chip and a count", () => {
    // Two chips side by side overflowed a phone header — the date, the job
    // count and the collapse triangle were pushed off the right edge. The most
    // urgent one shows; the rest become "+N".
    const badge = readFileSync(
      join(REPO_ROOT, "apps/web/src/ui/components/WeatherAlertBadge.tsx"), "utf8",
    );
    const compact = badge.slice(badge.indexOf('if (density === "compact")'));
    const block = compact.slice(0, compact.indexOf("\n  }\n"));
    // One chip, derived from topAlert — NOT a map over the array.
    expect(block).toMatch(/const lead = topAlert\(alerts, today\)!/);
    expect(block, "the compact chip must not render one element per alert")
      .not.toMatch(/\.map\(/);
    expect(block).toMatch(/const extra = alerts\.length - 1;/);
    expect(block).toMatch(/\+\{extra\}/);
  });

  it("expanding shows EVERY advisory for that day, not just the named one", () => {
    // The chip collapses the rest into "+N", so the expanded panel is the only
    // place they can be read at all.
    expect(JOBS).toMatch(/const forDay = alertsForDate\(weatherAlerts, group\.key\)/);
    expect(JOBS).toMatch(/forDay\.some\(\(al\) => al\.id === openAlertId\)/);
    const badge = readFileSync(
      join(REPO_ROOT, "apps/web/src/ui/components/WeatherAlertBadge.tsx"), "utf8",
    );
    expect(badge).toMatch(/WeatherAlertDetail\(\{ alerts \}: \{ alerts: WeatherAlert\[\] \}\)/);
    expect(badge).toMatch(/ordered\.map\(\(alert\)/);
  });

  it("heat is red, never the orange the unconfirmed chip already uses", () => {
    const lib = readFileSync(join(REPO_ROOT, "apps/web/src/lib/weatherAlerts.ts"), "utf8");
    expect(lib).toMatch(/if \(a\.kind === "heat"\) return "red";/);
  });

  it("advisory chips are filled, not a pale wash", () => {
    const badge = readFileSync(
      join(REPO_ROOT, "apps/web/src/ui/components/WeatherAlertBadge.tsx"), "utf8",
    );
    expect(badge).toMatch(/bg=\{`\$\{tone\}\.solid`\}/);
    // Solid yellow with white text is unreadable.
    expect(badge).toMatch(/tone === "yellow" \? "black" : "white"/);
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
