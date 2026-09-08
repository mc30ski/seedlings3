// Route precedence around `GET /admin/business-expenses/:id`.
//
// The Ledger already exposes several GET siblings under the same prefix —
// /summary, /vs-revenue, /due-soon, /pnl-report, /match-recurring. Adding a
// parametric `:id` route beside them raises the obvious question: does
// /summary now resolve to the detail handler with id="summary"?
//
// find-my-way (Fastify's router) ranks a STATIC segment above a parametric one
// at the same position, so it does not. But "the router documents this" is not
// the same as "this application's routes are registered in a way that gets the
// documented behaviour" — registration order, prefixes and plugin scoping can
// all interfere. So this asserts it against a real Fastify instance with the
// same shapes, rather than trusting the docs.
//
// Every route in the real app is auth-guarded, so hitting the live server
// returns 401 for both and proves nothing. These handlers are unguarded and
// return their own name.

import { describe, it, expect } from "vitest";
import Fastify from "fastify";

function buildApp() {
  const app = Fastify();
  // Registered in the SAME ORDER as routes/admin.ts: the parametric detail
  // route sits between the list and the static siblings, which is the
  // arrangement most likely to shadow something if precedence were positional.
  app.get("/admin/business-expenses", async () => ({ route: "list" }));
  app.get("/admin/business-expenses/:id", async (req: any) => ({
    route: "detail",
    id: req.params.id,
  }));
  app.get("/admin/business-expenses/match-recurring", async () => ({ route: "match-recurring" }));
  app.get("/admin/business-expenses/vs-revenue", async () => ({ route: "vs-revenue" }));
  app.get("/admin/business-expenses/summary", async () => ({ route: "summary" }));
  app.get("/admin/business-expenses/pnl-report", async () => ({ route: "pnl-report" }));
  app.get("/admin/business-expenses/due-soon", async () => ({ route: "due-soon" }));
  return app;
}

describe("[build-gate] the ledger detail route shadows none of its siblings", () => {
  const STATIC_SIBLINGS = [
    "match-recurring",
    "vs-revenue",
    "summary",
    "pnl-report",
    "due-soon",
  ];

  it("every static sibling still reaches its own handler", async () => {
    const app = buildApp();
    for (const name of STATIC_SIBLINGS) {
      const res = await app.inject({ method: "GET", url: `/admin/business-expenses/${name}` });
      expect(res.statusCode).toBe(200);
      expect(
        res.json().route,
        `/${name} was swallowed by the :id route — it would 404 as a missing ledger entry`,
      ).toBe(name);
    }
    await app.close();
  });

  it("a real id still reaches the detail handler", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/admin/business-expenses/cmnlahl4y000lkv04zsuwy0rz",
    });
    expect(res.json()).toEqual({ route: "detail", id: "cmnlahl4y000lkv04zsuwy0rz" });
    await app.close();
  });

  it("the list route is untouched", async () => {
    const app = buildApp();
    const res = await app.inject({ method: "GET", url: "/admin/business-expenses" });
    expect(res.json().route).toBe("list");
    await app.close();
  });
});
