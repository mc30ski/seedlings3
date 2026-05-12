import { Prisma } from "@prisma/client";
import { prisma } from "../db/prisma";
import { writeAudit } from "../lib/auditLogger";
import { AUDIT } from "../lib/auditActions";
import { ServiceError } from "../lib/errors";

export const banners = {
  /**
   * Post a banner to one or more recipients. If `everyone=true`, expands
   * recipients to every approved user at send time — that way the dismissal
   * model stays per-user even for broadcasts (new users joining later don't
   * suddenly see old broadcasts they weren't around for).
   */
  async post(
    currentUserId: string,
    payload: {
      title?: string | null;
      body: string;
      everyone?: boolean;
      userIds?: string[];
      expiresAt?: string | null;
    },
  ) {
    if (!payload.body?.trim()) {
      throw new ServiceError("INVALID", "Body is required.", 400);
    }
    if (!payload.everyone && (!payload.userIds || payload.userIds.length === 0)) {
      throw new ServiceError("INVALID", "Pick at least one recipient or send to everyone.", 400);
    }

    let recipientIds: string[] = [];
    if (payload.everyone) {
      const users = await prisma.user.findMany({
        where: { isApproved: true },
        select: { id: true },
      });
      recipientIds = users.map((u) => u.id);
    } else {
      recipientIds = Array.from(new Set(payload.userIds ?? []));
    }
    if (recipientIds.length === 0) {
      throw new ServiceError("NO_RECIPIENTS", "No recipients to post to.", 400);
    }

    return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const banner = await tx.bannerNotification.create({
        data: {
          title: payload.title?.trim() || null,
          body: payload.body.trim(),
          expiresAt: payload.expiresAt ? new Date(payload.expiresAt) : null,
          createdById: currentUserId,
        },
      });
      await tx.bannerRecipient.createMany({
        data: recipientIds.map((userId) => ({ bannerId: banner.id, userId })),
        skipDuplicates: true,
      });
      await writeAudit(tx, AUDIT.BANNER.POSTED, currentUserId, {
        bannerId: banner.id,
        recipientCount: recipientIds.length,
        everyone: !!payload.everyone,
      });
      return { ...banner, recipientCount: recipientIds.length };
    });
  },

  /**
   * Banners the caller still has pending — they're a recipient AND haven't
   * dismissed AND the banner hasn't expired. Newest first so the most recent
   * message is at the top of the stack.
   */
  async listForUser(userId: string) {
    const now = new Date();
    const rows = await prisma.bannerNotification.findMany({
      where: {
        recipients: { some: { userId } },
        dismissals: { none: { userId } },
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      orderBy: { createdAt: "desc" },
      include: {
        createdBy: { select: { id: true, displayName: true, email: true } },
      },
    });
    return rows;
  },

  async dismiss(userId: string, bannerId: string) {
    // Idempotent — re-dismissing is a no-op. We still upsert so the timestamp
    // reflects the latest action, but skip the audit row when nothing changed.
    const existing = await prisma.bannerDismissal.findUnique({
      where: { bannerId_userId: { bannerId, userId } },
    });
    if (existing) return { ok: true, alreadyDismissed: true };

    return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.bannerDismissal.create({
        data: { bannerId, userId },
      });
      await writeAudit(tx, AUDIT.BANNER.DISMISSED, userId, { bannerId });
      return { ok: true, alreadyDismissed: false };
    });
  },

  /**
   * Admin-side list — every banner with recipient + dismissal counts so the
   * Notify tab can show a history with delivery stats.
   */
  async listAdmin() {
    const rows = await prisma.bannerNotification.findMany({
      orderBy: { createdAt: "desc" },
      include: {
        createdBy: { select: { id: true, displayName: true, email: true } },
        _count: { select: { recipients: true, dismissals: true } },
      },
      take: 100,
    });
    return rows.map((r) => ({
      ...r,
      recipientCount: r._count.recipients,
      dismissedCount: r._count.dismissals,
    }));
  },

  /** Permanently delete a banner (super or original poster). */
  async delete(currentUserId: string, bannerId: string) {
    return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const b = await tx.bannerNotification.findUnique({ where: { id: bannerId } });
      if (!b) throw new ServiceError("NOT_FOUND", "Banner not found.", 404);
      await tx.bannerNotification.delete({ where: { id: bannerId } });
      await writeAudit(tx, AUDIT.BANNER.DELETED, currentUserId, { bannerId });
      return { ok: true };
    });
  },
};
