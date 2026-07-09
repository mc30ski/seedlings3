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
      name: "employee",
      dependencies: ["auth-setup"],
      testMatch: /specs\/.*\.spec\.ts$/,
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
  ],
});
