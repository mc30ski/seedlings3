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

  it("caches, so every worker's poll does not become an NWS request", () => {
    expect(SERVICE).toMatch(/cache\.set\(/);
    expect(SERVICE).toMatch(/cacheMinutes/);
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
