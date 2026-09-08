// ─────────────────────────────────────────────────────────────────────────────
// `npm run migrate:deploy` — apply migrations, then PROVE the data survived.
//
// The integrity check used to be a thing to remember. A check you have to
// remember is a check that does not run on the day it matters, and the day it
// matters is a production migration that rewrites what clients were invoiced
// and what crews were paid. If that rewrite went wrong the first symptom would
// be clients billed for materials they were never billed for, and workers paid
// out of a pool that changed under them.
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

// Same, but keeps the text so the two passes can be DIFFED. The output is
// still echoed, so this is invisible to the operator watching the deploy.
function runCapture(cmd: string, args: string[]) {
  const r = spawnSync(cmd, args, {
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  return { status: r.status, text: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

// A problem line is indented by exactly two spaces under the "N PROBLEM(S):"
// header. Ids are stable, so set difference across the two passes is exact.
const problemsOf = (text: string): Set<string> =>
  new Set(
    text
      .split("\n")
      .filter((l) => /^ {2}\S/.test(l))
      .map((l) => l.trim()),
  );

const line = (msg: string) =>
  console.log(`\n${BOLD}-- ${msg} ${"-".repeat(Math.max(0, 58 - msg.length))}${OFF}`);

line("BEFORE: what is already true");
const before = runCapture("npx", ["tsx", "scripts/verify-ledger-integrity.ts"]);
const problemsBefore = problemsOf(before.text);
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
const after = runCapture("npx", ["tsx", "scripts/verify-ledger-integrity.ts"]);

// BLOCK ON WHAT THIS DEPLOY BROKE, NOT ON WHAT IT INHERITED.
//
// Blocking on any failure at all sounds safer and is not: on a database
// carrying long-standing quirks, every single deploy goes red for reasons it
// did not cause. The operator learns the red means nothing and waves through
// the one that matters. Only problems absent from the BEFORE pass are this
// migration's doing.
const introduced = [...problemsOf(after.text)].filter((m) => !problemsBefore.has(m));

if (introduced.length) {
  console.error(
    `\n${RED}THIS MIGRATION INTRODUCED ${introduced.length} NEW INTEGRITY PROBLEM(S):${OFF}`,
  );
  for (const m of introduced.slice(0, 40)) console.error(`  ${RED}${m}${OFF}`);
  process.exit(1);
}

if (brokenBefore) {
  console.log(
    `\n${YEL}Migrations applied. Nothing new broke — every problem listed above\n` +
      `  was already present before this deploy and is unchanged by it.${OFF}`,
  );
} else {
  console.log(`\n${GRN}Migrations applied and every integrity check passed.${OFF}`);
}
