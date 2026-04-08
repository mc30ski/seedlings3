/**
 * Notification utilities for SMS (Twilio) and Email (Resend).
 * Provides a unified `notifyWorker` function that picks the best channel.
 */

import { prisma } from "../db/prisma";

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
): Promise<{ ok: boolean; error?: string }> {
  const client = getResend();
  if (!client) return { ok: false, error: "Resend not configured" };

  try {
    await client.emails.send({
      from: "Seedlings Lawn Care <notifications@seedlingslawncare.com>",
      to,
      subject,
      text: body,
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
};

/**
 * Notify a worker by their best available contact method.
 * Checks phone first (SMS), then email.
 */
export async function notifyWorker(
  userId: string,
  message: string,
  options?: { subject?: string; link?: string },
): Promise<NotifyResult> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, phone: true, displayName: true },
  });

  if (!user) return { method: "none", ok: false, error: "User not found" };

  const fullMessage = options?.link
    ? `${message}\n\nOpen the app: ${options.link}`
    : message;

  // Prefer SMS if phone available
  if (user.phone) {
    const phone = user.phone.replace(/[^\d+]/g, "");
    const smsResult = await sendSMS(phone.startsWith("+") ? phone : `+1${phone}`, fullMessage);
    if (smsResult.ok) return { method: "sms", ...smsResult };
    // SMS failed — fall back to email
    console.warn(`SMS failed for user ${userId}, falling back to email:`, smsResult.error);
  }

  if (user.email) {
    const result = await sendEmail(
      user.email,
      options?.subject ?? "Seedlings Lawn Care — Reminder",
      fullMessage,
    );
    return { method: "email", ...result };
  }

  return { method: "none", ok: false, error: "No contact method available" };
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
