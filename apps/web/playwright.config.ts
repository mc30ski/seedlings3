import { defineConfig, devices } from "@playwright/test";
import path from "path";
import dotenv from "dotenv";

// Load Clerk keys from the web + api envs so tests have both the publishable
// (client) and secret (backend) keys. `.env.test.local` overrides for e2e.
dotenv.config({ path: path.resolve(__dirname, ".env.local") });
dotenv.config({ path: path.resolve(__dirname, "../api/.env") });
dotenv.config({ path: path.resolve(__dirname, ".env.test.local"), override: true });

if (!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY) {
  throw new Error("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY missing — .env.local not loaded");
}
if (!process.env.CLERK_SECRET_KEY) {
  throw new Error("CLERK_SECRET_KEY missing — apps/api/.env not loaded");
}

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [
    ["list"],
    ["html", { outputFolder: "./tests/e2e/report", open: "never" }],
    ["json", { outputFile: "./tests/e2e/report/results.json" }],
  ],
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  projects: [
    {
      name: "auth-setup",
      testMatch: /auth\/.*\.setup\.ts$/,
    },
    {
      // BACKEND API COVERAGE — not a browser-behaviour project.
      //
      // These specs drive the API over HTTP as real signed-in personas and
      // assert authorization and response shape for every endpoint the
      // backend declares. They live in `tests/e2e/api/` rather than
      // `tests/e2e/specs/` so the five UI projects (whose testMatch is
      // anchored on `specs/`) never pick them up, and so one project owns
      // the whole API surface.
      //
      // The timeout is raised because a single test here covers every route
      // guarded by one entitlement — up to ~50 routes, two requests each —
      // and grouping them that way is what makes a failure say "money.approve
      // is broken" instead of naming one URL out of 639.
      name: "api",
      dependencies: ["auth-setup"],
      testMatch: /api\/.*\.spec\.ts$/,
      timeout: 240_000,
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1280, height: 900 },
      },
    },
    {
      // THE READ-ONLY PERSONA SWEEP. One project rather than one per
      // persona: `storageState` is set per describe-block inside the spec,
      // so adding a tenth persona is a line in `PERSONAS`, not a project.
      //
      // Long timeout because a single test walks every tab one persona can
      // reach — twenty-odd page loads — and grouping it that way is what
      // makes a failure say "bookkeeper is stranded" rather than naming one
      // URL.
      // MUTATION ROUND. One persona per run (MUTATION_PERSONA), with the
      // database reseeded between them by scripts/mutation-round.sh —
      // these tests write real rows, and without a reset each persona
      // would act on what the last one changed.
      name: "persona-mutations",
      dependencies: ["auth-setup"],
      testMatch: /mutations\/.*\.spec\.ts$/,
      timeout: 300_000,
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1280, height: 900 },
      },
    },
    {
      name: "persona-sweep",
      dependencies: ["auth-setup"],
      testMatch: /sweep\/.*\.spec\.ts$/,
      // Super walks 36 tabs, each a navigation that waits to confirm it
      // arrived. Five minutes was not enough and both admin and super
      // timed out — a harness failure that reads exactly like an app
      // failure, which is the worst kind to report.
      timeout: 900_000,
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1280, height: 900 },
      },
    },
    {
      name: "employee",
      dependencies: ["auth-setup"],
      // THE EMPLOYEE ACCOUNT — a W-2 worker with field clearance and no
      // management authority. Projects are named for the account that
      // signs in. They were `employee` / `admin-role` / `super`, and that
      // last pair was actively misleading: a spec suffixed `-admin` ran
      // under the `super` project, so "admin" in a filename named a
      // different account than the one executing it.
      //
      // Specs belonging to the other two accounts carry their own filename
      // token; exclude them so this one never loads a page it cannot reach.
      testMatch: /specs\/(?!.*-owner(?:-|\.)|mobile-|scheduler-).*\.spec\.ts$/,
      use: {
        ...devices["Desktop Chrome"],
        storageState: "./playwright/.auth/employee.json",
        viewport: { width: 1280, height: 900 },
      },
    },
    {
      name: "employee-mobile",
      dependencies: ["auth-setup"],
      testMatch: /specs\/mobile-.*\.spec\.ts$/,
      use: {
        ...devices["iPhone 13"],
        storageState: "./playwright/.auth/employee.json",
      },
    },
    {
      // RUNS THE SCHEDULE, DOES NOT RUN THE BUSINESS. The `owner` project
      // cannot stand in for this: that account holds a superset, so a
      // restriction only this one feels is invisible from it.
      // Prefix convention mirrors `mobile-`.
      name: "scheduler",
      dependencies: ["auth-setup"],
      testMatch: /specs\/scheduler-.*\.spec\.ts$/,
      use: {
        ...devices["Desktop Chrome"],
        storageState: "./playwright/.auth/scheduler.json",
        viewport: { width: 1280, height: 900 },
      },
    },
    {
      // THE OWNER ACCOUNT — holds everything, so it runs the specs needing
      // the widest access. The token is `-owner`; it was `-admin`, which
      // named a different account than the one that actually ran. The
      // `(?:-|\.)` matches either a further hyphen (multi-word suffix) or
      // the terminal `.spec.ts`.
      name: "owner",
      dependencies: ["auth-setup"],
      testMatch: /specs\/.*-owner(?:-.*)?\.spec\.ts$/,
      use: {
        ...devices["Desktop Chrome"],
        storageState: "./playwright/.auth/owner.json",
        viewport: { width: 1280, height: 900 },
      },
    },
  ],
});
