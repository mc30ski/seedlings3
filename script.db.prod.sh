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

# ── WHAT WOULD ACTUALLY RUN ─────────────────────────────────────────────────
# Read-only, and the only honest way to answer "what is this about to do".
# Deciding from the local migrations folder would be a guess about production.
echo "${BOLD}── Pending on production ────────────────────────────────────${OFF}"
DATABASE_URL="$PROD_URL" npm -w apps/api exec -- prisma migrate status || true
echo ""

echo "If something goes wrong, Neon can restore:"
echo "  Console → Branches → main → Restore → pick a timestamp (24h retention)"
echo ""

# A typed phrase, not y/N. Removing the .env chore removed the pause that came
# with it, so the remaining gate has to be one you cannot hit by reflex.
read -r -p "Type ${BOLD}MIGRATE PRODUCTION${OFF} to proceed: " confirm
[[ "$confirm" == "MIGRATE PRODUCTION" ]] || die "Aborted — nothing was run."

echo ""
echo "${BOLD}── Generating client ────────────────────────────────────────${OFF}"
npm -w apps/api run prisma:generate

echo ""
echo "${BOLD}── Migrating ────────────────────────────────────────────────${OFF}"
# `migrate:deploy`, NOT `prisma:migrate:deploy`: it verifies ledger integrity
# before and after and fails on problems THIS deploy introduced, diffing the
# two passes so long-standing quirks do not turn every promotion red.
# See apps/api/scripts/migrate-deploy.ts.
DATABASE_URL="$PROD_URL" npm -w apps/api run migrate:deploy

# ── The promise, checked rather than asserted ───────────────────────────────
ENV_SUM_AFTER="$(shasum "$ENV_FILE" | cut -d' ' -f1)"
if [[ "$ENV_SUM_BEFORE" != "$ENV_SUM_AFTER" ]]; then
  die "$ENV_FILE changed during this run. It should not have — check it before continuing."
fi

echo ""
echo "${GRN}✅ Production migration complete.${OFF}"
echo "   $ENV_FILE is unchanged; your local commands still point at $ACTIVE_LABEL."
