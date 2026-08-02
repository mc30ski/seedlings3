import { describe, expect, it, vi } from "vitest";
import {
  RECEIPT_NUMBER_PATTERN,
  legacyReceiptNumberFor,
  makeReceiptNumber,
  normalizeReceiptNumber,
  generateReceiptNumber,
} from "./receiptNumber";

describe("makeReceiptNumber", () => {
  it("emits an SL- prefix followed by exactly 8 characters", () => {
    const rn = makeReceiptNumber();
    expect(rn).toMatch(/^SL-.{8}$/);
  });

  it("emits only Crockford base-32 characters (no I/L/O/U)", () => {
    // 200 samples is plenty — a violation is either "always" or "never"
    // given the alphabet mask is a static bitwise-AND. This is a
    // GENERATOR contract, not a validation contract: the lookup regex
    // accepts a wider alphabet to also match backfilled legacy values.
    for (let i = 0; i < 200; i++) {
      const rn = makeReceiptNumber();
      const core = rn.slice(3);
      expect(core).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
      expect(core).not.toMatch(/[ILOU]/);
    }
  });

  it("produces varied output — same value twice in a row would signal a broken RNG", () => {
    const first = makeReceiptNumber();
    const second = makeReceiptNumber();
    expect(first).not.toBe(second);
  });
});

describe("normalizeReceiptNumber", () => {
  it("accepts canonical uppercase SL-XXXXXXXX and returns it verbatim", () => {
    expect(normalizeReceiptNumber("SL-X8K3M2P1")).toBe("SL-X8K3M2P1");
  });

  it("uppercases lowercase input", () => {
    expect(normalizeReceiptNumber("sl-x8k3m2p1")).toBe("SL-X8K3M2P1");
  });

  it("adds the SL- prefix when the bare 8-char core is supplied", () => {
    expect(normalizeReceiptNumber("X8K3M2P1")).toBe("SL-X8K3M2P1");
    expect(normalizeReceiptNumber("x8k3m2p1")).toBe("SL-X8K3M2P1");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeReceiptNumber("  SL-X8K3M2P1  ")).toBe("SL-X8K3M2P1");
    expect(normalizeReceiptNumber("\tX8K3M2P1\n")).toBe("SL-X8K3M2P1");
  });

  it("rejects wrong-length input", () => {
    expect(normalizeReceiptNumber("SL-X8K3M2P")).toBeNull();   // 7 core chars
    expect(normalizeReceiptNumber("SL-X8K3M2P12")).toBeNull(); // 9 core chars
    expect(normalizeReceiptNumber("")).toBeNull();
  });

  it("accepts I/L/O/U — required for legacy backfilled values", () => {
    // The generator won't emit these, but backfilled rows use the
    // raw cuid tail which can contain them. See real dev data
    // example: SL-L8ONNIWY, SL-FIX0VT65.
    expect(normalizeReceiptNumber("SL-L8ONNIWY")).toBe("SL-L8ONNIWY");
    expect(normalizeReceiptNumber("SL-FIX0VT65")).toBe("SL-FIX0VT65");
    expect(normalizeReceiptNumber("SL-DIA8K53U")).toBe("SL-DIA8K53U");
  });

  it("accepts the -N collision suffix", () => {
    expect(normalizeReceiptNumber("SL-X8K3M2P1-2")).toBe("SL-X8K3M2P1-2");
    expect(normalizeReceiptNumber("x8k3m2p1-3")).toBe("SL-X8K3M2P1-3");
  });

  it("rejects non-alphanumeric junk inside the core", () => {
    expect(normalizeReceiptNumber("SL-X8K3.2P1")).toBeNull();
    expect(normalizeReceiptNumber("SL-X8K3 2P1")).toBeNull();
    expect(normalizeReceiptNumber("SL-X8K3_2P1")).toBeNull();
  });

  it("rejects a wrong prefix", () => {
    expect(normalizeReceiptNumber("SR-X8K3M2P1")).toBeNull();
    expect(normalizeReceiptNumber("XX-X8K3M2P1")).toBeNull();
    expect(normalizeReceiptNumber("SL_X8K3M2P1")).toBeNull(); // underscore not hyphen
  });
});

describe("legacyReceiptNumberFor", () => {
  it("produces SL-<last-8-uppercase> matching the pre-migration derivation", () => {
    // "cmexiwrfs003kvdysrjteo2hy" — a real cuid shape; last 8 chars = "rjteo2hy"
    expect(legacyReceiptNumberFor("cmexiwrfs003kvdysrjteo2hy")).toBe("SL-RJTEO2HY");
  });

  it("is deterministic — same input always produces the same output", () => {
    const id = "cmsc3muox005mgnhc7n77znko";
    expect(legacyReceiptNumberFor(id)).toBe(legacyReceiptNumberFor(id));
  });

  it("legacy tails with I/L/O/U roundtrip through the lookup pattern", () => {
    // Real dev backfill example — cuid "cmsc3muox005mgnhc7n77znko" →
    // last 8 chars "7n77znko" → uppercase "7N77ZNKO". That contains
    // O and would fail a strict-alphabet check. The loose pattern
    // must accept it so the search endpoint can find it.
    const rn = legacyReceiptNumberFor("cmsc3muox005mgnhc7n77znko");
    expect(rn).toBe("SL-7N77ZNKO");
    expect(RECEIPT_NUMBER_PATTERN.test(rn)).toBe(true);
  });
});

describe("generateReceiptNumber", () => {
  it("returns a canonical SL- number when no collision is found", async () => {
    const tx = { payment: { findUnique: vi.fn().mockResolvedValue(null) } };
    const rn = await generateReceiptNumber(tx as any);
    expect(rn).toMatch(RECEIPT_NUMBER_PATTERN);
    expect(tx.payment.findUnique).toHaveBeenCalledOnce();
  });

  it("retries on collision and returns the first non-taken value", async () => {
    // Simulate: first candidate is taken, second is free.
    const findUnique = vi.fn()
      .mockResolvedValueOnce({ id: "existing" })
      .mockResolvedValueOnce(null);
    const tx = { payment: { findUnique } };
    const rn = await generateReceiptNumber(tx as any);
    expect(rn).toMatch(RECEIPT_NUMBER_PATTERN);
    expect(findUnique).toHaveBeenCalledTimes(2);
  });

  it("throws after exhausting maxAttempts — the RNG-broke sentinel path", async () => {
    // Every attempt returns "taken".
    const findUnique = vi.fn().mockResolvedValue({ id: "everything-collides" });
    const tx = { payment: { findUnique } };
    await expect(generateReceiptNumber(tx as any, 3)).rejects.toThrow(
      /exhausted 3 attempts/,
    );
    expect(findUnique).toHaveBeenCalledTimes(3);
  });
});
