// Settings-tab section definitions. Presentational only: each Setting row
// carries a `section` key (a DB column, set in the API seed); this constant
// supplies the human title/description and the display order for each
// section. A setting whose `section` is null or unrecognized falls into the
// "Other" catch-all so nothing is ever hidden.
//
// Adding a NEW section is a deliberate design change and a code edit here.
// Adding a new *setting* to an existing section is not — that's just the
// `section` value on the setting row (API seed or a prod SQL insert).

export type SettingSection = {
  key: string;
  title: string;
  description: string;
};

// Ordered — sections render top-to-bottom in this order.
export const SETTING_SECTIONS: SettingSection[] = [
  // Pinned to the top — flipping the cutoff affects EVERY money view in the
  // app, so the operator should see this control before any rate/method
  // tweak. The toggle UI is rendered inline by SettingsTab (special-cased
  // before the generic per-section loop). See lib/businessStartCutoff.tsx.
  {
    key: "fresh_start",
    title: "Business Start Date",
    description: "Non-destructive money cleanup. When enabled, payments, expenses, equipment charges, and audit events from before the configured date are hidden across every view and export. No data is deleted — Super can temporarily reveal pre-cutoff history via the toggle below the date.",
  },
  {
    key: "payments",
    title: "Payments & Payouts",
    description: "Fee and margin rates, processor-fee handling, payroll cadence, and accepted payment methods.",
  },
  {
    key: "client_requests",
    title: "Client Payment Requests",
    description: "How clients are asked to pay and notified, payment-request links, and business payment accounts.",
  },
  {
    key: "catalogs",
    title: "Catalogs & Taxonomies",
    description: "Configurable lists: service types, equipment kinds, document types, timeline categories.",
  },
  {
    key: "media",
    title: "Photos & Documents",
    description: "Upload size limits and image-quality settings for job photos and company documents.",
  },
  {
    key: "compliance",
    title: "Compliance",
    description: "Policy-system controls: 2-eyes enforcement on Approve + Publish, default grace hours after a new version publishes. See docs/features/compliance.md.",
  },
  {
    key: "integrations",
    title: "Integrations",
    description: "API keys and credentials for external services.",
  },
];

// The catch-all bucket for settings with a null/unknown section. Rendered
// last, after every defined section.
export const OTHER_SECTION: SettingSection = {
  key: "__other__",
  title: "Other",
  description: "Settings not yet assigned to a section.",
};

const SECTION_BY_KEY = new Map(SETTING_SECTIONS.map((s) => [s.key, s]));

/** Resolve a setting's `section` value to a section definition. Unknown or
 *  null → the "Other" catch-all. */
export function resolveSettingSection(sectionKey: string | null | undefined): SettingSection {
  if (sectionKey && SECTION_BY_KEY.has(sectionKey)) return SECTION_BY_KEY.get(sectionKey)!;
  return OTHER_SECTION;
}

/** Section display order, including the trailing "Other" bucket. */
export const SETTING_SECTION_ORDER: string[] = [
  ...SETTING_SECTIONS.map((s) => s.key),
  OTHER_SECTION.key,
];
