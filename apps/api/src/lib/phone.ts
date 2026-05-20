/**
 * Normalize a US phone number to E.164 (+1XXXXXXXXXX) for SMS/Twilio.
 * Returns null when the input has no recognizable 10-digit US number.
 */
export function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}
