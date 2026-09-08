// ─────────────────────────────────────────────────────────────────────────────
// NUL bytes cannot reach Postgres.
//
// A `text` column rejects U+0000 outright — the driver surfaces it as
//
//   ConnectorError … PostgresError { code: "22021",
//   message: "invalid byte sequence for encoding \"UTF8\": 0x00" }
//
// which Fastify turns into a bare 500. The operator sees "Add failed: Internal
// Server Error" with no hint that one invisible character in a pasted field is
// the cause, and no amount of retrying helps.
//
// SHIPPED IN PRODUCTION, 2026-09-07: adding a Ledger expense failed on every
// attempt, in both Safari and Chrome. The invoice number had been pasted out
// of a PDF, and PDF text extraction routinely carries NUL. `.trim()` does not
// remove it — NUL is not whitespace — so every field on that form was trimmed
// and still poisoned.
//
// This is not a Ledger problem. Any text field on any route can receive a
// pasted NUL, so the scrub belongs at the boundary where JSON becomes our
// data, not at the dozens of call sites that happen to write strings today.
//
// SCOPE, deliberately narrow: U+0000 only. Other C0 control characters are
// legal in Postgres text and may be meaningful (tab, newline). Stripping them
// would silently damage real content to fix a problem they do not cause.
// ─────────────────────────────────────────────────────────────────────────────

const NUL_RE = /\u0000/g;

/** Strip NUL from one string. Exported for boundaries that do not go through
 *  the request hook — a webhook body, a CSV cell, an imported file. */
export function scrubNul(s: string): string {
  return s.includes("\u0000") ? s.replace(NUL_RE, "") : s;
}

/**
 * Recursively strip NUL from every string in a parsed JSON value.
 *
 * Returns the SAME object when nothing changed, so the overwhelmingly common
 * path allocates nothing. Arrays and plain objects are walked; Dates, Buffers
 * and other class instances are returned untouched — a Buffer legitimately
 * contains 0x00 and is not headed for a text column.
 */
export function scrubNulDeep<T>(value: T, depth = 0): T {
  // A deeply nested or hostile body must not blow the stack.
  if (depth > 20) return value;
  if (typeof value === "string") return scrubNul(value) as unknown as T;
  if (value === null || typeof value !== "object") return value;

  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((v) => {
      const next = scrubNulDeep(v, depth + 1);
      if (next !== v) changed = true;
      return next;
    });
    return (changed ? out : value) as unknown as T;
  }

  // PLAIN objects only. A Date or Buffer rebuilt as a plain object is
  // destroyed, and neither can carry a NUL into a text column anyway.
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;

  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const next = scrubNulDeep(v, depth + 1);
    if (next !== v) changed = true;
    out[k] = next;
  }
  return (changed ? out : value) as unknown as T;
}

/**
 * Scrub a container IN PLACE.
 *
 * Fastify exposes `request.query` through a getter, so `req.query = …` is a
 * silent no-op — the unit tests passed while the hook did nothing for query
 * strings, and only an inject-level test caught it. Mutating the object we
 * were handed works regardless of how the property is defined.
 */
export function scrubNulInPlace(obj: unknown): void {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return;
  const rec = obj as Record<string, unknown>;
  for (const k of Object.keys(rec)) {
    const v = rec[k];
    if (typeof v === "string") {
      const next = scrubNul(v);
      if (next !== v) rec[k] = next;
    } else if (v && typeof v === "object") {
      const next = scrubNulDeep(v);
      if (next !== v) rec[k] = next;
    }
  }
}
