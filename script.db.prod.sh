#!/bin/bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# PROMOTE MIGRATIONS TO PRODUCTION
#
# This used to require hand-editing apps/api/.env — comment out dev, uncomment
# prod, run, then remember to put it back. That is a bad way to gate a
# production write for two reasons: forgetting the last step leaves every
# subsequent local command silently pointed at production, and the edit itself
# is not a safety check, just a chore that feels like one.
#
# The URL is now taken from .env WITHOUT MODIFYING IT and handed to the
# migrate command alone, as an environment variable scoped to that one process.
# Nothing else in the shell, and no later command, sees it.
#
# The prod URL is identified BY ITS HOST, not by which line happens to be
# commented out — so it works whichever way round the file is left, and it
# cannot pick up the dev branch by accident.
# ─────────────────────────────────────────────────────────────────────────────

ENV_FILE="apps/api/.env"

# The Neon branch endpoints. If these ever change, change them here — the
# script refuses to run rather than guess.
PROD_HOST="ep-noisy-feather"
DEV_HOST="ep-jolly-wildflower"

RED=$'\033[31m'; GRN=$'\033[32m'; YEL=$'\033[33m'; BOLD=$'\033[1m'; OFF=$'\033[0m'

die() { echo "${RED}✗ $1${OFF}" >&2; exit 1; }

[[ -f "$ENV_FILE" ]] || die "$ENV_FILE not found. Run this from the repo root."

# Every postgres URL in the file, commented or not, then the one on the prod
# host. `grep -o` ignores whether the line is active, which is the point.
PROD_URL="$(grep -oE 'postgres(ql)?://[^"[:space:]]+' "$ENV_FILE" | grep -m1 -- "$PROD_HOST" || true)"

[[ -n "$PROD_URL" ]] || die "No connection string for the production host ($PROD_HOST) in $ENV_FILE."
[[ "$PROD_URL" == *"$PROD_HOST"* ]] || die "Refusing: the resolved URL is not on the production host."
[[ "$PROD_URL" != *"$DEV_HOST"* ]] || die "Refusing: the resolved URL also matches the DEV host."

# ── THE DIRECT URL IS NOT OPTIONAL HERE ─────────────────────────────────────
#
# prisma/schema.prisma declares `directUrl = env("DIRECT_URL")`, so every
# Schema Engine command below reads DIRECT_URL and IGNORES DATABASE_URL for
# the connection it migrates. Setting only DATABASE_URL would therefore let
# the dev DIRECT_URL in .env through from the environment — and this script
# would migrate DEV while printing PRODUCTION at every step. Both variables
# are set together, always, for exactly that reason.
#
# Derived from PROD_URL rather than grepped separately so the two can never
# name different branches: the direct host is the pooled host without the
# `-pooler` suffix.
PROD_DIRECT_URL="${PROD_URL/-pooler/}"

[[ "$PROD_DIRECT_URL" != "$PROD_URL" ]] || die "Refusing: the production URL has no -pooler suffix to strip, so the direct URL cannot be derived. Set it by hand in $ENV_FILE and update this script."
[[ "$PROD_DIRECT_URL" == *"$PROD_HOST"* ]] || die "Refusing: the derived direct URL is not on the production host."
[[ "$PROD_DIRECT_URL" != *"$DEV_HOST"* ]] || die "Refusing: the derived direct URL matches the DEV host."
[[ "$PROD_DIRECT_URL" != *-pooler* ]] || die "Refusing: the derived direct URL still points at a pooler."

# What .env is CURRENTLY pointed at — shown so it is obvious this script is not
# touching it, and so a surprise here gets noticed before anything runs.
ACTIVE_URL="$(grep -m1 -E '^[[:space:]]*DATABASE_URL=' "$ENV_FILE" | sed -E 's/^[^=]*=//; s/^"//; s/"$//' || true)"
case "$ACTIVE_URL" in
  *"$DEV_HOST"*) ACTIVE_LABEL="${GRN}dev${OFF} ($DEV_HOST)" ;;
  *"$PROD_HOST"*) ACTIVE_LABEL="${RED}PRODUCTION${OFF} ($PROD_HOST)" ;;
  *) ACTIVE_LABEL="${YEL}unrecognised${OFF}" ;;
esac

# Proves the promise at the end: .env must be byte-identical afterwards.
ENV_SUM_BEFORE="$(shasum "$ENV_FILE" | cut -d' ' -f1)"

echo "╔══════════════════════════════════════════════════════════╗"
echo "║  ${BOLD}PROMOTE MIGRATIONS TO PRODUCTION${OFF}                        ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""
echo "  Target      : ${RED}${BOLD}PRODUCTION${OFF} ($PROD_HOST)"
echo "  Your .env   : $ACTIVE_LABEL — left untouched, no edit needed"
echo ""

# ── A PREVIOUS RUN MAY HAVE LEFT THE LEDGER WEDGED ──────────────────────────
#
# When a migration fails, Postgres rolls ITS transaction back whole — nothing
# of it reaches the database — but the ledger keeps a row saying it was
# attempted, and that row refuses every later migration with P3018 until it
# is resolved. The database is not damaged; it is blocked.
#
# `prisma migrate status` DOES NOT MENTION THIS. It lists the failed one
# under "not yet applied", identical to one never attempted — so without the
# check below you see a normal pending list, run deploy, and meet P3018 with
# no warning. That is how this script wasted a maintenance window once.
#
# Exit 2 from the detector means it could not look (no connection). That is
# not "clean" and must not be treated as such.
echo "${BOLD}── Checking for a previously failed migration ───────────────${OFF}"
set +e
FAILED="$(DATABASE_URL="$PROD_URL" DIRECT_URL="$PROD_DIRECT_URL" \
  npx tsx apps/api/scripts/failed-migrations.ts --porcelain 2>/dev/null)"
FAILED_STATUS=$?
set -e
[[ $FAILED_STATUS -eq 0 ]] || die "Could not read the migration ledger on production. Not proceeding — a failed migration here would be invisible."

# NAMES ARE COLLECTED FIRST, then acted on. The interactive version of this
# read from `<<< "$FAILED"` *inside* the loop, so the `read` prompting for a
# migration name took its input from the migration list rather than the
# keyboard, hit EOF immediately, and `set -e` killed the script mid-prompt.
# Parsing and prompting must not share a stdin.
FAILED_NAMES=()
FAILED_ERRS=()
while IFS=$'\t' read -r mname merr; do
  [[ -n "$mname" ]] || continue
  FAILED_NAMES+=("$mname")
  FAILED_ERRS+=("$merr")
done <<< "$FAILED"

if [[ ${#FAILED_NAMES[@]} -gt 0 ]]; then
  echo ""
  echo "${YEL}⚠ A previous run left these unresolved:${OFF}"
  echo ""
  for i in "${!FAILED_NAMES[@]}"; do
    echo "  ${BOLD}${FAILED_NAMES[$i]}${OFF}"
    echo "    ${FAILED_ERRS[$i]}"
  done
  echo ""
  echo "  Nothing from it is in the database — Postgres rolled it back."
  echo "  The ledger row is what blocks everything after it."
  echo ""
  echo "  ${BOLD}r${OFF}) retry  — clear and run it again. If its check was RIGHT,"
  echo "           it simply fails again; this cannot bypass anything."
  echo "  ${BOLD}s${OFF}) skip   — mark applied WITHOUT running it. Only when you have"
  echo "           read the migration and know it is a no-op for THIS data."
  echo "  ${BOLD}a${OFF}) abort"
  echo ""
  # `< /dev/tty` on every prompt: belt and braces, so a future edit that puts
  # one of these back inside a redirected loop cannot resurrect the bug.
  read -r -p "Choose [r/s/a]: " choice < /dev/tty

  case "$choice" in
    r|R)
      # ALWAYS SAFE, which is why it needs no extra ceremony: this only lets
      # the migration run again, guard and all.
      for mname in "${FAILED_NAMES[@]}"; do
        echo "  clearing $mname for retry..."
        DATABASE_URL="$PROD_URL" DIRECT_URL="$PROD_DIRECT_URL" \
          npm -w apps/api exec -- prisma migrate resolve --rolled-back "$mname" < /dev/null
      done
      ;;
    s|S)
      # NEVER automatic, and never in bulk. Marking a migration applied when
      # it did not run declares its check satisfied on your word — so the
      # name is typed out in full, one at a time, by someone who has read it.
      for mname in "${FAILED_NAMES[@]}"; do
        echo ""
        echo "  To SKIP ${BOLD}${mname}${OFF} without running it,"
        echo "  type its full name below (or press enter to retry it instead)."
        read -r -p "  name: " typed < /dev/tty
        if [[ "$typed" == "$mname" ]]; then
          DATABASE_URL="$PROD_URL" DIRECT_URL="$PROD_DIRECT_URL" \
            npm -w apps/api exec -- prisma migrate resolve --applied "$mname" < /dev/null
          echo "  ${YEL}marked applied without running.${OFF}"
        else
          echo "  name did not match — clearing it for retry instead."
          DATABASE_URL="$PROD_URL" DIRECT_URL="$PROD_DIRECT_URL" \
            npm -w apps/api exec -- prisma migrate resolve --rolled-back "$mname" < /dev/null
        fi
      done
      ;;
    *) die "Aborted — the ledger is untouched and nothing was run." ;;
  esac
  echo ""
else
  echo "  none — the ledger is clean."
  echo ""
fi

# ── WHAT WOULD ACTUALLY RUN ─────────────────────────────────────────────────
# Read-only, and the only honest way to answer "what is this about to do".
# Deciding from the local migrations folder would be a guess about production.
echo "${BOLD}── Pending on production ────────────────────────────────────${OFF}"
DATABASE_URL="$PROD_URL" DIRECT_URL="$PROD_DIRECT_URL" npm -w apps/api exec -- prisma migrate status || true
echo ""

echo "If something goes wrong, Neon can restore:"
echo "  Console → Branches → production → Restore → pick a timestamp."
echo "  How far back that reaches is Settings → Postgres → History window."
echo "  Instant restore works on ROOT branches only — a child branch is a"
echo "  copy to test against, not a one-click way back."
echo ""

# A typed phrase, not y/N. Removing the .env chore removed the pause that came
# with it, so the remaining gate has to be one you cannot hit by reflex.
read -r -p "Type ${BOLD}MIGRATE PRODUCTION${OFF} to proceed: " confirm < /dev/tty
if [[ "$confirm" != "MIGRATE PRODUCTION" ]]; then
  # NOT "nothing was run". If a failed migration was resolved above, the
  # ledger has already changed — saying otherwise here would send someone
  # looking for a clean database that is not there.
  if [[ ${#FAILED_NAMES[@]} -gt 0 ]]; then
    die "Aborted before migrating. NOTE: the ${#FAILED_NAMES[@]} failed migration(s) above were already resolved, so the ledger is no longer blocked — re-run when ready."
  fi
  die "Aborted — nothing was run."
fi

echo ""
echo "${BOLD}── Generating client ────────────────────────────────────────${OFF}"
npm -w apps/api run prisma:generate

echo ""
echo "${BOLD}── Migrating ────────────────────────────────────────────────${OFF}"
# `migrate:deploy`, NOT `prisma:migrate:deploy`: it verifies ledger integrity
# before and after and fails on problems THIS deploy introduced, diffing the
# two passes so long-standing quirks do not turn every promotion red.
# See apps/api/scripts/migrate-deploy.ts.
DATABASE_URL="$PROD_URL" DIRECT_URL="$PROD_DIRECT_URL" npm -w apps/api run migrate:deploy

# ── The promise, checked rather than asserted ───────────────────────────────
ENV_SUM_AFTER="$(shasum "$ENV_FILE" | cut -d' ' -f1)"
if [[ "$ENV_SUM_BEFORE" != "$ENV_SUM_AFTER" ]]; then
  die "$ENV_FILE changed during this run. It should not have — check it before continuing."
fi

echo ""
echo "${GRN}✅ Production migration complete.${OFF}"
echo "   $ENV_FILE is unchanged; your local commands still point at $ACTIVE_LABEL."
