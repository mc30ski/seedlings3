# Hello World Monorepo

A minimal monorepo starter with:

- **Web**: Next.js + Chakra UI (deployed on Vercel)
- **API**: Fastify (TypeScript) + Prisma + Neon (deploy on Google Cloud Run)
- **Mobile**: Expo (React Native) + React Native Paper

## Quickstart

```bash
npm install
npm run dev
```

- Web: `apps/web` on http://localhost:3000
- API: `apps/api` on http://localhost:8080
- Mobile: `apps/mobile` via `npx expo start` (or `npm run dev` inside `apps/mobile`)

## Deployment

- **API**: Configure Google Cloud credentials in GitHub, set secrets, and the included GitHub Action will build & deploy to Cloud Run on pushes to `main` that touch `apps/api/**` (https://seedlings3-1000564298660.us-east1.run.app/hello).
- **Web**: Push to GitHub, import the repo into Vercel, set `NEXT_PUBLIC_API_BASE_URL` and `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` env vars (https://seedlings3-web.vercel.app).
- **Mobile**: Use Expo EAS to build. Set `EXPO_PUBLIC_API_BASE_URL` and `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY` in your EAS project if/when you add auth.

See `apps/api/README.md` for Cloud Run specifics.
