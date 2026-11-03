import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
// Spread timing bands across cards of DIFFERENT colours, so one screenshot
// shows whether the band is tracking the card or inventing its own hue.
const TARGETS = [
  "cmvy62k0t00nqgnioc43hss22", // 11-01 CLOSED      — no fill at all (the reported case)
  "cmvy62k3x00nygniofvwtxct4", // 11-01 PENDING_PAYMENT — green
  "cmvy62jtn00n8gniodc979psz", // 11-01 SCHEDULED 0a    — unassigned, yellow
  "cmvy62ks400pkgnioug96w6hk", // 11-02 SCHEDULED 0a    — unassigned, yellow
  "cmvy62knt00pegniojo46v61f", // 11-02 SCHEDULED 4a    — assigned
];
(async () => {
  for (const occurrenceId of TARGETS) {
    await prisma.occurrenceInstruction.deleteMany({ where: { occurrenceId, kind: "TIMING" } });
    await prisma.occurrenceInstruction.create({
      data: { occurrenceId, text: "Not 1–3pm (baby napping)", kind: "TIMING", scope: "EVERY_VISIT", sortOrder: 0 },
    });
    await prisma.occurrenceInstruction.create({
      data: { occurrenceId, text: "Before 11am", kind: "TIMING", scope: "THIS_VISIT", sortOrder: 1 },
    });
  }
  console.log("seeded", TARGETS.length);
  process.exit(0);
})();
