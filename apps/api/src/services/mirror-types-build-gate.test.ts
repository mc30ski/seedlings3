// ─────────────────────────────────────────────────────────────────────────────
// HAND-MAINTAINED MIRROR TYPES MUST MATCH WHAT THEY MIRROR.
//
// Several web client modules declare, in a comment, that they are a copy of
// an API service's types:
//
//     // Worker-workday client types — mirror services/workdays.ts exactly.
//     // Payroll client — mirrors apps/api/src/services/payroll.ts.
//
// Nothing checked that claim. The copy drifts silently, and the drift is
// invisible because BOTH sides compile: they are separate declarations that
// never meet.
//
// THIS IS THE LAYER UNDER THE DATE BUGS. On 2026-11-13 a workday left open
// on Wednesday was announced to its owner as Tuesday, and the End Workday
// dialog defaulted its time picker to 6pm on that Tuesday — before the
// workday had started — so the dialog's own before-start guard refused
// every save. The owner had to overrule the app and name a day it was
// insisting was wrong.
//
// Every layer built to prevent that sat DOWNSTREAM of this one:
//   · the canonical helpers — all four call sites used them;
//   · the 31 forbidden-pattern rules — none matched, because nothing raw
//     was written;
//   · the EtDateKey brand — which the web mirror opted out of by typing
//     the field `string`.
// The schema says `workdayDate String // YYYY-MM-DD in ET`. The mirror said
// `string`. A comment in between asserted it was an ISO datetime, and the
// code believed the comment.
//
// WHAT THIS CHECKS, AND WHAT IT DOES NOT. Top-level fields of types that
// share a NAME on both sides, compared as text after normalising
// whitespace. It does not resolve aliases, expand generics, or look inside
// nested object literals — so it is a tripwire for drift, not a proof of
// equivalence. It was written against a tree with 5 mirror pairs and 11
// shared types, where it reported exactly one difference: a declared alias
// indirection, recorded below. One signal, no noise.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";

const REPO = join(__dirname, "../../../..");
const WEB_LIB = join(REPO, "apps/web/src/lib");
const API_SRC = join(REPO, "apps/api/src");

/** "… mirrors apps/api/src/services/payroll.ts" → "services/payroll.ts". */
const DECLARES_MIRROR =
  /\/\/[^\n]*mirrors?\s+(?:apps\/api\/src\/)?((?:services|lib)\/[A-Za-z0-9_.]+\.ts)/i;

/**
 * SPELLINGS THAT MEAN THE SAME THING, declared explicitly.
 *
 * Keyed by `<TypeName>.<field>`, holding the exact text expected on each
 * side. Exact on BOTH sides on purpose: if either declaration changes, the
 * entry stops matching and the difference is reported again. An allowance
 * that survives the thing it was allowing is how a gate quietly stops
 * working — see the `DECLARED_UNLISTED` episode in G50, where a one-word
 * reason let a real bug straight back through.
 */
const EQUIVALENT: Record<string, { web: string; api: string; why: string }> = {
  "PayrollEntryView.values": {
    web: "PayrollValues",
    api: "Partial<Record<NumericField, number | null>>",
    why:
      "The same shape under two spellings: the web names the alias, the API " +
      "writes it out over its NumericField union. Comparing text cannot see " +
      "through an alias, and expanding one would mean type-checking the " +
      "comparison rather than reading it.",
  },
};

/** Top-level fields of every `export type X = { … }` in a source file. */
function exportedObjectTypes(src: string): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const m of src.matchAll(/export type (\w+) = \{/g)) {
    // Brace-counted: a field's own type may be an object literal.
    let i = m.index! + m[0].length;
    let depth = 1;
    while (i < src.length && depth > 0) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") depth--;
      i++;
    }
    const body = src
      .slice(m.index! + m[0].length, i - 1)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    const fields: Record<string, string> = {};
    let d = 0;
    let line = "";
    for (const ch of body) {
      if (ch === "{") d++;
      if (ch === "}") d--;
      if (ch === "\n" || (ch === ";" && d === 0)) {
        // Depth 0 only — a nested object's own keys are not this type's
        // fields, and reporting them would bury the real ones.
        const f = /^\s*(\w+)(\??):\s*(.+?)\s*;?\s*$/.exec(line);
        if (f && d === 0) {
          fields[f[1]] = (f[2] ? "?" : "") + f[3].replace(/\s+/g, " ").replace(/;$/, "");
        }
        line = "";
      } else line += ch;
    }
    out[m[1]] = fields;
  }
  return out;
}

type Pair = { webFile: string; apiRel: string; web: string; api: string };

function mirrorPairs(): { pairs: Pair[]; dangling: string[] } {
  const pairs: Pair[] = [];
  const dangling: string[] = [];
  for (const f of readdirSync(WEB_LIB).filter((n) => n.endsWith(".ts"))) {
    const web = readFileSync(join(WEB_LIB, f), "utf-8");
    const d = DECLARES_MIRROR.exec(web);
    if (!d) continue;
    try {
      pairs.push({ webFile: f, apiRel: d[1], web, api: readFileSync(join(API_SRC, d[1]), "utf-8") });
    } catch {
      dangling.push(`${f} says it mirrors ${d[1]}, which does not exist`);
    }
  }
  return { pairs, dangling };
}

describe("[build-gate] a mirror type matches what it says it mirrors", () => {
  it("finds the mirrors, and each one names a file that exists", () => {
    // VACUITY IS THE FAILURE MODE HERE. If the comment wording drifts —
    // "mirrors" to "based on" — this scan finds nothing and every
    // assertion below passes for that reason.
    const { pairs, dangling } = mirrorPairs();
    expect(
      pairs.length,
      "no mirror declarations found in apps/web/src/lib — either they were " +
        "all removed, or the comment wording changed and this gate is now " +
        "checking nothing",
    ).toBeGreaterThanOrEqual(4);
    expect(
      dangling,
      "a file claims to mirror an API module that is not there — the module " +
        "moved or was renamed, and the copy is now mirroring nothing",
    ).toEqual([]);
  });

  it("every shared type agrees field for field", () => {
    const { pairs } = mirrorPairs();
    let compared = 0;
    const drift: string[] = [];

    for (const p of pairs) {
      const web = exportedObjectTypes(p.web);
      const api = exportedObjectTypes(p.api);
      for (const name of Object.keys(web).filter((n) => api[n])) {
        compared++;
        const keys = new Set([...Object.keys(web[name]), ...Object.keys(api[name])]);
        for (const k of keys) {
          const w = web[name][k];
          const a = api[name][k];
          if (w === a) continue;
          const allowed = EQUIVALENT[`${name}.${k}`];
          if (allowed && allowed.web === w && allowed.api === a) continue;
          drift.push(
            `${p.webFile} ↔ ${p.apiRel}  ${name}.${k}\n` +
              `      web: ${w ?? "(field absent)"}\n` +
              `      api: ${a ?? "(field absent)"}`,
          );
        }
      }
    }

    expect(
      compared,
      "fewer shared types than the required mirrors carry — the files are " +
        "still declared but their type NAMES have diverged, so this gate is " +
        "comparing less than it was written to compare",
    ).toBeGreaterThanOrEqual(11);
    expect(
      drift,
      "A web client type has drifted from the API type it says it mirrors. " +
        "Both sides compile, because they are separate declarations that " +
        "never meet — which is why this has to be checked rather than " +
        "noticed. Make them agree, or, if the two spellings genuinely mean " +
        "the same thing, record it in EQUIVALENT with both exact texts.",
    ).toEqual([]);
  });

  it("no equivalence outlives the difference it was allowing", () => {
    // A stale entry is worse than none: it reads as a rule, and it silences
    // a real difference if the field later drifts INTO the allowed spelling
    // on one side.
    const { pairs } = mirrorPairs();
    const seen = new Set<string>();
    for (const p of pairs) {
      const web = exportedObjectTypes(p.web);
      const api = exportedObjectTypes(p.api);
      for (const name of Object.keys(web).filter((n) => api[n])) {
        for (const k of Object.keys({ ...web[name], ...api[name] })) {
          const e = EQUIVALENT[`${name}.${k}`];
          if (e && e.web === web[name][k] && e.api === api[name][k]) seen.add(`${name}.${k}`);
        }
      }
    }
    const stale = Object.keys(EQUIVALENT).filter((k) => !seen.has(k));
    expect(
      stale,
      "an EQUIVALENT entry that no longer describes a real difference — " +
        "either the two sides now agree, or one of them changed and the " +
        "entry is silencing something it was never written for. Delete it.",
    ).toEqual([]);
  });
});
