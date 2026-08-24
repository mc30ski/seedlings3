#!/usr/bin/env bash
# Post-deploy check for the vercel.json rewrite fix.
#
#   ./verify-rewrites.sh https://seedlings.team
#
# Checks PAYMENTS FIRST. If the payment section fails, revert immediately:
#   git revert <commit> -- apps/web/vercel.json   (or restore the 2 lines)
# and redeploy. Nothing else is in that change.

set -u
B="${1:-https://seedlings.team}"
fail=0

hit() { curl -s -o /tmp/_vr.txt -w "%{http_code}" --max-time 30 "$@" 2>/dev/null; }
body() { head -c 70 /tmp/_vr.txt | tr -d '\n'; }

echo "Verifying $B"
echo
echo "── PAYMENTS (must all pass — these are untouched by the fix) ─────────"

# 1. The pay page itself: a Next.js page, no rewrite involved at all.
c=$(hit "$B/pay/faketoken")
[ "$c" = "200" ] && echo "  PASS  pay page loads (200)" || { echo "  FAIL  pay page -> $c"; fail=1; }

# 2. Invoice data. Handler-level 'not_found' for a bogus token is CORRECT —
#    it proves the route matched. Fastify's "Route ... not found" would mean
#    the prefix broke.
c=$(hit "$B/api/_proxy/api/public/pay/faketoken")
case "$(body)" in
  *'"error":"not_found"'*) echo "  PASS  invoice endpoint reachable (handler ran)" ;;
  *'Route GET'*)           echo "  FAIL  invoice endpoint lost its prefix: $(body)"; fail=1 ;;
  *)                       echo "  WARN  unexpected: $c $(body)" ;;
esac

# 3. Self-report — the actual "I paid" submission.
c=$(hit -X POST -H 'content-type: application/json' -d '{}' \
     "$B/api/_proxy/api/public/pay/faketoken/self-report")
case "$(body)" in
  *'Route GET'*|*'Route POST'*) echo "  FAIL  self-report lost its prefix: $(body)"; fail=1 ;;
  *)                            echo "  PASS  self-report reachable (handler ran)" ;;
esac

# 4. The app's own API path — every authenticated screen depends on this.
c=$(hit "$B/api/_proxy/api/public/branding")
[ "$c" = "200" ] && echo "  PASS  app API path (rule 1) intact (200)" \
                 || { echo "  FAIL  app API path -> $c $(body)"; fail=1; }

echo
echo "── THE FIX (should now work; were 404 before) ───────────────────────"

c=$(hit "$B/mo/fall-services-2026")
[ "$c" = "200" ] && echo "  PASS  /mo/ shortlink resolves (200)" \
                 || echo "  ....  /mo/ -> $c  (fix not live yet, or slug changed)"

c=$(hit "$B/api/public/branding")
[ "$c" = "200" ] && echo "  PASS  /api/public/* resolves (200)" \
                 || echo "  ....  /api/public/branding -> $c  (fix not live yet)"

echo
if [ "$fail" -ne 0 ]; then
  echo "PAYMENT CHECKS FAILED — revert apps/web/vercel.json and redeploy."
  exit 1
fi
echo "Payments OK."
