/**
 * Notification utilities for SMS (Twilio) and Email (Resend).
 * Provides a unified `notifyWorker` function that picks the best channel.
 */

import { prisma } from "../db/prisma";
import { sendPushToUser, type PushPayload } from "./push";

// ── SMS via Twilio ──

let twilioClient: any = null;

function getTwilio() {
  if (twilioClient) return twilioClient;
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) return null;
  const twilio = require("twilio");
  twilioClient = twilio(sid, token);
  return twilioClient;
}

export async function sendSMS(to: string, message: string): Promise<{ ok: boolean; error?: string }> {
  const client = getTwilio();
  if (!client) return { ok: false, error: "Twilio not configured" };

  const from = process.env.TWILIO_PHONE_NUMBER;
  if (!from) return { ok: false, error: "TWILIO_PHONE_NUMBER not set" };

  try {
    await client.messages.create({
      to,
      from,
      body: message,
    });
    return { ok: true };
  } catch (err: any) {
    console.error("SMS send failed:", err.message);
    return { ok: false, error: err.message };
  }
}

// ── Email via Resend ──

let resendClient: any = null;

function getResend() {
  if (resendClient) return resendClient;
  const key = process.env.RESEND_API_KEY;
  if (!key) return null;
  const { Resend } = require("resend");
  resendClient = new Resend(key);
  return resendClient;
}

export async function sendEmail(
  to: string,
  subject: string,
  body: string,
  options?: { html?: string },
): Promise<{ ok: boolean; error?: string }> {
  const client = getResend();
  if (!client) return { ok: false, error: "Resend not configured" };

  try {
    await client.emails.send({
      from: "Seedlings Lawn Care <notifications@seedlingslawncare.com>",
      to,
      subject,
      text: body,
      ...(options?.html ? { html: options.html } : {}),
    });
    return { ok: true };
  } catch (err: any) {
    console.error("Email send failed:", err.message);
    return { ok: false, error: err.message };
  }
}

// ── Unified notification ──

type NotifyResult = {
  method: "sms" | "email" | "none";
  ok: boolean;
  error?: string;
  push?: { delivered: number; pruned: number; failed: number };
};

/**
 * Notify a worker by their best available contact method.
 * Checks phone first (SMS), then email.
 *
 * `message` can be a single string (used for both channels) or an object with
 * separate `sms` and `email` bodies — useful when SMS needs to be terse and
 * email can be long-form. If only one is provided in the object the other
 * falls back to it.
 */
export async function notifyWorker(
  userId: string,
  message: string | { sms?: string; email?: string; push?: PushPayload },
  options?: {
    subject?: string;
    link?: string;
    /** When true, skip the paid channels (Twilio SMS, Resend email) and
     *  only fire web-push. Web-push is free, so callers that want a
     *  low-cost default pass this. The user can still opt back into
     *  paid channels by flipping a setting in the Settings tab. */
    pushOnly?: boolean;
  },
): Promise<NotifyResult> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, phone: true, displayName: true },
  });

  if (!user) return { method: "none", ok: false, error: "User not found" };

  const smsBase = typeof message === "string" ? message : (message.sms ?? message.email ?? "");
  const emailBase = typeof message === "string" ? message : (message.email ?? message.sms ?? "");
  const smsBody = options?.link ? `${smsBase}\n\nOpen: ${options.link}` : smsBase;
  const emailBody = options?.link ? `${emailBase}\n\nOpen the app: ${options.link}` : emailBase;

  // Push is a bonus channel — fire alongside SMS/email, never as a substitute.
  // Defaults to a generic title/body derived from the message if no explicit
  // push payload is provided.
  const pushPayload: PushPayload | null = (() => {
    if (typeof message === "string") {
      return { title: options?.subject ?? "Seedlings", body: message, url: options?.link };
    }
    if (message.push) return { ...message.push, url: message.push.url ?? options?.link };
    if (message.sms || message.email) {
      return {
        title: options?.subject ?? "Seedlings",
        body: message.sms ?? message.email ?? "",
        url: options?.link,
      };
    }
    return null;
  })();
  const pushPromise = pushPayload
    ? sendPushToUser(userId, pushPayload).catch((err) => {
        console.warn(`Push send threw for user ${userId}:`, err?.message);
        return { attempted: 0, delivered: 0, pruned: 0, failed: 0 };
      })
    : Promise.resolve({ attempted: 0, delivered: 0, pruned: 0, failed: 0 });

  // Caller-requested push-only mode — skip the paid channels entirely.
  if (options?.pushOnly) {
    const push = await pushPromise;
    return { method: "none", ok: true, push };
  }

  // Prefer SMS if phone available
  if (user.phone) {
    const phone = user.phone.replace(/[^\d+]/g, "");
    const smsResult = await sendSMS(phone.startsWith("+") ? phone : `+1${phone}`, smsBody);
    const push = await pushPromise;
    if (smsResult.ok) return { method: "sms", ...smsResult, push };
    // SMS failed — fall back to email
    console.warn(`SMS failed for user ${userId}, falling back to email:`, smsResult.error);
  }

  if (user.email) {
    const result = await sendEmail(
      user.email,
      options?.subject ?? "Seedlings Lawn Care — Reminder",
      emailBody,
    );
    const push = await pushPromise;
    return { method: "email", ...result, push };
  }

  const push = await pushPromise;
  return { method: "none", ok: false, error: "No contact method available", push };
}

/**
 * Notify a worker by phone number directly (bypasses user lookup).
 * Use this when you already have the phone number.
 */
export async function notifyByPhone(
  phone: string,
  message: string,
): Promise<NotifyResult> {
  const cleaned = phone.replace(/[^\d+]/g, "");
  const formatted = cleaned.startsWith("+") ? cleaned : `+1${cleaned}`;
  const result = await sendSMS(formatted, message);
  return { method: "sms", ...result };
}
