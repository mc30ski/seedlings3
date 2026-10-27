import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import { scrubNulDeep, scrubNulInPlace } from "./scrubNulBytes";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const NUL = "\u0000";

// The unit tests above prove the function. This proves the WIRING: that
// `preValidation` runs before the handler, that `req.body` is assignable at
// that point, and that a query string is covered too. A scrub that is correct
// but never reached is the same as no scrub.
function buildApp() {
  const app = Fastify();
  app.addHook("preValidation", (req, _reply, done) => {
    if (req.body && typeof req.body === "object") req.body = scrubNulDeep(req.body);
    scrubNulInPlace(req.query);
    done();
  });
  app.post("/echo", async (req) => ({ body: req.body, query: req.query }));
  // A schema-validated route: preValidation must run BEFORE validation, or a
  // strict schema would reject the dirty value before we ever clean it.
  app.post(
    "/validated",
    {
      schema: {
        body: {
          type: "object",
          required: ["invoiceNumber"],
          properties: { invoiceNumber: { type: "string", pattern: "^[A-Z0-9]+$" } },
        },
      },
    },
    async (req) => ({ ok: true, body: req.body }),
  );
  return app;
}

describe("the NUL scrub, as actually wired", () => {
  it("a NUL pasted into a field never reaches the handler", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/echo",
      payload: {
        description: `Clerk sub${NUL}scription`,
        vendor: `Clerk, Inc.${NUL}`,
        invoiceNumber: `M5BMQUG3${NUL}0013`,
        notes: null,
        cost: 25,
      },
    });
    expect(res.statusCode).toBe(200);
    const got = res.json().body;
    expect(got.invoiceNumber).toBe("M5BMQUG30013");
    expect(got.vendor).toBe("Clerk, Inc.");
    expect(got.description).toBe("Clerk subscription");
    expect(got.cost).toBe(25);
    expect(JSON.stringify(got).includes(NUL)).toBe(false);
    await app.close();
  });

  it("runs before schema validation, not after", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/validated",
      payload: { invoiceNumber: `M5BMQUG3${NUL}0013` },
    });
    // Without the scrub the pattern fails and this is a 400.
    expect(res.statusCode).toBe(200);
    expect(res.json().body.invoiceNumber).toBe("M5BMQUG30013");
    await app.close();
  });

  it("covers the query string too", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: `/echo?q=mul${encodeURIComponent(NUL)}ch`,
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect((res.json().query as any).q).toBe("mulch");
    await app.close();
  });

  it("leaves a clean request untouched", async () => {
    const app = buildApp();
    const payload = { description: "Mulch", notes: "two\nlines\tand a tab" };
    const res = await app.inject({ method: "POST", url: "/echo", payload });
    expect(res.json().body).toEqual(payload);
    await app.close();
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe("no SOURCE file carries a literal NUL byte", () => {
  /**
   * The scrubber above keeps NUL out of REQUESTS. This keeps it out of the
   * repository, which is a different problem with a different cost.
   *
   * `services/payroll.ts` held a real NUL byte, typed directly into a
   * template string as a delimiter for an in-memory map key. It worked. But
   * one NUL byte makes a file BINARY as far as `grep` is concerned, and grep
   * answers nothing about a binary file — it does not warn, it just prints
   * no matches. 890 lines of payroll logic, including the visibility
   * projections the feature spec is built around, were invisible to every
   * grep-driven search in the repo.
   *
   * The second cost is latent: Postgres rejects NUL in text, which is why
   * the scrubber exists. A key built like that is one refactor away from a
   * column, and the failure arrives as a write error far from its cause.
   *
   * Write `\u0000` (or better, a delimiter that is not NUL at all) if the
   * value is genuinely needed.
   */
  const walk = (dir: string, out: string[] = []): string[] => {
    if (!existsSync(dir)) return out;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === ".next" || e.name === "dist") continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, out);
      else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
    }
    return out;
  };

  const ROOTS = [
    resolve(__dirname, ".."),
    resolve(__dirname, "../../../web/src"),
    resolve(__dirname, "../../../web/pages"),
  ];

  it("scans a meaningful number of files", () => {
    expect(ROOTS.flatMap((r) => walk(r)).length).toBeGreaterThan(200);
  });

  it("finds no literal NUL in any .ts/.tsx source", () => {
    const offenders: string[] = [];
    for (const file of ROOTS.flatMap((r) => walk(r))) {
      const buf = readFileSync(file);
      const at = buf.indexOf(0);
      if (at !== -1) offenders.push(`${file}: first NUL at byte ${at}`);
    }
    expect(
      offenders,
      "A literal NUL byte makes the file binary to grep, so every " +
        "grep-driven search silently skips it — and Postgres rejects NUL in " +
        "text, so the value is a latent write error. Use an escape.",
    ).toEqual([]);
  });
});
