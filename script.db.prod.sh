# from the repo root
# 1) generate client (good practice before deploy)
DATABASE_URL="postgres://<user>:<pass>@<host>/<db>?branch=production&sslmode=require" \
  npm -w apps/api run prisma:generate

# 2) apply committed migrations to prod (no new files created)
DATABASE_URL="postgres://<user>:<pass>@<host>/<db>?branch=production&sslmode=require" \
  npm -w apps/api run prisma:migrate:deploy

# 3) optional: verify status against prod
DATABASE_URL="postgres://<user>:<pass>@<host>/<db>?branch=production&sslmode=require" \
  npx prisma migrate status --schema apps/api/prisma/schema.prisma