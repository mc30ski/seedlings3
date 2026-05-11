"use client";

export type DocumentTypeConfig = {
  key: string;
  label: string;
  singleton?: boolean;
  /** Group-level description shown above all docs of this type. */
  description?: string;
};

export const DEFAULT_DOCUMENT_TYPES: DocumentTypeConfig[] = [
  { key: "ARTICLES_OF_ORGANIZATION", label: "Articles of Organization", singleton: true, description: "Company formation documents filed with the state." },
  { key: "EIN_LETTER", label: "EIN Letter", singleton: true, description: "IRS letter confirming the company's Employer Identification Number." },
  { key: "OPERATING_AGREEMENT", label: "Operating Agreement", singleton: true, description: "Internal governance document defining ownership and management." },
  { key: "INSURANCE_CERT", label: "Insurance Certificate", singleton: false, description: "Liability, auto, and umbrella coverage certificates from our carriers." },
  { key: "BUSINESS_LICENSE", label: "Business License", singleton: false, description: "Local and state business licenses, one per jurisdiction or renewal cycle." },
  { key: "VENDOR_CONTRACT", label: "Vendor Contract", singleton: false, description: "Service or supply agreements with vendors." },
  { key: "TAX_RETURN", label: "Tax Return", singleton: false, description: "Federal and state tax returns, one per year." },
];

export function parseDocumentTypesConfig(
  raw: string | null | undefined,
): DocumentTypeConfig[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].key) {
      return parsed;
    }
  } catch {}
  return null;
}

export function documentTypeLabel(
  key: string,
  config?: DocumentTypeConfig[] | null,
): string {
  const list = config ?? DEFAULT_DOCUMENT_TYPES;
  return list.find((t) => t.key === key)?.label ?? key;
}

export function isSingletonType(
  key: string,
  config?: DocumentTypeConfig[] | null,
): boolean {
  const list = config ?? DEFAULT_DOCUMENT_TYPES;
  return !!list.find((t) => t.key === key)?.singleton;
}

export function documentTypeDescription(
  key: string,
  config?: DocumentTypeConfig[] | null,
): string | null {
  const list = config ?? DEFAULT_DOCUMENT_TYPES;
  return list.find((t) => t.key === key)?.description ?? null;
}
