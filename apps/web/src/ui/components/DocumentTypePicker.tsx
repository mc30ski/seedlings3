"use client";

export type DocumentTypeConfig = {
  key: string;
  label: string;
  singleton?: boolean;
};

export const DEFAULT_DOCUMENT_TYPES: DocumentTypeConfig[] = [
  { key: "ARTICLES_OF_ORGANIZATION", label: "Articles of Organization", singleton: true },
  { key: "EIN_LETTER", label: "EIN Letter", singleton: true },
  { key: "OPERATING_AGREEMENT", label: "Operating Agreement", singleton: true },
  { key: "INSURANCE_CERT", label: "Insurance Certificate", singleton: false },
  { key: "BUSINESS_LICENSE", label: "Business License", singleton: false },
  { key: "VENDOR_CONTRACT", label: "Vendor Contract", singleton: false },
  { key: "TAX_RETURN", label: "Tax Return", singleton: false },
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
