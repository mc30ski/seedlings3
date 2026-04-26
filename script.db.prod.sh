#!/bin/bash
set -e

echo "╔══════════════════════════════════════════════════════════╗"
echo "║  PRODUCTION DATABASE MIGRATION                          ║"
echo "║  This will run prisma migrate deploy against PRODUCTION ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""
echo "Make sure you have updated apps/api/.env:"
echo "  DATABASE_URL must point to the 'production' branch (ep-noisy-feather)"
echo ""
echo "If something goes wrong, use Neon's Restore feature:"
echo "  Console → Branches → main → Restore → pick a timestamp (24h retention)"
echo ""
read -p "Have you switched DATABASE_URL to production? [y/N] " confirm
if [[ "$confirm" != "y" && "$confirm" != "Y" ]]; then
  echo "Aborted."
  exit 1
fi

echo ""
echo "── Running migration... ──"
npm -w apps/api run prisma:generate
npm -w apps/api run prisma:migrate:deploy

echo ""
echo "✅ Migration complete!"
echo ""
echo "── IMPORTANT: Switch DATABASE_URL back to development branch (ep-jolly-wildflower) ──"
echo ""
read -p "Press [RETURN] when you've switched back to dev " _
echo "Done."
