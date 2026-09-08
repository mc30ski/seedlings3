import { describe, it, expect } from "vitest";
import {
  resolveHoursBaseline,
  isUsableEvidence,
  median,
  BASELINE_MIN_SAMPLES,
  BASELINE_WINDOW,
  EVIDENCE_MAX_MINUTES,
} from "./hoursBaseline";

describe("resolveHoursBaseline", () => {
  it("uses the estimate until there is enough history", () => {
    for (let n = 0; n < BASELINE_MIN_SAMPLES; n++) {
      const prior = Array.from({ length: n }, () => 90);
      const b = resolveHoursBaseline({ estimatedMinutes: 60, priorPersonMinutes: prior });
      expect(b, `with ${n} prior visits`).toEqual({
        personMinutes: 60,
        source: "ESTIMATE",
        sampleCount: 0,
      });
    }
  });

  it("switches to the job's own median at exactly three visits", () => {
    // Three visits that really took 90 person-minutes against a 60 estimate:
    // the estimate stops being the yardstick.
    const b = resolveHoursBaseline({ estimatedMinutes: 60, priorPersonMinutes: [90, 90, 90] });
    expect(b).toEqual({ personMinutes: 90, source: "ROLLING_ACTUAL", sampleCount: 3 });
  });

  it("takes the MEDIAN, so one bad visit does not move the baseline", () => {
    // A forgotten clock in the middle of otherwise consistent work.
    const b = resolveHoursBaseline({
      estimatedMinutes: 60,
      priorPersonMinutes: [58, 62, 60, 470, 59],
    });
    expect(b?.personMinutes).toBe(60);
  });

  it("ignores impossible and implausible visits entirely", () => {
    // Negative spans (timestamps edited into the wrong order) and clocks left
    // running are not evidence of anything.
    expect(isUsableEvidence(-5)).toBe(false);
    expect(isUsableEvidence(0)).toBe(false);
    expect(isUsableEvidence(EVIDENCE_MAX_MINUTES)).toBe(true);
    expect(isUsableEvidence(EVIDENCE_MAX_MINUTES + 1)).toBe(false);
    expect(isUsableEvidence(NaN)).toBe(false);
  });

  it("falls back to the estimate when the only history is unusable", () => {
    // Production's 736-minute row on a 45-minute job. Three of those must not
    // become a 736-minute 'normal'.
    const b = resolveHoursBaseline({
      estimatedMinutes: 45,
      priorPersonMinutes: [736, 900, -20],
    });
    expect(b).toEqual({ personMinutes: 45, source: "ESTIMATE", sampleCount: 0 });
  });

  it("counts usable visits, not raw ones, toward the threshold", () => {
    // Two good visits and two junk ones is NOT enough history.
    const b = resolveHoursBaseline({
      estimatedMinutes: 60,
      priorPersonMinutes: [90, 90, 999, -3],
    });
    expect(b?.source).toBe("ESTIMATE");
  });

  it("only looks at the recent window, so a job may change pace", () => {
    // Newest first: the last 8 all say ~30. Older history said 200 and must
    // not drag the baseline up.
    const prior = [30, 30, 30, 30, 30, 30, 30, 30, 200, 200, 200];
    const b = resolveHoursBaseline({ estimatedMinutes: 60, priorPersonMinutes: prior });
    expect(b?.personMinutes).toBe(30);
    expect(b?.sampleCount).toBe(BASELINE_WINDOW);
  });

  it("returns null when there is neither history nor an estimate", () => {
    expect(resolveHoursBaseline({ estimatedMinutes: null, priorPersonMinutes: [] })).toBeNull();
    expect(resolveHoursBaseline({ estimatedMinutes: 0, priorPersonMinutes: [] })).toBeNull();
  });

  it("a zero median is treated as no evidence, not as a divide-by-zero", () => {
    // Cannot arise today (zero is unusable), but the guard is what stops a
    // future change from making every variance infinite.
    expect(median([0, 0, 0])).toBe(0);
    const b = resolveHoursBaseline({ estimatedMinutes: 60, priorPersonMinutes: [0, 0, 0] });
    expect(b?.source).toBe("ESTIMATE");
  });

  it("median averages the middle pair on even counts", () => {
    expect(median([10, 20, 30, 40])).toBe(25);
    expect(median([10, 20, 30])).toBe(20);
  });

  it("PERSON-MINUTES ON BOTH SIDES — a crewed job is not judged as half-length", () => {
    // A two-person visit that took 30 minutes of wall-clock is 60
    // person-minutes, and compares directly against a 60-minute estimate.
    // The caller multiplies wall-clock by crew before it gets here; this
    // pins the unit so the two can never be mixed.
    const b = resolveHoursBaseline({ estimatedMinutes: 60, priorPersonMinutes: [60, 60, 60] });
    expect(b?.personMinutes).toBe(60);
  });
});
