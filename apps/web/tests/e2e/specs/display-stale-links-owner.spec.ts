import { test, expect, request as pwRequest } from "@playwright/test";
import { makePrisma } from "../helpers/db";
import { createHash } from "crypto";
import type { PrismaClient } from "@prisma/client";

/**
 * NO STALE LINKS.
 *
 * A wall display holds URLs for minutes at a time and re-renders them without
 * asking anyone. Every one of those references can go stale underneath it:
 * the screen gets revoked, a photo gets pulled down, a visit gets reopened so
 * its photos should no longer be public. None of that may leave a working
 * link behind.
 *
 * These are asserted against the live API rather than reasoned about, because
 * "the query filters on it" is exactly the kind of claim that stays true in
 * the payload while a DIRECT fetch of the old URL keeps working.
 */

const API = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8080";
const hash = (t: string) => createHash("sha256").update(t).digest("hex");

let prisma: PrismaClient;
test.beforeAll(() => { prisma = makePrisma(); });
test.afterAll(async () => { await prisma.$disconnect(); });

test.describe("Displays — no stale links", () => {
  test("revoking a screen kills its photo URLs, not just its board", async () => {
    const token = `stale-revoke-${Date.now()}`;
    const d = await prisma.display.create({
      data: { name: `E2E Stale ${Date.now()}`, mode: "PUBLIC", tokenHash: hash(token) },
    });
    const api = await pwRequest.newContext();
    try {
      const board = await api.get(`${API}/api/public/display/board?token=${token}`);
      expect(board.status()).toBe(200);
      const photos = (await board.json()).board?.photos ?? [];
      test.skip(photos.length === 0, "needs at least one photo on a finished visit");
      const photoUrl = `${API}${photos[0].url}?token=${token}`;

      expect((await api.get(photoUrl)).status(), "the photo loads while paired").toBe(200);

      await prisma.display.update({ where: { id: d.id }, data: { revokedAt: new Date() } });

      // The board going 401 is the obvious half. The IMAGE going 401 is the
      // half that would be easy to miss — a revoked screen must not keep
      // rendering client property photos from URLs it already holds.
      expect((await api.get(`${API}/api/public/display/board?token=${token}`)).status()).toBe(401);
      expect(
        (await api.get(photoUrl)).status(),
        "a revoked screen must not keep fetching photos it already has links to",
      ).toBe(401);
    } finally {
      await api.dispose();
      await prisma.display.delete({ where: { id: d.id } }).catch(() => {});
    }
  });

  test("hiding a photo publicly breaks the link a screen is already holding", async () => {
    const token = `stale-hide-${Date.now()}`;
    const d = await prisma.display.create({
      data: { name: `E2E Hide ${Date.now()}`, mode: "PUBLIC", tokenHash: hash(token) },
    });
    const api = await pwRequest.newContext();
    let photoId: string | null = null;
    try {
      const board = await api.get(`${API}/api/public/display/board?token=${token}`);
      const photos = (await board.json()).board?.photos ?? [];
      test.skip(photos.length === 0, "needs at least one photo on a finished visit");
      photoId = photos[0].id as string;
      const photoUrl = `${API}${photos[0].url}?token=${token}`;
      expect((await api.get(photoUrl)).status()).toBe(200);

      await prisma.jobOccurrencePhoto.update({
        where: { id: photoId },
        data: { hiddenFromPublicAt: new Date() },
      });

      expect(
        (await api.get(photoUrl)).status(),
        "a hidden photo must stop serving immediately, not at the next poll",
      ).toBe(404);

      const after = await api.get(`${API}/api/public/display/board?token=${token}`);
      const ids = ((await after.json()).board?.photos ?? []).map((p: any) => p.id);
      expect(ids, "and it must drop out of the next board payload").not.toContain(photoId);
    } finally {
      if (photoId) {
        await prisma.jobOccurrencePhoto
          .update({ where: { id: photoId }, data: { hiddenFromPublicAt: null } })
          .catch(() => {});
      }
      await api.dispose();
      await prisma.display.delete({ where: { id: d.id } }).catch(() => {});
    }
  });

  test("reopening a visit pulls its photos off the public wall", async () => {
    // The status filter is not decoration: a photo from a visit in progress
    // would tell a waiting client roughly where the crews are right now.
    const token = `stale-status-${Date.now()}`;
    const d = await prisma.display.create({
      data: { name: `E2E Status ${Date.now()}`, mode: "PUBLIC", tokenHash: hash(token) },
    });
    const api = await pwRequest.newContext();
    let occId: string | null = null;
    let prevStatus: string | null = null;
    try {
      const board = await api.get(`${API}/api/public/display/board?token=${token}`);
      const photos = (await board.json()).board?.photos ?? [];
      test.skip(photos.length === 0, "needs at least one photo on a finished visit");
      const photoUrl = `${API}${photos[0].url}?token=${token}`;

      const photo = await prisma.jobOccurrencePhoto.findUnique({
        where: { id: photos[0].id },
        select: { occurrenceId: true, occurrence: { select: { status: true } } },
      });
      occId = photo!.occurrenceId;
      prevStatus = photo!.occurrence.status;

      await prisma.jobOccurrence.update({ where: { id: occId }, data: { status: "IN_PROGRESS" } });

      expect(
        (await api.get(photoUrl)).status(),
        "a photo whose visit is no longer finished must stop serving",
      ).toBe(404);
    } finally {
      if (occId && prevStatus) {
        await prisma.jobOccurrence
          .update({ where: { id: occId }, data: { status: prevStatus as any } })
          .catch(() => {});
      }
      await api.dispose();
      await prisma.display.delete({ where: { id: d.id } }).catch(() => {});
    }
  });

  test("promotion artwork dies with the screen, and never leaves the waiting room", async () => {
    // Promo art is the one image class on the board that is NOT a client's
    // property, so the instinct is to treat it as harmless and serve it from a
    // presigned R2 link. That instinct is what produces a URL outliving the
    // screen it was printed for. It goes through the same token as everything
    // else, and it answers only for a PUBLIC board — the private board carries
    // no promotions, so a back-office token asking for one is a credential
    // reaching past its own payload.
    const pubToken = `promo-pub-${Date.now()}`;
    const privToken = `promo-priv-${Date.now()}`;
    const pub = await prisma.display.create({
      data: { name: `E2E Promo Pub ${Date.now()}`, mode: "PUBLIC", tokenHash: hash(pubToken) },
    });
    const priv = await prisma.display.create({
      data: { name: `E2E Promo Priv ${Date.now()}`, mode: "PRIVATE", tokenHash: hash(privToken) },
    });
    const api = await pwRequest.newContext();
    try {
      const board = await api.get(`${API}/api/public/display/board?token=${pubToken}`);
      expect(board.status()).toBe(200);
      const promos = (await board.json()).board?.promotions ?? [];
      const art = promos.flatMap((p: any) => p.photos ?? [])[0];
      test.skip(!art, "needs an active promotion carrying artwork");

      const artUrl = `${API}${art.url}?token=${pubToken}`;
      expect((await api.get(artUrl)).status(), "the waiting-room board can load its own art").toBe(200);

      expect(
        (await api.get(`${API}${art.url}`)).status(),
        "artwork must not be fetchable without a display token",
      ).toBe(401);

      expect(
        (await api.get(`${API}${art.url}?token=${privToken}`)).status(),
        "a back-office token must not fetch art its own board never references",
      ).toBe(404);

      await prisma.display.update({ where: { id: pub.id }, data: { revokedAt: new Date() } });
      expect(
        (await api.get(artUrl)).status(),
        "a revoked screen must not keep loading promo art from a URL it already holds",
      ).toBe(401);
    } finally {
      await api.dispose();
      await prisma.display.deleteMany({ where: { id: { in: [pub.id, priv.id] } } }).catch(() => {});
    }
  });

  test("a display token is not a key to every photo in the system", async () => {
    // The scariest shape: a valid token plus a guessed id. The endpoint must
    // answer only for photos its own board would show.
    const token = `stale-scope-${Date.now()}`;
    const d = await prisma.display.create({
      data: { name: `E2E Scope ${Date.now()}`, mode: "PUBLIC", tokenHash: hash(token) },
    });
    const api = await pwRequest.newContext();
    try {
      const unfinished = await prisma.jobOccurrencePhoto.findFirst({
        where: { occurrence: { status: { notIn: ["COMPLETED", "PENDING_PAYMENT", "CLOSED"] } } },
        select: { id: true },
      });
      test.skip(!unfinished, "needs a photo on an unfinished visit");
      expect(
        (await api.get(`${API}/api/public/display/photo/${unfinished!.id}?token=${token}`)).status(),
        "a token must not fetch a photo from a visit that is not finished",
      ).toBe(404);
    } finally {
      await api.dispose();
      await prisma.display.delete({ where: { id: d.id } }).catch(() => {});
    }
  });
});
