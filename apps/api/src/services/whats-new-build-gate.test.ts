// ─────────────────────────────────────────────────────────────────────────────
// WHAT'S NEW build gate
//
// The announcement registry (`apps/web/src/lib/whatsNew.ts`) is the one file
// a new feature edits to announce itself, which makes it the one file where
// a typo is invisible. EVERY failure mode here is silent:
//
//   • a `requires` naming an entitlement that does not exist — `can()`
//     returns false for an unknown string, so the entry is shown to NOBODY,
//     for ever, and nothing anywhere says so;
//   • a `showMe.tab` naming a tab that does not exist — "Show me" dispatches
//     a navigation that resolves to nothing, so the button does nothing;
//   • a duplicated id — the second entry is suppressed the moment anybody
//     answers the first, for everybody who answered it;
//   • an id that does not match the server's own key format — the POST is
//     rejected 400, the bar never records, and it returns every single load.
//
// None of them throws. All of them look like "the feature shipped and the
// announcement just didn't appear", which is indistinguishable from nobody
// having written one. Hence a gate.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join, resolve } from "path";
import { ENTITLEMENTS } from "@repo/permissions";
import { WHATS_NEW, nextAnnouncement } from "@/src/lib/whatsNew";
import { TAB_REQUIREMENTS } from "@/src/lib/tabRequirements";

/** The server's own validation, copied here so the two cannot drift apart
 *  without this failing. See `services/featureAnnouncements.ts`. */
const SERVER_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

const WEB = resolve(__dirname, "../../../web");

describe("whats-new build gate", () => {
  it("the registry is not empty and the server's id rule accepts every id", () => {
    expect(WHATS_NEW.length, "no announcements at all — did the registry move?").toBeGreaterThan(0);
    for (const e of WHATS_NEW) {
      expect(
        SERVER_ID_RE.test(e.id),
        `"${e.id}" is not a shape the server accepts, so POSTing it 400s, the row is never written, and the bar returns on every load for ever. Lower-case letters, digits and hyphens.`,
      ).toBe(true);
    }
  });

  it("no id is used twice", () => {
    const ids = WHATS_NEW.map((e) => e.id);
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    expect(
      dupes,
      `an announcement id is the only record that somebody has been told. Reusing one means the second change is announced to nobody who answered the first: ${dupes.join(", ")}`,
    ).toEqual([]);
  });

  it("every `requires` names a real entitlement", () => {
    // ENTITLEMENTS is already the flat list of ids. Reading `.id` off each
    // string gave a set of `undefined` and flagged every entry — a gate that
    // fails for its own reason teaches people to edit the gate.
    const known = new Set<string>(ENTITLEMENTS);
    expect(known.size, "the entitlement list came back empty — this gate is comparing against nothing").toBeGreaterThan(20);
    const bad = WHATS_NEW
      .filter((e) => e.requires !== null && !known.has(e.requires))
      .map((e) => `${e.id} → ${e.requires}`);
    expect(
      bad,
      "`can()` answers false for a capability nobody holds BECAUSE IT DOES NOT EXIST, so the entry is shown to no one and never fails. Take the name from docs/features/permissions-ROUTE-MAP.md — the capability the feature's own endpoint is guarded on.\n" +
        bad.join("\n"),
    ).toEqual([]);
  });

  it("every `showMe` names a real tab", () => {
    const tabs = new Set(Object.keys(TAB_REQUIREMENTS));
    const bad = WHATS_NEW
      .filter((e) => e.showMe && !tabs.has(e.showMe.tab))
      .map((e) => `${e.id} → ${e.showMe!.tab}`);
    expect(
      bad,
      "the `navigate:staffTab` handler ignores a tab it does not know, so \"Show me\" would be a button that does nothing at all.\n" + bad.join("\n"),
    ).toEqual([]);
  });

  it("the capability gate actually withholds", () => {
    const gated = { id: "x-gated", headline: "h", body: "b", requires: "books.manage", shippedOn: "2026-01-01" };
    const open = { id: "x-open", headline: "h", body: "b", requires: null, shippedOn: "2026-01-01" };
    const pick = (entries: any[], caps: string[]) => {
      const real = WHATS_NEW.slice();
      WHATS_NEW.length = 0;
      WHATS_NEW.push(...(entries as any));
      try {
        return nextAnnouncement(new Set<string>(), (c) => caps.includes(c))?.id ?? null;
      } finally {
        WHATS_NEW.length = 0;
        WHATS_NEW.push(...real);
      }
    };
    expect(pick([gated], []), "an entry was offered to somebody without its capability").toBeNull();
    expect(pick([gated], ["books.manage"])).toBe("x-gated");
    expect(pick([open], []), "`requires: null` must reach everybody").toBe("x-open");
    // And it must SKIP PAST a gated one to reach a later one they can see.
    expect(pick([gated, open], []), "a gated entry must not block the ones behind it").toBe("x-open");
  });

  it("one at a time, oldest outstanding first", () => {
    const mk = (id: string) => ({ id, headline: "h", body: "b", requires: null, shippedOn: "2026-01-01" });
    const real = WHATS_NEW.slice();
    WHATS_NEW.length = 0;
    // The file is newest-first for whoever edits it.
    WHATS_NEW.push(mk("newest") as any, mk("middle") as any, mk("oldest") as any);
    try {
      expect(nextAnnouncement(new Set(), () => true)?.id, "somebody away a fortnight should meet the changes in the order they happened").toBe("oldest");
      expect(nextAnnouncement(new Set(["oldest"]), () => true)?.id).toBe("middle");
      expect(nextAnnouncement(new Set(["oldest", "middle", "newest"]), () => true)).toBeNull();
      // A row for an entry that has since been deleted is harmless.
      expect(nextAnnouncement(new Set(["gone-long-ago"]), () => true)?.id).toBe("oldest");
    } finally {
      WHATS_NEW.length = 0;
      WHATS_NEW.push(...real);
    }
  });

  // THE BUG THIS GATE DID NOT CATCH THE FIRST TIME.
  //
  // The original version checked that `showMe.tab` was a real tab, and it
  // was — so the gate passed while "Show me" did, for most people, nothing
  // at all: they were already ON the Jobs tab, so the navigation was a no-op
  // and the bar simply vanished. Checking that a destination exists is not
  // the same as checking that pressing the button changes anything.
  //
  // So the destination must also contain something to POINT at, tagged with
  // this entry's own id. An entry with genuinely no single control says so
  // with `spotlight: false` rather than being allowed to say nothing.
  it("every `showMe` has a control to ring", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.name === "node_modules" || e.name === ".next" || e.name === "tests") continue;
        const full = join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name.endsWith(".tsx")) files.push(full);
      }
    };
    walk(join(WEB, "src"));
    walk(join(WEB, "pages"));
    const src = files.map((f) => readFileSync(f, "utf8")).join("\n");
    expect(src.length, "read no web source — this gate is checking nothing").toBeGreaterThan(1000);

    const bad = WHATS_NEW
      .filter((e) => e.showMe && e.showMe.spotlight !== false)
      .filter((e) => !src.includes(`data-whats-new="${e.id}"`))
      .map((e) => e.id);
    expect(
      bad,
      'nothing in the app is tagged `data-whats-new="<id>"` for these, so "Show me" takes somebody to a tab and then points at nothing — and for anybody already on that tab it does nothing whatsoever. Tag the control, or set `spotlight: false` if there is genuinely no single thing to point at.\n' +
        bad.join("\n"),
    ).toEqual([]);
  });

  it("the bar is mounted in the shell, outside any one tab", () => {
    const shell = readFileSync(join(WEB, "pages/index.tsx"), "utf8");
    expect(
      shell,
      "WhatsNewBar must be mounted in the app shell. Inside a tab it only announces a change to somebody who happens to open that tab — and the change being announced is usually somewhere else.",
    ).toMatch(/<WhatsNewBar/);
  });
});
