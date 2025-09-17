rm -rf node_modules
find . -name "node_modules" -type d -prune -exec rm -rf {} +
rm -rf .turbo .next dist .vercel .cache
rm -rf apps/**/.next apps/**/dist apps/**/.turbo
rm -f package-lock.json
npm cache clean --force