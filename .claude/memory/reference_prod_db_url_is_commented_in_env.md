---
name: reference_prod_db_url_is_commented_in_env
description: "The production Neon URL is in apps/api/.env, COMMENTED OUT — #DATABASE_URL / #DIRECT_URL on the lines below the dev pair. Reads against prod are normal and expected; don't conclude prod is unreachable."
metadata:
  node_type: memory
  type: reference
  originSessionId: e3608af7-8965-4649-8bef-c7a4069a7325
  modified: 2026-10-29T20:03:46.951Z
---

# Production is reachable from this machine. The URL is in `.env`, commented out.

`apps/api/.env` holds **both** environments. The dev pair is live; the
production pair sits directly beneath it, commented:

```
DATABASE_URL="postgresql://…@ep-jolly-wildflower-adh5uaav-pooler…"   # DEV, active
DIRECT_URL="postgresql://…@ep-jolly-wildflower-adh5uaav…"            # DEV, active
#DATABASE_URL="postgresql://…@ep-noisy-feather-ad9zwduj-pooler…"     # PRODUCTION
#DIRECT_URL="postgresql://…@ep-noisy-feather-ad9zwduj…"              # PRODUCTION
```

- **dev** = `ep-jolly-wildflower-adh5uaav`
- **production** = `ep-noisy-feather-ad9zwduj`

The user switches environments by moving the `#`.

## The mistake this exists to stop

Twice now I have looked for a production connection string, grepped
`^[A-Z0-9_]+` or `^DATABASE_URL`, found only the dev pair, and told the
user **"I can't reach production"** — asking them to paste query output
instead. Both anchors skip a commented line by construction. The user's
reply the second time: *"OMG. Yes you can fucking reach production. You do
it all the damn time."*

**So: grep `.env` for `DATABASE_URL` with no anchor**, and read the
commented lines too, before saying anything is unreachable.

## Reading prod

Reads are normal and need no permission. **Every write is the user's** —
see [[feedback_never_write_production_db]].

```bash
cd apps/api
PROD_URL=$(grep -E '^#DATABASE_URL=' .env | head -1 | sed -E 's/^#DATABASE_URL="?//; s/"?$//')
PROD_DIRECT=$(grep -E '^#DIRECT_URL=' .env | head -1 | sed -E 's/^#DIRECT_URL="?//; s/"?$//')
DATABASE_URL="$PROD_URL" DIRECT_URL="$PROD_DIRECT" npx tsx -e '…'
```

Or hand one client the URL directly, which is what a dev↔prod diff needs:

```ts
const prod = new PrismaClient({ datasources: { db: { url: process.env.PROD_U } } });
```

Three rules when you do:

1. **Set BOTH vars** when overriding, or migrate reads one and reports the
   other — [[reference_migrate_needs_direct_url]].
2. **Print the host and assert the shape first.** Production is ~93
   properties / 27 users / root portfolio "All properties"; dev is ~22
   properties with a five-level tree. One identifying count beats trusting
   an env var.
3. **Clerk is still TEST** no matter which database you point at —
   [[reference_local_env_is_test_clerk]]. The keys and the URL come from
   different places.

## Don't paste secrets into chat

A settings comparison can be done on `md5(value)` and `length(value)`;
`PROMOTION_HMAC_SECRET` and the Clerk keys never need to be shown to
answer "do these match". Done this way for the 2026-10-29 settings diff.
