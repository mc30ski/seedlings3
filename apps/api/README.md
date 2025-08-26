# API (Fastify + Prisma)

## Local

```bash
cp .env.example .env
npm install
npm run dev
```

## Deploy to Cloud Run (via GitHub Actions)

- Add GitHub secrets:
  - `GCP_SA_JSON` – service account JSON with Cloud Run + Artifact Registry permissions
  - `GCP_PROJECT` – your GCP project ID
  - `GCP_REGION` – e.g. `us-central1`
  - `DATABASE_URL`, `CLERK_SECRET_KEY`, `CLERK_JWT_VERIFICATION_KEY`
- On push to `main` touching `apps/api/**`, the action will:
  1. Build and push an image
  2. Deploy Cloud Run service `api`
  3. Run `prisma migrate deploy` in the container
- URL:
  - https://seedlings3-1000564298660.us-east1.run.app/hello

## Deploy to Vercel

- URL:
  - https://seedlings3-web.vercel.app
