// Read-only reconnaissance for Step 4 (paused-entity migration).
//
// Enumerates every Client and ClientContact currently in a PAUSED state
// and dumps the operational picture around them so the operator can
// eyeball the list BEFORE the migration runs:
//
//   • For each PAUSED Client — Property + Job breakdown by status,
//     plus a count of future SCHEDULED occurrences that will be deleted
//     when the migration bulk-pauses those Jobs.
//   • For each PAUSED Contact — client name, whether primary, whether
//     the migration's Contact-goes-to-ARCHIVED path leaves the client
//     without an ACTIVE primary contact (which would block future
//     payment requests until the operator promotes another).
//
// No writes. Safe to run against prod during business hours. The
// numbers here answer "what changes on migration day":
//   ACCEPTED → PAUSED  count = "services that will actually stop for
//                              the first time" (this is where surprise
//                              could happen if the operator was
//                              relying on the cosmetic Client.PAUSED
//                              badge).
//   Future SCHEDULED occurrences count = "worker calendars will lose
//                              these visits."
//
// Usage:
//   npx tsx scripts/recon-paused-entities.ts
//   npx tsx scripts/recon-paused-entities.ts --json   # machine-readable

import { prisma } from "../src/db/prisma";

async function main() {
  const jsonOnly = process.argv.includes("--json");

  // ── Clients in PAUSED status ─────────────────────────────────────────
  const pausedClients = await prisma.client.findMany({
    where: { status: "PAUSED" },
    include: {
      properties: {
        select: {
          id: true,
          displayName: true,
          status: true,
          jobs: {
            select: {
              id: true,
              status: true,
              frequencyDays: true,
              occurrences: {
                where: {
                  status: "SCHEDULED",
                  startAt: { gt: new Date() },
                  workflow: "STANDARD",
                },
                select: { id: true, startAt: true },
              },
            },
          },
        },
      },
    },
  });

  // ── Contacts in PAUSED status ────────────────────────────────────────
  const pausedContacts = await prisma.clientContact.findMany({
    where: { status: "PAUSED" },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      phone: true,
      isPrimary: true,
      clientId: true,
      client: { select: { displayName: true, status: true } },
    },
  });

  // For each paused contact whose client would be left primary-less if
  // this contact were archived, note it — the operator needs to promote
  // another contact BEFORE the migration lands or client payment
  // requests will hard-fail with PRIMARY_CONTACT_INACTIVE.
  const contactsLeavingClientPrimaryless: typeof pausedContacts = [];
  for (const contact of pausedContacts) {
    if (!contact.isPrimary) continue;
    const otherActivePrimaries = await prisma.clientContact.count({
      where: {
        clientId: contact.clientId,
        isPrimary: true,
        status: "ACTIVE",
        id: { not: contact.id },
      },
    });
    if (otherActivePrimaries === 0) {
      contactsLeavingClientPrimaryless.push(contact);
    }
  }

  if (jsonOnly) {
    console.log(JSON.stringify({
      pausedClients: pausedClients.map((c) => ({
        id: c.id,
        displayName: c.displayName,
        propertyCount: c.properties.length,
        jobStatusCounts: countJobStatuses(c),
        futureScheduledOccurrenceCount: countFutureOccurrences(c),
      })),
      pausedContacts: pausedContacts.map((c) => ({
        id: c.id,
        name: `${c.firstName} ${c.lastName ?? ""}`.trim(),
        isPrimary: c.isPrimary,
        clientName: c.client?.displayName ?? null,
        clientStatus: c.client?.status ?? null,
      })),
      contactsLeavingClientPrimaryless: contactsLeavingClientPrimaryless.map((c) => ({
        contactId: c.id,
        contactName: `${c.firstName} ${c.lastName ?? ""}`.trim(),
        clientId: c.clientId,
        clientName: c.client?.displayName ?? null,
      })),
    }, null, 2));
    return;
  }

  // ── Human-readable output ────────────────────────────────────────────
  console.log("═══════════════════════════════════════════════════════════════════");
  console.log("Paused-entity reconnaissance — read-only");
  console.log("═══════════════════════════════════════════════════════════════════\n");

  console.log(`PAUSED CLIENTS: ${pausedClients.length}`);
  console.log(`PAUSED CONTACTS: ${pausedContacts.length}`);
  console.log(`  ↳ Contacts that will leave their Client primary-less on ARCHIVE: ${contactsLeavingClientPrimaryless.length}`);
  console.log();

  if (pausedClients.length === 0 && pausedContacts.length === 0) {
    console.log("Nothing to migrate. Prod is already clean.");
    return;
  }

  // ── Paused Clients detail ────────────────────────────────────────────
  if (pausedClients.length > 0) {
    console.log("─── Paused Clients ────────────────────────────────────────────────");
    console.log("Each row shows: Client · #properties · Job status counts · # future occurrences that will be deleted");
    console.log();
    for (const c of pausedClients) {
      const counts = countJobStatuses(c);
      const future = countFutureOccurrences(c);
      const jobBreakdown = Object.entries(counts)
        .filter(([, n]) => n > 0)
        .map(([k, n]) => `${k}:${n}`)
        .join(" ");
      console.log(`  ${c.displayName}`);
      console.log(`    id=${c.id}`);
      console.log(`    ${c.properties.length} propert${c.properties.length === 1 ? "y" : "ies"} · Jobs [${jobBreakdown || "none"}] · ${future} future occurrence${future === 1 ? "" : "s"} to delete`);
      if (counts.ACCEPTED > 0) {
        console.log(`    ⚠ ${counts.ACCEPTED} ACCEPTED Job${counts.ACCEPTED === 1 ? "" : "s"} — services will ACTUALLY STOP on migration (currently running because Client.PAUSED was cosmetic).`);
      }
      console.log();
    }
  }

  // ── Paused Contacts detail ───────────────────────────────────────────
  if (pausedContacts.length > 0) {
    console.log("─── Paused Contacts (will be archived) ────────────────────────────");
    for (const c of pausedContacts) {
      const name = `${c.firstName} ${c.lastName ?? ""}`.trim();
      const primaryFlag = c.isPrimary ? " (PRIMARY)" : "";
      const clientLabel = c.client?.displayName ?? "(no client)";
      const clientStatusFlag = c.client?.status === "ARCHIVED" ? " [client already archived]" : "";
      console.log(`  ${name}${primaryFlag}  →  ${clientLabel}${clientStatusFlag}`);
      console.log(`    id=${c.id}  email=${c.email ?? "—"}  phone=${c.phone ?? "—"}`);
    }
    console.log();
  }

  // ── Blockers to surface BEFORE migration ─────────────────────────────
  if (contactsLeavingClientPrimaryless.length > 0) {
    console.log("─── ⚠ ACTION REQUIRED BEFORE MIGRATION ─────────────────────────────");
    console.log("These paused primary contacts have no ACTIVE alternate primary on their client.");
    console.log("After migration they become ARCHIVED — future payment requests will fail with");
    console.log("PRIMARY_CONTACT_INACTIVE until a new primary is set.");
    console.log();
    for (const c of contactsLeavingClientPrimaryless) {
      const name = `${c.firstName} ${c.lastName ?? ""}`.trim();
      const clientLabel = c.client?.displayName ?? "(no client)";
      console.log(`  ${clientLabel} — ${name} (contact id=${c.id})`);
    }
    console.log();
    console.log("Fix by promoting another contact to primary on each affected client, OR");
    console.log("unpausing this contact before the migration runs.");
    console.log();
  }

  console.log("═══════════════════════════════════════════════════════════════════");
}

function countJobStatuses(client: { properties: { jobs: { status: string }[] }[] }): Record<string, number> {
  const counts: Record<string, number> = {
    PROPOSED: 0, ACCEPTED: 0, PAUSED: 0, ARCHIVED: 0,
  };
  for (const p of client.properties) {
    for (const j of p.jobs) {
      counts[j.status] = (counts[j.status] ?? 0) + 1;
    }
  }
  return counts;
}

function countFutureOccurrences(client: { properties: { jobs: { status: string; occurrences: unknown[] }[] }[] }): number {
  let n = 0;
  for (const p of client.properties) {
    for (const j of p.jobs) {
      // Only ACCEPTED Jobs will have their future occurrences deleted
      // by bulk-pause. Already-PAUSED Jobs' future occurrences were
      // already deleted at their original pause moment.
      if (j.status !== "ACCEPTED") continue;
      n += j.occurrences.length;
    }
  }
  return n;
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
