/**
 * Web Push delivery — VAPID-signed pushes to the per-user PushSubscription rows.
 * Dead subscriptions (404/410) are pruned on send.
 */

import webpush from "web-push";
import { prisma } from "../db/prisma";

let configured = false;
function configure() {
  if (configured) return true;
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  const subj = process.env.VAPID_SUBJECT;
  if (!pub || !priv || !subj) return false;
  webpush.setVapidDetails(subj, pub, priv);
  configured = true;
  return true;
}

export type PushPayload = {
  title: string;
  body: string;
  url?: string;
  tag?: string;
};

export type PushResult = {
  attempted: number;
  delivered: number;
  pruned: number;
  failed: number;
};

export async function sendPushToUser(userId: string, payload: PushPayload): Promise<PushResult> {
  const result: PushResult = { attempted: 0, delivered: 0, pruned: 0, failed: 0 };
  if (!configure()) return result;

  const subs = await prisma.pushSubscription.findMany({ where: { userId } });
  result.attempted = subs.length;
  if (subs.length === 0) return result;

  const json = JSON.stringify(payload);

  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          json,
        );
        result.delivered++;
        await prisma.pushSubscription.update({
          where: { id: s.id },
          data: { lastUsedAt: new Date() },
        }).catch(() => {});
      } catch (err: any) {
        const status = err?.statusCode ?? 0;
        if (status === 404 || status === 410) {
          await prisma.pushSubscription.delete({ where: { id: s.id } }).catch(() => {});
          result.pruned++;
        } else {
          result.failed++;
          console.warn(`Push send failed for sub ${s.id} (status=${status}):`, err?.body || err?.message);
        }
      }
    }),
  );

  return result;
}
