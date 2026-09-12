// ─────────────────────────────────────────────────────────────────────────────
// Splitting a one-line address into fields.
//
// ONE IMPLEMENTATION, because there were two and they disagreed.
//
// Both the property form and the estimate-conversion form parse a pasted or
// autocompleted address like:
//
//     "123 Main St, Austin, Texas 78701, United States"
//     "1059 Perdue Dr, Chapel Hill, North Carolina 27517"
//
// The obvious way to read the third segment is to split on whitespace and take
// the first token as the state. That is wrong for every multi-word state name,
// and it fails SILENTLY: "North Carolina 27517" becomes state "North", the
// field looks plausible in a free-text input, and nobody notices until a
// client's confirmation text reads "…Chapel Hill, North."
//
// It reached production. 19 live properties carry state "North" — every one
// created through the estimate-conversion path during the window when that
// parser was in use. The property form was fixed; the estimate one was not,
// and both kept running, so which spelling a property got depended on which
// screen created it.
//
// The fix is to anchor on the ZIP instead: a US postal code is unambiguous at
// the END of the segment, so everything before it is the state, however many
// words that is.
// ─────────────────────────────────────────────────────────────────────────────

export type ParsedAddress = {
  street1: string;
  city: string;
  /** Whatever precedes the ZIP — "NC", "North Carolina", "New York". Never a
   *  truncated first word. */
  state: string;
  postalCode: string;
  /** Present only when the source included a country segment. */
  country: string;
};

/** A trailing US ZIP: five digits, optionally +4. Anchored to the END, which
 *  is what makes the state unambiguous no matter how many words it has. */
const TRAILING_ZIP = /\s*(\d{5}(?:-\d{4})?)\s*$/;

/**
 * Split "street, city, state zip[, country]" into fields.
 *
 * Degrades rather than guesses: with two segments it fills street and city and
 * leaves the rest blank; with one it is all street. A partly-filled form the
 * operator can finish beats a confidently wrong one they will not notice.
 */
export function parseAddressLine(raw: string): ParsedAddress {
  const parts = String(raw ?? "").split(",").map((s) => s.trim());
  const empty: ParsedAddress = { street1: "", city: "", state: "", postalCode: "", country: "" };

  if (parts.length === 1) return { ...empty, street1: parts[0] ?? "" };
  if (parts.length === 2) return { ...empty, street1: parts[0] ?? "", city: parts[1] ?? "" };

  const stateZip = parts[2] ?? "";
  const zip = stateZip.match(TRAILING_ZIP);
  return {
    street1: parts[0] ?? "",
    city: parts[1] ?? "",
    // Everything before the ZIP. With no ZIP the whole segment is the state,
    // which is right for a bare "NC".
    state: (zip ? stateZip.slice(0, zip.index).trim() : stateZip).trim(),
    postalCode: zip ? zip[1] : "",
    country: parts[3] ?? "",
  };
}
