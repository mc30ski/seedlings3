// ─────────────────────────────────────────────────────────────────────────────
// SOCIAL_LINKS setting — operator-tunable list of social media links shown
// as a row of clickable icons under the property photos on the public
// /pay/[token] invoice page. Each entry carries a display label, the URL
// to open on tap, and a data-URL icon uploaded via the SettingsTab
// editor.
//
// Brand icons are uploaded — not bundled — so each platform's official
// asset (per their published brand guidelines) is used without us
// shipping their marks. The "type" field intentionally went away from
// an earlier design: with the operator supplying the icon, there's no
// need for an enum to drive default-glyph selection. Just label + URL +
// icon.
// ─────────────────────────────────────────────────────────────────────────────
import { prisma } from "../db/prisma";

export type SocialLink = {
  /** Display name / platform name. Used as accessible name on the tile
   *  (alt / aria-label) and as the operator-facing identifier in the
   *  SettingsTab editor. */
  label: string;
  /** Destination URL opened in a new tab when the tile is tapped. Must
   *  start with `https://` so we never ship a mixed-content link from
   *  the invoice page. */
  url: string;
  /** Brand icon as a data URL (`data:image/...`). Required — there's no
   *  default-glyph fallback. Uploaded via the SettingsTab editor and
   *  capped at 50 KB so the SOCIAL_LINKS row doesn't bloat the public
   *  pay payload. */
  iconDataUrl: string;
};

const ALLOWED_KEYS = new Set(["label", "url", "iconDataUrl"]);
const MAX_ICON_BYTES = 50 * 1024;

/**
 * Parse the raw JSON value of the SOCIAL_LINKS setting into a typed array.
 * Tolerant of missing top-level wrappers so an older `[]`-shaped value
 * still loads cleanly. Throws on shape errors so a bad save can't
 * silently break the invoice page.
 */
export function parseSocialLinksSetting(raw: string | null | undefined): SocialLink[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("SOCIAL_LINKS setting is not valid JSON.");
  }
  // Accept either `{links: [...]}` (canonical shape — leaves room for
  // top-level config later) or a bare `[...]` for backward-compat. The
  // editor writes the canonical shape.
  const rows: unknown[] = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as any)?.links)
      ? (parsed as any).links
      : (() => { throw new Error("SOCIAL_LINKS setting must be an object with a `links` array."); })();

  return rows.map((row, idx) => {
    if (!row || typeof row !== "object") {
      throw new Error(`SOCIAL_LINKS[${idx}] must be an object.`);
    }
    for (const k of Object.keys(row as object)) {
      if (!ALLOWED_KEYS.has(k)) {
        throw new Error(`SOCIAL_LINKS[${idx}] has unknown field "${k}".`);
      }
    }
    const r = row as Record<string, unknown>;
    if (typeof r.label !== "string" || !r.label.trim()) {
      throw new Error(`SOCIAL_LINKS[${idx}].label is required.`);
    }
    if (typeof r.url !== "string" || !r.url.trim()) {
      throw new Error(`SOCIAL_LINKS[${idx}].url is required.`);
    }
    if (typeof r.iconDataUrl !== "string" || !r.iconDataUrl.trim()) {
      throw new Error(`SOCIAL_LINKS[${idx}].iconDataUrl is required.`);
    }
    return {
      label: r.label,
      url: r.url,
      iconDataUrl: r.iconDataUrl,
    };
  });
}

/**
 * Validate the JSON shape for a SOCIAL_LINKS PATCH. Same checks as the
 * parser plus per-field range/format rules. Throws on any violation so
 * the Settings route can surface a clean 400.
 */
export function validateSocialLinksJson(raw: string): SocialLink[] {
  const rows = parseSocialLinksSetting(raw);
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r.label.length > 60) {
      throw new Error(`SOCIAL_LINKS[${i}].label must be 60 characters or fewer.`);
    }
    if (!r.url.startsWith("https://")) {
      throw new Error(`SOCIAL_LINKS[${i}].url must start with https://`);
    }
    if (r.url.length > 500) {
      throw new Error(`SOCIAL_LINKS[${i}].url must be 500 characters or fewer.`);
    }
    if (!r.iconDataUrl.startsWith("data:image/")) {
      throw new Error(`SOCIAL_LINKS[${i}].iconDataUrl must be a data URL (data:image/...).`);
    }
    // Rough byte-size check — data URL length × 0.75 ≈ decoded byte
    // count. Cheap to compute, accurate enough for the 50 KB cap.
    const approxBytes = Math.round((r.iconDataUrl.length * 3) / 4);
    if (approxBytes > MAX_ICON_BYTES) {
      throw new Error(
        `SOCIAL_LINKS[${i}].iconDataUrl is approximately ${Math.round(approxBytes / 1024)} KB; must be ${Math.round(MAX_ICON_BYTES / 1024)} KB or smaller.`,
      );
    }
  }
  return rows;
}

/**
 * Load the parsed taxonomy from the DB. Returns [] if the setting is
 * missing (covers a fresh production install before the seed) or if the
 * JSON is malformed (defensive — a bad SOCIAL_LINKS shouldn't crash the
 * public pay page; it should just hide the row).
 */
export async function loadSocialLinks(
  client: typeof prisma | any = prisma,
): Promise<SocialLink[]> {
  const row = await client.setting.findUnique({ where: { key: "SOCIAL_LINKS" } });
  try {
    return parseSocialLinksSetting(row?.value);
  } catch {
    return [];
  }
}
