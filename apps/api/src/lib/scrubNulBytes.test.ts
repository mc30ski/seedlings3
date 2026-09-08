import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { scrubNul, scrubNulDeep } from "./scrubNulBytes";

// The exact character Postgres refuses: "invalid byte sequence for encoding
// UTF8: 0x00". Written as an escape so this file never itself contains a NUL.
const NUL = "\u0000";

describe("scrubNul", () => {
  it("removes the byte Postgres rejects", () => {
    expect(scrubNul(`M5BMQUG3${NUL}0013`)).toBe("M5BMQUG30013");
    expect(scrubNul(`${NUL}${NUL}Clerk, Inc.${NUL}`)).toBe("Clerk, Inc.");
  });

  it("leaves every other character alone", () => {
    // Tab and newline are legal in a text column and often meaningful — a
    // scrub that ate them would silently damage notes to fix a NUL problem.
    const s = "line one\nline two\tindented — em dash, café, 日本語, 🌱";
    expect(scrubNul(s)).toBe(s);
  });

  it("returns the same string when there is nothing to do", () => {
    const s = "nothing to scrub";
    expect(scrubNul(s)).toBe(s);
  });
});

describe("scrubNulDeep", () => {
  it("scrubs the shape the Ledger form actually posts", () => {
    const body = {
      type: "EXPENSE",
      description: `Clerk sub${NUL}scription`,
      cost: 25,
      vendor: `Clerk, Inc.${NUL}`,
      invoiceNumber: `M5BMQUG3${NUL}0013`,
      paymentFrom: "Chase business card (Mike)",
      notes: null,
      recurrence: "MONTHLY",
    };
    expect(scrubNulDeep(body)).toEqual({
      ...body,
      description: "Clerk subscription",
      vendor: "Clerk, Inc.",
      invoiceNumber: "M5BMQUG30013",
    });
  });

  it("walks arrays and nesting", () => {
    const out = scrubNulDeep({
      rows: [{ desc: `a${NUL}b` }, { desc: "clean" }],
      deep: { deeper: { deepest: [`x${NUL}`] } },
    });
    expect(out.rows[0].desc).toBe("ab");
    expect(out.deep.deeper.deepest[0]).toBe("x");
  });

  it("preserves non-string leaves exactly", () => {
    const body = { n: 1, b: true, z: null, u: undefined, f: 1.5 };
    expect(scrubNulDeep(body)).toEqual(body);
  });

  it("returns the SAME object when nothing changed", () => {
    // The overwhelmingly common request must allocate nothing.
    const body = { a: "clean", b: [1, 2], c: { d: "also clean" } };
    expect(scrubNulDeep(body)).toBe(body);
  });

  it("does not rebuild a Date or a Buffer", () => {
    // A Buffer legitimately contains 0x00 and is not headed for a text
    // column; rebuilding either as a plain object destroys it.
    const d = new Date("2026-09-07T00:00:00Z");
    const buf = Buffer.from([0, 1, 2]);
    const out = scrubNulDeep({ d, buf, s: `x${NUL}` });
    expect(out.d).toBe(d);
    expect(out.buf).toBe(buf);
    expect(out.buf.length).toBe(3);
    expect(out.s).toBe("x");
  });

  it("survives a hostile depth without blowing the stack", () => {
    let deep: any = `x${NUL}`;
    for (let i = 0; i < 200; i++) deep = { deep };
    expect(() => scrubNulDeep(deep)).not.toThrow();
  });

  it("handles a null-prototype object", () => {
    const o = Object.create(null);
    o.s = `a${NUL}b`;
    expect(scrubNulDeep(o).s).toBe("ab");
  });
});

describe("[build-gate] the scrub is wired at the boundary", () => {
  const ROUTES = readFileSync(join(__dirname, "../routes.ts"), "utf8");

  it("runs on every request, not at individual call sites", () => {
    // Thirty routes writing text cannot each be trusted to remember. The hook
    // is the reason no future one has to.
    expect(ROUTES).toMatch(/app\.addHook\("preValidation"/);
    expect(ROUTES).toMatch(/req\.body = scrubNulDeep\(req\.body\)/);
    // IN PLACE for the query — `request.query` is a getter and assigning to
    // it does nothing. The unit tests here were green while the hook's query
    // leg was inert; only an inject-level test found it.
    expect(ROUTES).toMatch(/scrubNulInPlace\(req\.query\)/);
    expect(ROUTES, "assigning to req.query is a silent no-op")
      .not.toMatch(/req\.query = /);
  });

  it("no source file contains a literal NUL", () => {
    // Belt and braces: a NUL pasted into the codebase itself would be
    // invisible in review.
    const src = readFileSync(join(__dirname, "./scrubNulBytes.ts"), "utf8");
    expect(src.includes("\u0000")).toBe(false);
  });
});
