import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import { scrubNulDeep, scrubNulInPlace } from "./scrubNulBytes";

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
