// ─────────────────────────────────────────────────────────────────────────────
// `npm run migrate:deploy` — apply migrations, then PROVE the data survived.
//
// The integrity check used to be a thing to remember. A check you have to
// remember is a check that does not run on the day it matters, and the day it
// matters is a production migration that backfills every historical occurrence
// to LEGACY. If that backfill went wrong the first symptom would be clients
// billed for materials they were never billed for, and workers paid out of a
// pool that changed under them.
//
// So it runs here, automatically, and a failure is a non-zero exit.
//
// ORDER: verify -> migrate -> verify.
//
//   The FIRST pass is INFORMATIONAL. It establishes what was already true, so
//   a pre-existing problem is not mistaken for one this migration caused —
//   that distinction is the whole reason to look before as well as after. It
//   never blocks: refusing to migrate because of damage that predates the
//   migration would strand you with no way forward.
//
//   The SECOND pass BLOCKS. Anything broken now that was not broken before is
//   this deploy's doing.
//
// The verification is read-only, so it is safe against production — which is
// the only place it is worth running.
// ─────────────────────────────────────────────────────────────────────────────
import { spawnSync } from "node:child_process";

const BOLD = "\u001b[1m", RED = "\u001b[31m", YEL = "\u001b[33m", GRN = "\u001b[32m", OFF = "\u001b[0m";

const run = (cmd: string, args: string[]) =>
  spawnSync(cmd, args, { stdio: "inherit", shell: process.platform === "win32" });

const line = (msg: string) =>
  console.log(`\n${BOLD}-- ${msg} ${"-".repeat(Math.max(0, 58 - msg.length))}${OFF}`);

line("BEFORE: what is already true");
const before = run("npx", ["tsx", "scripts/verify-ledger-integrity.ts"]);
const brokenBefore = before.status !== 0;
if (brokenBefore) {
  console.warn(
    `\n${YEL}! The database already had integrity problems before this migration.\n` +
      `  Not blocking — refusing to migrate would leave you stuck. They are\n` +
      `  listed above so they are not blamed on this deploy.${OFF}`,
  );
}

line("MIGRATE");
const migrated = run("npx", ["prisma", "migrate", "deploy"]);
if (migrated.status !== 0) {
  console.error(`\n${RED}Migration failed. Nothing further ran.${OFF}`);
  process.exit(migrated.status ?? 1);
}

line("AFTER: did the data survive");
const after = run("npx", ["tsx", "scripts/verify-ledger-integrity.ts"]);
if (after.status !== 0) {
  console.error(
    `\n${RED}INTEGRITY CHECK FAILED AFTER MIGRATING.` +
      (brokenBefore
        ? "\n  Some of this predates the migration — compare against the BEFORE pass."
        : "\n  The database was clean before this migration and is not now.") +
      OFF,
  );
  process.exit(after.status ?? 1);
}
console.log(`\n${GRN}Migrations applied and every integrity check passed.${OFF}`);
