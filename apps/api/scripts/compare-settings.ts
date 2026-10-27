/**
 * Compare the Setting table in DEV against another database (normally
 * production), and print what is missing on each side.
 *
 * READ-ONLY. It opens two connections, selects keys, and writes nothing.
 *
 * WHY THIS IS A SCRIPT AND NOT A ONE-LINER. Settings are the one kind of
 * state `prisma migrate` does not carry: a new feature that reads a Setting
 * row works in dev because the seed created it, and does nothing in
 * production because nobody did. The failure is silent — a disabled
 * feature looks the same as a quiet one — so the check belongs somewhere
 * repeatable rather than in somebody's shell history.
 *
 *   PROD_DATABASE_URL='postgres://…' npx tsx scripts/compare-settings.ts
 *
 * The URL comes from the environment deliberately: this file never reads
 * `.env` and never prints a connection string.
 */
import { PrismaClient } from "@prisma/client";

async function keysOf(url?: string): Promise<Map<string, string>> {
  const client = url
    ? new PrismaClient({ datasources: { db: { url } } })
    : new PrismaClient();
  try {
    const rows = await client.setting.findMany({ select: { key: true, value: true } });
    return new Map(rows.map((r) => [r.key, r.value ?? ""]));
  } finally {
    await client.$disconnect();
  }
}

(async () => {
  const prodUrl = process.env.PROD_DATABASE_URL;
  if (!prodUrl) {
    console.error("Set PROD_DATABASE_URL to the database you want to compare against.");
    process.exit(1);
  }

  const [dev, prod] = await Promise.all([keysOf(), keysOf(prodUrl)]);
  const missing = [...dev.keys()].filter((k) => !prod.has(k)).sort();
  const extra = [...prod.keys()].filter((k) => !dev.has(k)).sort();
  // Keys present in both but EMPTY in the target: a row that exists with no
  // value is the same silent failure as a row that does not exist.
  const blank = [...dev.keys()]
    .filter((k) => prod.has(k) && (dev.get(k) ?? "").trim() !== "" && (prod.get(k) ?? "").trim() === "")
    .sort();

  console.log(`dev: ${dev.size} settings    target: ${prod.size} settings\n`);

  console.log(`MISSING from the target (${missing.length}) — create these before the feature that reads them ships:`);
  console.log(missing.length ? missing.map((k) => `  ${k}`).join("\n") : "  (none)");

  console.log(`\nSET IN DEV BUT EMPTY IN THE TARGET (${blank.length}) — a blank row reads as "feature off":`);
  console.log(blank.length ? blank.map((k) => `  ${k}`).join("\n") : "  (none)");

  console.log(`\nONLY IN THE TARGET (${extra.length}) — usually fine; a setting the seed no longer defines:`);
  console.log(extra.length ? extra.map((k) => `  ${k}`).join("\n") : "  (none)");

  // VALUES ARE NEVER PRINTED. Several settings are credentials
  // (WEATHER_API_KEY, PROMOTION_HMAC_SECRET); this answers "which rows are
  // missing", which is the question, without putting secrets on a terminal
  // or into a scrollback someone later pastes.
})();
