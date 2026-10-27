#!/usr/bin/env bash
# One persona per run, database reseeded between them.
#
# These specs write real rows. Run back to back without a reset and each
# persona acts on what the last one changed, so a failure cannot be
# attributed. Reseeding between them costs a couple of minutes per persona
# and buys an attributable result.
set -uo pipefail
cd "$(dirname "$0")/.."
# Keys must match SeedUserKey in tests/e2e/helpers/db.ts. They were `super`
# and `admin` until the Playwright projects were renamed; `persona()` skips
# every test when MUTATION_PERSONA matches no persona, so those two rounds
# reported "passed" having run nothing.
PERSONAS=(owner bookkeeper payroll coordinator trainee contractor employee scheduler unpaid)
rc=0
for p in "${PERSONAS[@]}"; do
  echo "=== PERSONA $p ==="
  MUTATION_PERSONA="$p" npx playwright test --project=persona-mutations --no-deps 2>&1 \
    | grep -E "✓|✘|passed|failed|Error:|expect" | head -40
  [ "${PIPESTATUS[0]}" -ne 0 ] && rc=1
  echo "--- reseeding after $p ---"
  (cd ../api && npm run db:seed >/dev/null 2>&1) && echo "reseeded" || { echo "RESEED FAILED"; rc=1; }
done
echo "=== ROUND COMPLETE (rc=$rc) ==="
exit $rc
