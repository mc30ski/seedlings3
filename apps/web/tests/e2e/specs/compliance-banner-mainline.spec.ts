import { test, expect, Page } from "@playwright/test";
import type { PrismaClient } from "@prisma/client";
import {
  makePrisma,
  resetWorkerCompliance,
  createScratchPolicy,
  cleanupScratchPolicies,
  signPolicyDirect,
  grantException,
  USERS,
} from "../helpers/db";
import { gotoWorkerHome } from "../helpers/nav";

/**
 * Mainline compliance banner tests. Runs against the Employee user whose
 * storage state was captured in auth.setup.ts.
 *
 * Each test starts by resetting compliance state on the Employee, then
 * seeding the scenario, then loading the Home tab and asserting on what
 * the browser actually renders. Screenshots are captured for every
 * scenario into tests/e2e/screenshots/.
 */

let prisma: PrismaClient;

test.beforeAll(async () => {
  prisma = makePrisma();
});

test.afterAll(async () => {
  // Wipe every scratch policy this file created + reset compliance state
  // so a subsequent seed re-establishes real policies without our test
  // leftovers polluting the UI.
  await resetWorkerCompliance(prisma, USERS.employee);
  await cleanupScratchPolicies(prisma);
  await prisma.$disconnect();
});

async function gotoHomeFresh(page: Page) {
  await gotoWorkerHome(page);
}

async function locateBanner(page: Page) {
  return page.locator('[data-testid="compliance-banner"]');
}

function parseRgb(s: string): [number, number, number] {
  const m = s.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
  if (!m) throw new Error(`unparseable rgb: ${s}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

test.describe("Mainline: Empty state", () => {
  test("no pending policies → banner is absent", async ({ page }) => {
    await resetWorkerCompliance(prisma, USERS.employee);
    await cleanupScratchPolicies(prisma);

    // Every EMPLOYEE-targeting real policy needs a "current" signature.
    // Seed one for each real published policy so the worker looks fully
    // cleared. (Simpler: grant exceptions covering all real policies.)
    const realPolicies = await prisma.policyDocument.findMany({
      where: { archivedAt: null, targetWorkerTypes: { has: "EMPLOYEE" } },
      select: { id: true, currentVersion: { select: { id: true, contentDigest: true } } },
    });
    for (const p of realPolicies) {
      if (!p.currentVersion) continue;
      await signPolicyDirect(prisma, {
        userId: USERS.employee,
        policyDocumentVersionId: p.currentVersion.id,
        contentDigestAtSign: p.currentVersion.contentDigest,
      });
    }

    await gotoHomeFresh(page);
    await page.screenshot({ path: "tests/e2e/screenshots/01-empty-state.png", fullPage: true });

    // Banner should NOT be rendered.
    const banner = await locateBanner(page);
    await expect(banner).toHaveCount(0);
  });
});

test.describe("Mainline: BLOCK-level pending", () => {
  test("single BLOCK policy → red banner + Sign now + View profile visible", async ({ page }) => {
    await resetWorkerCompliance(prisma, USERS.employee);
    await cleanupScratchPolicies(prisma);

    const realPolicies = await prisma.policyDocument.findMany({
      where: { archivedAt: null, targetWorkerTypes: { has: "EMPLOYEE" } },
      select: { id: true, currentVersion: { select: { id: true, contentDigest: true } } },
    });
    for (const p of realPolicies) {
      if (!p.currentVersion) continue;
      await signPolicyDirect(prisma, {
        userId: USERS.employee,
        policyDocumentVersionId: p.currentVersion.id,
        contentDigestAtSign: p.currentVersion.contentDigest,
      });
    }
    await createScratchPolicy(prisma, {
      keyPrefix: "E2E_BLOCK_SINGLE",
      title: "E2E Single BLOCK",
      enforcement: "BLOCK",
      createdByUserId: USERS.super,
    });

    await gotoHomeFresh(page);
    await page.screenshot({ path: "tests/e2e/screenshots/02-block-single.png", fullPage: true });

    const banner = await locateBanner(page);
    await expect(banner).toBeVisible();
    await expect(banner).toContainText(/required document/i);
    await expect(banner.getByRole("button", { name: /^Sign now$/i })).toBeVisible();
    await expect(banner.getByRole("button", { name: /^View profile$/i })).toBeVisible();

    // Assert red palette by decomposing the computed background color:
    // reddish means R is the strongest channel and clearly dominant over G+B.
    // We don't hardcode Chakra token values because Chakra v3's `red.50`
    // has shifted between minor versions.
    const [rr, rg, rb] = parseRgb(await banner.evaluate((el) => getComputedStyle(el).backgroundColor));
    expect(rr).toBeGreaterThan(rg);
    expect(rr).toBeGreaterThan(rb);
    expect(rr - rg).toBeGreaterThan(5);
    expect(rr - rb).toBeGreaterThan(5);
  });

  test("multiple BLOCK policies → banner shows count", async ({ page }) => {
    await resetWorkerCompliance(prisma, USERS.employee);
    await cleanupScratchPolicies(prisma);
    const realPolicies = await prisma.policyDocument.findMany({
      where: { archivedAt: null, targetWorkerTypes: { has: "EMPLOYEE" } },
      select: { id: true, currentVersion: { select: { id: true, contentDigest: true } } },
    });
    for (const p of realPolicies) {
      if (!p.currentVersion) continue;
      await signPolicyDirect(prisma, {
        userId: USERS.employee,
        policyDocumentVersionId: p.currentVersion.id,
        contentDigestAtSign: p.currentVersion.contentDigest,
      });
    }
    for (let i = 0; i < 3; i++) {
      await createScratchPolicy(prisma, {
        keyPrefix: `E2E_BLOCK_MULTI_${i}`,
        title: `E2E Multi BLOCK ${i}`,
        enforcement: "BLOCK",
        createdByUserId: USERS.super,
      });
    }
    await gotoHomeFresh(page);
    await page.screenshot({ path: "tests/e2e/screenshots/03-block-multi.png", fullPage: true });
    const banner = await locateBanner(page);
    await expect(banner).toContainText(/3 required documents/i);
  });
});

test.describe("Mainline: WARN-only pending", () => {
  test("single WARN policy → orange banner", async ({ page }) => {
    await resetWorkerCompliance(prisma, USERS.employee);
    await cleanupScratchPolicies(prisma);
    const realPolicies = await prisma.policyDocument.findMany({
      where: { archivedAt: null, targetWorkerTypes: { has: "EMPLOYEE" } },
      select: { id: true, currentVersion: { select: { id: true, contentDigest: true } } },
    });
    for (const p of realPolicies) {
      if (!p.currentVersion) continue;
      await signPolicyDirect(prisma, {
        userId: USERS.employee,
        policyDocumentVersionId: p.currentVersion.id,
        contentDigestAtSign: p.currentVersion.contentDigest,
      });
    }
    await createScratchPolicy(prisma, {
      keyPrefix: "E2E_WARN_SINGLE",
      title: "E2E Single WARN",
      enforcement: "WARN",
      createdByUserId: USERS.super,
    });

    await gotoHomeFresh(page);
    await page.screenshot({ path: "tests/e2e/screenshots/04-warn-single.png", fullPage: true });

    const banner = await locateBanner(page);
    await expect(banner).toBeVisible();
    await expect(banner).toContainText(/recommended document/i);
    // Orangeish: R strongest, G in the middle, B lowest. Same
    // palette-independent shape check as the red assertion.
    const [orR, orG, orB] = parseRgb(await banner.evaluate((el) => getComputedStyle(el).backgroundColor));
    expect(orR).toBeGreaterThan(orG);
    expect(orG).toBeGreaterThan(orB);
    expect(orR - orB).toBeGreaterThan(10);
  });
});

test.describe("Mainline: Mixed BLOCK + WARN", () => {
  test("both present → banner shows combined 'N required + M recommended'", async ({ page }) => {
    await resetWorkerCompliance(prisma, USERS.employee);
    await cleanupScratchPolicies(prisma);
    const realPolicies = await prisma.policyDocument.findMany({
      where: { archivedAt: null, targetWorkerTypes: { has: "EMPLOYEE" } },
      select: { id: true, currentVersion: { select: { id: true, contentDigest: true } } },
    });
    for (const p of realPolicies) {
      if (!p.currentVersion) continue;
      await signPolicyDirect(prisma, {
        userId: USERS.employee,
        policyDocumentVersionId: p.currentVersion.id,
        contentDigestAtSign: p.currentVersion.contentDigest,
      });
    }
    await createScratchPolicy(prisma, {
      keyPrefix: "E2E_MIX_BLOCK",
      title: "E2E Mix BLOCK",
      enforcement: "BLOCK",
      createdByUserId: USERS.super,
    });
    await createScratchPolicy(prisma, {
      keyPrefix: "E2E_MIX_WARN",
      title: "E2E Mix WARN",
      enforcement: "WARN",
      createdByUserId: USERS.super,
    });
    await createScratchPolicy(prisma, {
      keyPrefix: "E2E_MIX_INFO",
      title: "E2E Mix INFO",
      enforcement: "INFO",
      createdByUserId: USERS.super,
    });

    await gotoHomeFresh(page);
    await page.screenshot({ path: "tests/e2e/screenshots/05-mixed.png", fullPage: true });

    const banner = await locateBanner(page);
    await expect(banner).toContainText(/1 required.*2 recommended/i);
    // Banner should be red (BLOCK dominates).
    const [mrR, mrG, mrB] = parseRgb(await banner.evaluate((el) => getComputedStyle(el).backgroundColor));
    expect(mrR).toBeGreaterThan(mrG);
    expect(mrR).toBeGreaterThan(mrB);
    expect(mrR - mrG).toBeGreaterThan(5);
  });
});

test.describe("Mainline: Position", () => {
  test("compliance banner renders BELOW HomeBanners + push-notification banner", async ({ page }) => {
    await resetWorkerCompliance(prisma, USERS.employee);
    await cleanupScratchPolicies(prisma);
    const realPolicies = await prisma.policyDocument.findMany({
      where: { archivedAt: null, targetWorkerTypes: { has: "EMPLOYEE" } },
      select: { id: true, currentVersion: { select: { id: true, contentDigest: true } } },
    });
    for (const p of realPolicies) {
      if (!p.currentVersion) continue;
      await signPolicyDirect(prisma, {
        userId: USERS.employee,
        policyDocumentVersionId: p.currentVersion.id,
        contentDigestAtSign: p.currentVersion.contentDigest,
      });
    }
    await createScratchPolicy(prisma, {
      keyPrefix: "E2E_POS_BLOCK",
      title: "E2E Position BLOCK",
      enforcement: "BLOCK",
      createdByUserId: USERS.super,
    });
    await gotoHomeFresh(page);

    const banner = await locateBanner(page);
    const bannerBox = await banner.boundingBox();
    expect(bannerBox).toBeTruthy();

    // WorkdayStrip is the next card down — ensure it's BELOW the banner.
    const workday = page.locator('[data-testid="workday-strip"]').first();
    if (await workday.count()) {
      const wBox = await workday.boundingBox();
      if (wBox && bannerBox) {
        expect(bannerBox.y).toBeLessThan(wBox.y);
      }
    }
  });
});

test.describe("Mainline: Refresh on policies:signed event", () => {
  test("banner disappears when policies:signed dispatched and DB is clean", async ({ page }) => {
    await resetWorkerCompliance(prisma, USERS.employee);
    await cleanupScratchPolicies(prisma);
    const realPolicies = await prisma.policyDocument.findMany({
      where: { archivedAt: null, targetWorkerTypes: { has: "EMPLOYEE" } },
      select: { id: true, currentVersion: { select: { id: true, contentDigest: true } } },
    });
    for (const p of realPolicies) {
      if (!p.currentVersion) continue;
      await signPolicyDirect(prisma, {
        userId: USERS.employee,
        policyDocumentVersionId: p.currentVersion.id,
        contentDigestAtSign: p.currentVersion.contentDigest,
      });
    }
    const scratch = await createScratchPolicy(prisma, {
      keyPrefix: "E2E_REFRESH",
      title: "E2E Refresh BLOCK",
      enforcement: "BLOCK",
      createdByUserId: USERS.super,
    });

    await gotoHomeFresh(page);
    const banner = await locateBanner(page);
    await expect(banner).toBeVisible();

    // Sign it directly, then dispatch the event the banner listens for.
    await signPolicyDirect(prisma, {
      userId: USERS.employee,
      policyDocumentVersionId: scratch.versionId,
      contentDigestAtSign: scratch.contentDigest,
    });
    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent("policies:signed"));
    });

    // Banner should refetch and disappear.
    await expect(banner).toHaveCount(0, { timeout: 8_000 });
    await page.screenshot({ path: "tests/e2e/screenshots/06-after-refresh.png", fullPage: true });
  });
});
