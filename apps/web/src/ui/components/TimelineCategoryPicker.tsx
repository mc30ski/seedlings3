"use client";

export type TimelineCategoryConfig = {
  key: string;
  label: string;
  description?: string;
};

export const DEFAULT_TIMELINE_CATEGORIES: TimelineCategoryConfig[] = [
  { key: "TAXES", label: "Taxes", description: "Tax filings, estimated payments, and IRS deadlines." },
  { key: "INSURANCE", label: "Insurance", description: "Policy renewals, premium payments, and carrier audits." },
  { key: "LICENSING", label: "Licensing", description: "Business licenses, permits, and renewals across jurisdictions." },
  { key: "COMPLIANCE", label: "Compliance", description: "Regulatory filings and compliance reviews." },
  { key: "OPERATIONS", label: "Operations", description: "Internal operational milestones." },
  { key: "FINANCE", label: "Finance", description: "Bookkeeping, audits, and other financial calendar items." },
];

export function parseTimelineCategoriesConfig(
  raw: string | null | undefined,
): TimelineCategoryConfig[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].key) return parsed;
  } catch {}
  return null;
}

export function categoryLabel(
  key: string | null | undefined,
  config?: TimelineCategoryConfig[] | null,
): string {
  if (!key) return "";
  const list = config ?? DEFAULT_TIMELINE_CATEGORIES;
  return list.find((c) => c.key === key)?.label ?? key;
}
