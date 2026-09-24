import { promotionSavePayloadSchema } from "../src/services/promotions";

// PRODUCTION'S EXACT STORED VALUE, plus the box the operator ticked — which
// is precisely what the browser submitted when the save failed.
const stored = ["invoice_page", "wall_display", "promotions_tab"];
const submitted = [...stored, "external_display"];

const body = (surfaces: string[]) => ({
  title: "Seedlngs Fall 2026",
  description: "",
  linkKind: "LANDING_PAGE",
  link: null,
  audienceSpec: { kind: "all" },
  dispatchChannels: [],
  displaySurfaces: surfaces,
  triggerKind: null,
  triggerConfig: {},
  cooldownDays: 7,
  startAt: null,
  endAt: null,
  content: { shared: { headline: "Fall Services", body: "Seedlings is booking fall cleanups now." } },
});

for (const [label, surfaces] of [
  ["stored as-is (no edit)", stored],
  ["what the browser submitted", submitted],
] as const) {
  const r = promotionSavePayloadSchema.safeParse(body(surfaces as string[]));
  console.log(
    `${label}:`,
    r.success
      ? "OK -> " + JSON.stringify((r.data as any).displaySurfaces)
      : "REJECTED -> " + r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
  );
}

// And a genuinely bad value must still be refused.
const bad = promotionSavePayloadSchema.safeParse(body(["invoice_page", "billboard"]));
console.log("bogus value:", bad.success ? "ACCEPTED (BAD!)" : "REJECTED (correct)");
process.exit(0);
