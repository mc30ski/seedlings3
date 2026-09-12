// ─────────────────────────────────────────────────────────────────────────────
// The estimate address, in both of its forms.
//
// An estimate is a property we do not have a client for yet. It used to be
// captured as ONE free-text string, and converting it into a real property
// meant pulling that string back apart — structured → string → structured.
// That round-trip is what put state "North" on 19 live properties: the
// splitter took the first whitespace token of "North Carolina 27517" and the
// rest vanished without an error.
//
// So the parts are now stored as parts. The one-line `estimateAddress` column
// stays, for two reasons that are both still live:
//
//   1. It is what the job card, the client preview and the map link render.
//   2. Estimates created before these columns existed have ONLY that string,
//      and there are 28 of them in production. They are not backfilled — a
//      backfill would be the same lossy parse, just run once and blamed on
//      nobody. They keep the string; conversion parses it on the way out, and
//      anything edited through the dialog gains real parts from then on.
//
// The string is DERIVED here, never accepted from a caller alongside parts, so
// the two representations cannot drift.
// ─────────────────────────────────────────────────────────────────────────────

export type EstimateAddressParts = {
  estimateStreet1?: string | null;
  estimateStreet2?: string | null;
  estimateCity?: string | null;
  estimateState?: string | null;
  estimatePostalCode?: string | null;
};

/** The column names, in the order they compose the one-line form. Exported so
 *  route handlers and the build gate enumerate ONE list rather than five
 *  hand-copied strings that can fall out of step. */
export const ESTIMATE_ADDRESS_PART_FIELDS = [
  "estimateStreet1",
  "estimateStreet2",
  "estimateCity",
  "estimateState",
  "estimatePostalCode",
] as const;

const clean = (v: unknown): string | null => {
  const s = typeof v === "string" ? v.trim() : "";
  return s ? s : null;
};

/**
 * "123 Main St, Apt 2, Chapel Hill, North Carolina 27517".
 *
 * State and ZIP join with a SPACE, everything else with a comma — which is
 * exactly the shape `parseAddressLine` on the web anchors its ZIP regex to, so
 * a line written here reads back as the same parts it was built from.
 *
 * Returns null when there is nothing to say. An empty string would overwrite a
 * legacy row's only copy of its address with "".
 */
export function formatEstimateAddressLine(parts: EstimateAddressParts): string | null {
  const street1 = clean(parts.estimateStreet1);
  const street2 = clean(parts.estimateStreet2);
  const city = clean(parts.estimateCity);
  const state = clean(parts.estimateState);
  const zip = clean(parts.estimatePostalCode);
  const stateZip = [state, zip].filter(Boolean).join(" ");
  const line = [street1, street2, city, stateZip].filter(Boolean).join(", ");
  return line || null;
}

/**
 * Copy whatever parts a caller supplied onto a Prisma `data` object and keep
 * the one-line column in step.
 *
 * Two rules worth keeping straight:
 *
 *   - A part the caller did not mention is left alone. These run on PATCH
 *     bodies, where absent means "unchanged", not "clear it".
 *   - The one-line form is rewritten from the MERGED result — the parts being
 *     written on top of the parts already stored. Rebuilding it from the patch
 *     alone would blank the city every time someone edited only the ZIP.
 *
 * `existing` is the row as it stands (omit it on create). Returns true when
 * anything was touched, so callers can skip an empty update.
 */
export function applyEstimateAddressParts(
  data: Record<string, any>,
  input: Record<string, any>,
  existing?: EstimateAddressParts | null,
): boolean {
  let touched = false;
  for (const field of ESTIMATE_ADDRESS_PART_FIELDS) {
    if (input[field] !== undefined) {
      data[field] = clean(input[field]);
      touched = true;
    }
  }
  if (!touched) return false;

  const merged: EstimateAddressParts = {};
  for (const field of ESTIMATE_ADDRESS_PART_FIELDS) {
    merged[field] = field in data ? data[field] : (existing?.[field] ?? null);
  }
  data.estimateAddress = formatEstimateAddressLine(merged);
  return true;
}

/**
 * Lift the address parts out of a request body, keeping ONLY the keys the
 * caller actually sent.
 *
 * Present-vs-absent is the whole point: on a PATCH, an absent key means
 * "leave it" and a key set to "" means "clear it". Returning all five every
 * time would turn every partial edit into a full overwrite.
 */
export function pickEstimateAddressParts(body: Record<string, any>): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const field of ESTIMATE_ADDRESS_PART_FIELDS) {
    if (field in body) out[field] = clean(body[field]);
  }
  return out;
}
