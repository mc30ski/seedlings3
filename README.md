# seedlings3 Monorepo

Monorepo managed with Turborepo.

- **Web**: Next.js + Chakra UI (deployed on Vercel)
- **API**: Fastify (TypeScript) + Prisma + Neon (deploy on Vercel using Serverless Functions)
- **Mobile**: Expo (React Native) + React Native Paper

## Quickstart

```bash
npm install
npm run dev
```

- Web: `apps/web` on http://localhost:3000
- API: `apps/api` on http://localhost:8080
- Mobile: `apps/mobile` via `npx expo start` (or `npm run dev` inside `apps/mobile`)

## Environments & Deployment

We use Vercel for both **web** and **api**. There are three environments:

- **Production** – deploys from the **Production Branch** (`prod-dummy-prod-promote-via-preview`)
- **Preview** – deploys from any non-production branch (e.g. `main`, feature branches, PRs)
- **Development** – used locally with `vercel dev` / `.env.local`; not used in cloud builds

### Branch strategy

- `main` → **Preview** deployments for both projects
- `prod-dummy-prod-promote-via-preview` → **Production** deployments for both projects  
  (either push/merge to this branch or use “Promote to Production” in Vercel which rebuilds with Production env vars)

### Project wiring (Vercel)

Create **two** Vercel projects pointing at this repo:

| Project          | Root Directory | Notes                                |
| ---------------- | -------------- | ------------------------------------ |
| `seedlings3-web` | `apps/web`     | Next.js app                          |
| `seedlings3-api` | `apps/api`     | Fastify API via Serverless Functions |

Set **Node.js = 20.x** for both projects.

For the **API** project you have two options for Output Directory:

- **Recommended**: set **Output Directory = `dist`** (tsup build output), or
- Add an empty `apps/api/public/.gitkeep` to satisfy Vercel’s “public folder” check.

Optionally add `apps/api/vercel.json` to rewrite root paths to the function prefix:

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "rewrites": [{ "source": "/(.*)", "destination": "/api/$1" }]
}
```
