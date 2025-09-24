# API (Fastify + Prisma)

- Serverless Functions on Vercel (Fastify + Prisma)

## DB (Neon postgresql)

- Dev
  npm run prisma:generate
  npm run prisma:migrate:dev
  npm run db:seed

- Production/CI:
  npm run prisma:generate
  npm run prisma:migrate:deploy
  npm run db:seed
