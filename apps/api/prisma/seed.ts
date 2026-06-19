import { PrismaClient } from "@prisma/client";
import { PrismaNeon } from "@prisma/adapter-neon";
import { neonConfig } from "@neondatabase/serverless";
import ws from "ws";
import { etFormatDate } from "../src/lib/dates";

// ── Safety guard ────────────────────────────────────────────────────────────
const dbUrl = process.env.DATABASE_URL ?? "";
if (!dbUrl.includes("jolly-wildflower")) {
  console.error(
    "SAFETY: DATABASE_URL does not contain 'jolly-wildflower'. Refusing to run.\n" +
    "This script only runs against the development database."
  );
  process.exit(1);
}

// ── Prisma client (matches src/db/prisma.ts pattern) ────────────────────────
neonConfig.webSocketConstructor = ws;
const adapter = new PrismaNeon({ connectionString: dbUrl });
const prisma = new PrismaClient({ adapter });

// ── Existing user IDs (never modified) ──────────────────────────────────────
const ADMIN_WORKER_ID   = "cmnry8iih000k5acx7hf27aay";
const CONTRACTOR_ID     = "cmnrylyaz000s5abyeyg77m4x";
const EMPLOYEE_ID       = "cmnrz00fd002d5abyyr88byen";
const TRAINEE_ID        = "cmnrzapcl003g5abybrzttuxs";
const CLIENT_USER_ID    = "cmnrzcwxc00495abyodg1qnuy";
const MICHAEL_ID        = "cmexiwrfs003kvdysrjteo2hy";

const CLIENT_CLERK_ID   = "user_3C8aJI7a58wmVbrK4Ao3pZRp3RF";
const PENDING_CLIENT_CLERK_ID = "user_3CJXY4nnIzxamLgzfpLwQLS0dyR";
// A phantom Clerk-authenticated client — signed up via /pay or /sign-up with
// an email that DOESN'T match any ClientContact on file. Used to exercise
// the admin re-link worklist on the Clients tab.
const PHANTOM_CLIENT_CLERK_ID = "user_seed_phantom_clientacct_001";

// Workers available for assignment (not Michael — overseer)
const WORKERS = [ADMIN_WORKER_ID, CONTRACTOR_ID, EMPLOYEE_ID, TRAINEE_ID];

// ── Date helpers ────────────────────────────────────────────────────────────
const NOW = new Date();

function daysFromNow(days: number, hour = 8): Date {
  const d = new Date(NOW);
  d.setDate(d.getDate() + days);
  d.setHours(hour, 0, 0, 0);
  return d;
}

function daysAgo(days: number, hour = 8): Date {
  return daysFromNow(-days, hour);
}

function addMinutes(d: Date, mins: number): Date {
  return new Date(d.getTime() + mins * 60_000);
}

// ── Clear database ──────────────────────────────────────────────────────────
async function clearDatabase() {
  console.log("  Clearing leaf tables...");
  await prisma.followupClient.deleteMany();
  await prisma.followupJob.deleteMany();
  await prisma.reminder.deleteMany();
  await prisma.pinnedOccurrence.deleteMany();
  await prisma.likedOccurrence.deleteMany();
  await prisma.occurrenceComment.deleteMany();
  await prisma.occurrenceInstruction.deleteMany();
  await prisma.occurrenceAddon.deleteMany();
  await prisma.occurrencePropertyPhoto.deleteMany();
  await prisma.jobPropertyPhoto.deleteMany();
  await prisma.paymentSplit.deleteMany();
  // Supply chain (step-3): clear holds + adjustments + purchases before
  // expenses/BEs so the FK dependencies unwind cleanly. Supplies themselves
  // get cleared after BusinessExpense (SupplyPurchase → BE is Restrict).
  await prisma.supplyAdjustment.deleteMany();
  await prisma.supplyHold.deleteMany();
  await prisma.expense.deleteMany();
  await prisma.supplyPurchase.deleteMany();
  await prisma.businessExpense.deleteMany();
  await prisma.supply.deleteMany();
  await prisma.jobOccurrencePhoto.deleteMany();
  await prisma.jobOccurrenceAssignee.deleteMany();

  console.log("  Clearing payments...");
  await prisma.payment.deleteMany();
  // GuaranteedPayoutAdvance is deprecated (new code doesn't write rows)
  // but historical rows still hold FK refs to JobOccurrence. Clear
  // before deleting occurrences.
  await prisma.guaranteedPayoutAdvance.deleteMany();

  console.log("  Clearing occurrences...");
  await prisma.jobOccurrence.deleteMany();

  console.log("  Clearing job relations...");
  await prisma.jobAssigneeDefault.deleteMany();
  await prisma.jobContact.deleteMany();
  await prisma.jobClient.deleteMany();
  await prisma.jobSchedule.deleteMany();

  console.log("  Clearing jobs...");
  await prisma.job.deleteMany();

  console.log("  Clearing groups...");
  // Order matters: CheckoutSplit → preferred → members → group (FKs).
  await prisma.checkoutSplit.deleteMany();
  await prisma.groupPreferredEquipment.deleteMany();
  await prisma.groupMember.deleteMany();
  await prisma.group.deleteMany();

  console.log("  Clearing equipment...");
  await prisma.checkout.deleteMany();
  await prisma.equipmentCollection.deleteMany();
  await prisma.equipment.deleteMany();

  console.log("  Clearing properties...");
  await prisma.propertyPhoto.deleteMany();
  await prisma.property.deleteMany();

  console.log("  Clearing contacts...");
  await prisma.clientContact.deleteMany();

  console.log("  Clearing clients...");
  await prisma.client.deleteMany();

  console.log("  Clearing workday rows...");
  await prisma.workerWorkday.deleteMany();

  console.log("  Clearing audit log...");
  await prisma.auditEvent.deleteMany();

  console.log("  Done. (User, UserRole, Setting preserved)");
}

// Presentational grouping for the Settings tab. Maps each general setting
// key to a section key; the section titles/descriptions/order live in a
// web-side code constant (apps/web/src/lib/settingSections.ts). pricing_*
// settings are intentionally absent — they render in a separate Pricing UI.
// A setting missing from this map keeps section=null and lands in the UI's
// "Other" group. Run applySettingSections() after settings are seeded.
const SETTING_SECTIONS: Record<string, string> = {
  // Business Start Date — non-destructive money cleanup. Pinned to the top
  // of the Settings tab. See apps/api/src/lib/businessStartCutoff.ts.
  BUSINESS_START_DATE: "fresh_start",
  BUSINESS_START_DATE_ENABLED: "fresh_start",
  // Payments & Payouts
  CONTRACTOR_PLATFORM_FEE_PERCENT: "payments",
  EMPLOYEE_BUSINESS_MARGIN_PERCENT: "payments",
  PAYMENT_METHODS: "payments",
  PAYMENT_FROM_OPTIONS: "catalogs",
  PAYROLL_PERIOD_CADENCE: "payments",
  HIGH_VALUE_JOB_THRESHOLD: "payments",
  HOURS_APPROVAL_VARIANCE_THRESHOLD_PERCENT: "payments",
  WORKDAY_APPROVAL_CUTOFF_HOUR_ET: "payments",
  MIN_WAGE_PER_HOUR: "payments",
  FIXED_ASSET_MIN_COST: "payments",
  QB_INCLUDE_CONTRACT_LABOR: "payments",
  EQUIPMENT_BILLING_ENABLED: "payments",
  // Client Payment Requests
  BUSINESS_NAME: "client_requests",
  DEFAULT_PAYMENT_COMMUNICATIONS_MODE: "client_requests",
  PAYMENT_REQUEST_BASE_URL: "client_requests",
  PAYMENT_REQUEST_TOKEN_EXPIRY_HOURS: "client_requests",
  PAYMENT_REQUEST_STALE_DAYS: "client_requests",
  NOTIFY_PAYMENT_APPROVAL_VIA_SMS_EMAIL: "client_requests",
  NOTIFY_CHANGE_REQUEST_VIA_SMS_EMAIL: "client_requests",
  OUTGOING_COMMS_CC: "client_requests",
  VENMO_BUSINESS_HANDLE: "client_requests",
  ZELLE_ADDRESS: "client_requests",
  // Catalogs & Taxonomies
  SERVICE_TYPES: "catalogs",
  EQUIPMENT_KINDS: "catalogs",
  DOCUMENT_TYPES: "catalogs",
  TIMELINE_CATEGORIES: "catalogs",
  EXPENSE_CATEGORIES: "catalogs",
  EQUIPMENT_RENTAL_INCOME_CONFIG: "catalogs",
  // Photos & Documents
  MAX_PHOTOS_PER_JOB: "media",
  PHOTO_JPEG_QUALITY: "media",
  PHOTO_MAX_EDGE_PX: "media",
  DOCUMENT_MAX_SIZE_MB: "media",
  // Integrations
  WEATHER_API_KEY: "integrations",
};

// Stamp each setting's section column. Idempotent — updateMany on a key that
// doesn't exist is a no-op, so it's safe to call with the full map from any
// seed template even when only a subset of settings exist.
async function applySettingSections() {
  for (const [key, section] of Object.entries(SETTING_SECTIONS)) {
    await prisma.setting.updateMany({ where: { key }, data: { section } });
  }
}

// ── Seed database ───────────────────────────────────────────────────────────
async function seedDatabase() {
  // ── Pending client user (upsert so re-seed resets approval state) ────────
  console.log("  Ensuring pending client user...");
  await prisma.user.upsert({
    where: { clerkUserId: PENDING_CLIENT_CLERK_ID },
    create: {
      clerkUserId: PENDING_CLIENT_CLERK_ID,
      email: "admin+pendingclient@seedlingslawncare.com",
      firstName: "Client",
      lastName: "Pending User",
      displayName: "Client Pending User",
      isApproved: false,
    },
    update: { isApproved: false },
  });

  // ── Phantom client account (admin re-link test fixture) ─────────────────
  // An approved Clerk-side client signup with NO roles and whose email
  // doesn't match any ClientContact's email. The admin Clients tab should
  // surface this in its "Unlinked client accounts" worklist on load.
  console.log("  Ensuring phantom client account...");
  await prisma.user.upsert({
    where: { clerkUserId: PHANTOM_CLIENT_CLERK_ID },
    create: {
      clerkUserId: PHANTOM_CLIENT_CLERK_ID,
      email: "phantom.client@example.com",
      firstName: "Phantom",
      lastName: "ClientAcct",
      displayName: "Phantom ClientAcct",
      isApproved: true,
    },
    update: { isApproved: true, email: "phantom.client@example.com" },
  });

  // Matching "obvious" target contact — same local-part prefix as the
  // phantom's email, so the picker's similarity sort surfaces it at the top.
  // The orphan client + its contact are wiped on every reseed (clearDatabase
  // empties Client/ClientContact); the phantom User persists across seeds.
  const phantomTargetClient = await prisma.client.create({
    data: {
      type: "PERSON",
      displayName: "Phantom Test Family",
      notesInternal:
        "Seed-only fixture for the admin re-link worklist. The phantom Clerk account 'phantom.client@example.com' should be matched to this client's primary contact.",
    },
  });
  await prisma.clientContact.create({
    data: {
      clientId: phantomTargetClient.id,
      firstName: "Phantom",
      lastName: "Target",
      role: "OWNER",
      isPrimary: true,
      // DIFFERENT from the phantom user's email — same local-part PREFIX
      // ("phantom.client") so the similarity sort works, but a different
      // domain/suffix so the auto-link email-equality check correctly fails.
      email: "phantom.client.actual@example.com",
      phone: "(555) 040-0001",
      normalizedPhone: "+15550400001",
    },
  });

  // ── Privilege overrides on seed workers ──────────────────────────────────
  // Demos the per-user override layer on top of workerType defaults:
  //   EMPLOYEE: gets `canChargeBusinessExpenses = true` (trusted employee
  //             who carries the company card — can record new expenses).
  //   TRAINEE:  gets `canPullInventory = true` (a specific trainee allowed
  //             to consume from inventory; ordinarily trainees can't).
  //   CONTRACTOR / ADMIN_WORKER: cleared to null, so defaults apply
  //             (contractor: inventory-only; admin: everything).
  console.log("  Setting privilege overrides on seed workers...");
  const privilegeUpdates: Array<{ id: string; canPullInventory: boolean | null; canChargeBusinessExpenses: boolean | null }> = [
    { id: ADMIN_WORKER_ID, canPullInventory: null, canChargeBusinessExpenses: null },
    { id: CONTRACTOR_ID,   canPullInventory: null, canChargeBusinessExpenses: null },
    { id: EMPLOYEE_ID,     canPullInventory: null, canChargeBusinessExpenses: true },
    { id: TRAINEE_ID,      canPullInventory: true, canChargeBusinessExpenses: null },
  ];
  for (const p of privilegeUpdates) {
    await prisma.user.update({
      where: { id: p.id },
      data: {
        canPullInventory: p.canPullInventory,
        canChargeBusinessExpenses: p.canChargeBusinessExpenses,
      },
    }).catch((err) => {
      console.warn(`  ⚠ skipped privilege seed for ${p.id}: ${err?.message ?? err}`);
    });
  }

  // ── Hourly wage on seed workers ──────────────────────────────────────────
  // Drives the Reconcile → Payroll export's Regular Wages column. W-2
  // workers (Employee + Trainee + the admin who also works field) get
  // realistic rates; the contractor + the LLC owner stay at 0 (paid
  // lump-sum / via draws, not Gusto wages).
  console.log("  Setting hourly wage on seed workers...");
  const wageUpdates: Array<{ id: string; hourlyWage: number; note: string }> = [
    { id: ADMIN_WORKER_ID, hourlyWage: 25.00, note: "Admin who also works field" },
    { id: EMPLOYEE_ID,     hourlyWage: 18.00, note: "Field employee" },
    { id: TRAINEE_ID,      hourlyWage: 15.00, note: "Trainee" },
    { id: CONTRACTOR_ID,   hourlyWage:  0.00, note: "Contractor — paid lump-sum" },
    { id: MICHAEL_ID,      hourlyWage:  0.00, note: "LLC owner — takes draws, not wages" },
  ];
  for (const w of wageUpdates) {
    await prisma.user.update({
      where: { id: w.id },
      data: { hourlyWage: w.hourlyWage },
    }).catch((err) => {
      console.warn(`  ⚠ skipped wage seed for ${w.id}: ${err?.message ?? err}`);
    });
  }

  // ── Clients (12) ──────────────────────────────────────────────────────────
  console.log("  Creating clients...");

  const vipClient = await prisma.client.create({
    data: { type: "PERSON", displayName: "Harrington Estate", isVip: true, vipReason: "Long-time client, premium service tier", notesInternal: "Gate code: 4821" },
  });
  const martinezFamily = await prisma.client.create({
    data: { type: "PERSON", displayName: "Martinez Family", adminTags: JSON.stringify(["LATE_PAYER"]) },
  });
  const willowbrookHoa = await prisma.client.create({
    data: { type: "COMMUNITY", displayName: "Willowbrook HOA", notesInternal: "Board contact: Susan Park. Monthly board meeting first Tuesday at 7pm in the clubhouse. Budget approved through December. They compare our pricing annually against two other providers so keep quality high. Previous vendor was let go for inconsistent scheduling. Susan prefers text over email for urgent issues.", adminTags: JSON.stringify(["HIGH_MAINTENANCE", "ARGUMENTATIVE"]) },
  });
  const chenResidence = await prisma.client.create({
    data: { type: "PERSON", displayName: "Chen Residence" },
  });
  const vipThompson = await prisma.client.create({
    data: { type: "PERSON", displayName: "Thompson Manor", isVip: true, vipReason: "Referral source - sends 3+ clients/year" },
  });
  const obrienFamily = await prisma.client.create({
    data: { type: "PERSON", displayName: "O'Brien Family", notesInternal: "Dog in backyard, latch gate before entering", adminTags: JSON.stringify(["DIFFICULT_ACCESS"]) },
  });
  const sunriseHoa = await prisma.client.create({
    data: { type: "COMMUNITY", displayName: "Sunrise Meadows HOA", notesInternal: "Monthly board meeting first Tuesday" },
  });
  const patelResidence = await prisma.client.create({
    data: { type: "PERSON", displayName: "Patel Residence" },
  });
  const riverBend = await prisma.client.create({
    data: { type: "ORGANIZATION", displayName: "River Bend Office Park", notesInternal: "Property manager Tom Walters onsite M-F 7am-4pm. After-hours access via loading dock keypad (code changes monthly, get from Tom). They have a strict no-noise policy before 8am near Building A due to a medical office. Invoice goes to their corporate office in Dallas, not Tom directly. Net-30 payment terms. They also want a proposal for seasonal flower bed rotations in spring and fall." },
  });
  const kimResidence = await prisma.client.create({
    data: { type: "PERSON", displayName: "Kim Residence", status: "PAUSED", notesInternal: "Traveling abroad, resume in June" },
  });
  const garciaFamily = await prisma.client.create({
    data: { type: "PERSON", displayName: "Garcia Family", status: "PAUSED", notesInternal: "Paused for winter, resume March" },
  });
  const oldClient = await prisma.client.create({
    data: { type: "PERSON", displayName: "Dawson Residence", status: "ARCHIVED", notesInternal: "Moved out of area, no longer servicing", archivedAt: daysAgo(60) },
  });
  const lakesideChurch = await prisma.client.create({
    data: { type: "ORGANIZATION", displayName: "Lakeside Community Church" },
  });

  // ── Contacts (~20) ────────────────────────────────────────────────────────
  console.log("  Creating contacts...");

  const harringtonPrimary = await prisma.clientContact.create({
    data: { clientId: vipClient.id, firstName: "James", lastName: "Harrington", role: "OWNER", isPrimary: true, email: "james@harrington.example.com", phone: "(555) 100-0001", normalizedPhone: "+15551000001" },
  });
  const harringtonSpouse = await prisma.clientContact.create({
    data: { clientId: vipClient.id, firstName: "Eleanor", lastName: "Harrington", role: "SPOUSE", isPrimary: false, email: "eleanor@harrington.example.com", phone: "(555) 100-0002", normalizedPhone: "+15551000002" },
  });
  const martinezPrimary = await prisma.clientContact.create({
    data: { clientId: martinezFamily.id, firstName: "Sofia", lastName: "Martinez", role: "OWNER", isPrimary: true, clerkUserId: CLIENT_CLERK_ID, email: "admin+client@seedlingslawncare.com", phone: "(555) 200-0001", normalizedPhone: "+15552000001" },
  });
  const martinezSpouse = await prisma.clientContact.create({
    data: { clientId: martinezFamily.id, firstName: "Carlos", lastName: "Martinez", role: "SPOUSE", isPrimary: false, email: "carlos.martinez@example.com", phone: "(555) 200-0002", normalizedPhone: "+15552000002" },
  });
  const willowbrookManager = await prisma.clientContact.create({
    data: { clientId: willowbrookHoa.id, firstName: "Susan", lastName: "Park", role: "COMMUNITY_MANAGER", isPrimary: true, email: "susan.park@willowbrookhoa.example.org", phone: "(555) 300-0001", normalizedPhone: "+15553000001" },
  });
  const willowbrookOps = await prisma.clientContact.create({
    data: { clientId: willowbrookHoa.id, firstName: "Dave", lastName: "Reeves", role: "OPERATIONS", isPrimary: false, email: "dave.reeves@willowbrookhoa.example.org", phone: "(555) 300-0002", normalizedPhone: "+15553000002" },
  });
  const chenPrimary = await prisma.clientContact.create({
    data: { clientId: chenResidence.id, firstName: "Lisa", lastName: "Chen", role: "OWNER", isPrimary: true, email: "lisa.chen@example.com", phone: "(555) 400-0001", normalizedPhone: "+15554000001" },
  });
  const thompsonPrimary = await prisma.clientContact.create({
    data: { clientId: vipThompson.id, firstName: "Robert", lastName: "Thompson", role: "OWNER", isPrimary: true, email: "robert@thompson.example.com", phone: "(555) 500-0001", normalizedPhone: "+15555000001" },
  });
  const thompsonSpouse = await prisma.clientContact.create({
    data: { clientId: vipThompson.id, firstName: "Diana", lastName: "Thompson", role: "SPOUSE", isPrimary: false, email: "diana@thompson.example.com", phone: "(555) 500-0002", normalizedPhone: "+15555000002" },
  });
  const obrienPrimary = await prisma.clientContact.create({
    data: { clientId: obrienFamily.id, firstName: "Sean", lastName: "O'Brien", role: "OWNER", isPrimary: true, email: "sean.obrien@example.com", phone: "(555) 600-0001", normalizedPhone: "+15556000001" },
  });
  const sunriseManager = await prisma.clientContact.create({
    data: { clientId: sunriseHoa.id, firstName: "Angela", lastName: "Torres", role: "COMMUNITY_MANAGER", isPrimary: true, email: "angela.torres@sunrisemeadows.example.org", phone: "(555) 700-0001", normalizedPhone: "+15557000001" },
  });
  const sunriseBilling = await prisma.clientContact.create({
    data: { clientId: sunriseHoa.id, firstName: "Mark", lastName: "Jensen", role: "BILLING", isPrimary: false, email: "mark.jensen@sunrisemeadows.example.org", phone: "(555) 700-0002", normalizedPhone: "+15557000002" },
  });
  const patelPrimary = await prisma.clientContact.create({
    data: { clientId: patelResidence.id, firstName: "Priya", lastName: "Patel", role: "OWNER", isPrimary: true, email: "priya.patel@example.com", phone: "(555) 800-0001", normalizedPhone: "+15558000001" },
  });
  const riverBendManager = await prisma.clientContact.create({
    data: { clientId: riverBend.id, firstName: "Tom", lastName: "Walters", role: "PROPERTY_MANAGER", isPrimary: true, email: "tom.walters@riverbend.example.com", phone: "(555) 900-0001", normalizedPhone: "+15559000001" },
  });
  const kimPrimary = await prisma.clientContact.create({
    data: { clientId: kimResidence.id, firstName: "Min-Jun", lastName: "Kim", role: "OWNER", isPrimary: true, email: "minjun.kim@example.com", phone: "(555) 010-0001", normalizedPhone: "+15550100001" },
  });
  const garciaPrimary = await prisma.clientContact.create({
    data: { clientId: garciaFamily.id, firstName: "Maria", lastName: "Garcia", role: "OWNER", isPrimary: true, email: "maria.garcia@example.com", phone: "(555) 020-0001", normalizedPhone: "+15550200001" },
  });
  const churchPrimary = await prisma.clientContact.create({
    data: { clientId: lakesideChurch.id, firstName: "Pastor David", lastName: "Mitchell", role: "OTHER", isPrimary: true, email: "david.mitchell@lakesidechurch.example.org", phone: "(555) 030-0001", normalizedPhone: "+15550300001" },
  });

  // ── Properties (~20) ──────────────────────────────────────────────────────
  console.log("  Creating properties...");

  const harringtonMain = await prisma.property.create({
    data: { clientId: vipClient.id, displayName: "Main Residence", street1: "1200 Oak Ridge Dr", city: "Austin", state: "TX", postalCode: "78701", country: "US", kind: "SINGLE", pointOfContactId: harringtonPrimary.id, lotSize: 12000, lotSizeUnit: "sqft", accessNotes: "Enter through side gate" },
  });
  const harringtonLake = await prisma.property.create({
    data: { clientId: vipClient.id, displayName: "Lake House", street1: "450 Lakeview Ln", city: "Lakeway", state: "TX", postalCode: "78734", country: "US", kind: "SINGLE", pointOfContactId: harringtonSpouse.id, lotSize: 8000, lotSizeUnit: "sqft", accessNotes: "Key under mat for backyard access" },
  });
  const martinezHome = await prisma.property.create({
    data: { clientId: martinezFamily.id, displayName: "Home", street1: "3322 Elm St", city: "Austin", state: "TX", postalCode: "78702", country: "US", kind: "SINGLE", pointOfContactId: martinezPrimary.id, lotSize: 5500, lotSizeUnit: "sqft" },
  });
  const willowbrookCommon = await prisma.property.create({
    data: { clientId: willowbrookHoa.id, displayName: "Common Areas", street1: "100 Willowbrook Blvd", city: "Round Rock", state: "TX", postalCode: "78664", country: "US", kind: "AGGREGATE_SITE", pointOfContactId: willowbrookManager.id, lotSize: 5, lotSizeUnit: "acres", accessNotes: "HOA maintenance shed has supplies" },
  });
  const willowbrookPool = await prisma.property.create({
    data: { clientId: willowbrookHoa.id, displayName: "Pool Area Grounds", street1: "110 Willowbrook Blvd", city: "Round Rock", state: "TX", postalCode: "78664", country: "US", kind: "SINGLE", pointOfContactId: willowbrookManager.id, lotSize: 15000, lotSizeUnit: "sqft" },
  });
  const willowbrookEntrance = await prisma.property.create({
    data: { clientId: willowbrookHoa.id, displayName: "Entrance Median", street1: "1 Willowbrook Dr", city: "Round Rock", state: "TX", postalCode: "78664", country: "US", kind: "SINGLE", pointOfContactId: willowbrookOps.id, lotSize: 3000, lotSizeUnit: "sqft", accessNotes: "High visibility area" },
  });
  const chenHome = await prisma.property.create({
    data: { clientId: chenResidence.id, displayName: "Home", street1: "7801 Maple Ave", city: "Cedar Park", state: "TX", postalCode: "78613", country: "US", kind: "SINGLE", pointOfContactId: chenPrimary.id, lotSize: 4000, lotSizeUnit: "sqft" },
  });
  const thompsonMain = await prisma.property.create({
    data: { clientId: vipThompson.id, displayName: "Main Estate", street1: "2500 Westlake Dr", city: "Austin", state: "TX", postalCode: "78746", country: "US", kind: "SINGLE", pointOfContactId: thompsonPrimary.id, lotSize: 18000, lotSizeUnit: "sqft", accessNotes: "Ring bell at front gate, code 7739" },
  });
  const thompsonGuest = await prisma.property.create({
    data: { clientId: vipThompson.id, displayName: "Guest House", street1: "2502 Westlake Dr", city: "Austin", state: "TX", postalCode: "78746", country: "US", kind: "SINGLE", pointOfContactId: thompsonSpouse.id, lotSize: 6000, lotSizeUnit: "sqft" },
  });
  const obrienHome = await prisma.property.create({
    data: { clientId: obrienFamily.id, displayName: "Home", street1: "914 Pecan St", city: "Pflugerville", state: "TX", postalCode: "78660", country: "US", kind: "SINGLE", pointOfContactId: obrienPrimary.id, lotSize: 7000, lotSizeUnit: "sqft", accessNotes: "Large dog in backyard - latch gate first" },
  });
  const sunriseCommon = await prisma.property.create({
    data: { clientId: sunriseHoa.id, displayName: "Common Grounds", street1: "500 Sunrise Blvd", city: "Georgetown", state: "TX", postalCode: "78626", country: "US", kind: "AGGREGATE_SITE", pointOfContactId: sunriseManager.id, lotSize: 8, lotSizeUnit: "acres", accessNotes: "Storage unit behind clubhouse" },
  });
  const sunrisePlayground = await prisma.property.create({
    data: { clientId: sunriseHoa.id, displayName: "Playground Park", street1: "520 Sunrise Blvd", city: "Georgetown", state: "TX", postalCode: "78626", country: "US", kind: "SINGLE", pointOfContactId: sunriseManager.id, lotSize: 10000, lotSizeUnit: "sqft" },
  });
  const patelHome = await prisma.property.create({
    data: { clientId: patelResidence.id, displayName: "Home", street1: "1105 Bluebonnet Ln", city: "Austin", state: "TX", postalCode: "78704", country: "US", kind: "SINGLE", pointOfContactId: patelPrimary.id, lotSize: 3500, lotSizeUnit: "sqft" },
  });
  const riverBendCampus = await prisma.property.create({
    data: { clientId: riverBend.id, displayName: "Office Campus", street1: "8000 River Bend Dr", city: "Austin", state: "TX", postalCode: "78730", country: "US", kind: "AGGREGATE_SITE", pointOfContactId: riverBendManager.id, lotSize: 3, lotSizeUnit: "acres", accessNotes: "After-hours access via loading dock" },
  });
  const riverBendFront = await prisma.property.create({
    data: { clientId: riverBend.id, displayName: "Front Entrance & Signage", street1: "8000 River Bend Dr", city: "Austin", state: "TX", postalCode: "78730", country: "US", kind: "SINGLE", pointOfContactId: riverBendManager.id, lotSize: 5000, lotSizeUnit: "sqft", accessNotes: "Keep flower beds tidy - client-facing" },
  });
  const kimHome = await prisma.property.create({
    data: { clientId: kimResidence.id, displayName: "Home", street1: "2211 Congress Ave", city: "Austin", state: "TX", postalCode: "78701", country: "US", kind: "SINGLE", pointOfContactId: kimPrimary.id, lotSize: 4500, lotSizeUnit: "sqft" },
  });
  const garciaHome = await prisma.property.create({
    data: { clientId: garciaFamily.id, displayName: "Home", street1: "660 Mockingbird Ln", city: "San Marcos", state: "TX", postalCode: "78666", country: "US", kind: "SINGLE", pointOfContactId: garciaPrimary.id, lotSize: 6000, lotSizeUnit: "sqft" },
  });
  const churchGrounds = await prisma.property.create({
    data: { clientId: lakesideChurch.id, displayName: "Church Grounds", street1: "3300 Lake Austin Blvd", city: "Austin", state: "TX", postalCode: "78703", country: "US", kind: "AGGREGATE_SITE", pointOfContactId: churchPrimary.id, lotSize: 2, lotSizeUnit: "acres", accessNotes: "Avoid mowing during Sunday services (8am-1pm)" },
  });

  // ── Equipment (18) ────────────────────────────────────────────────────────
  console.log("  Creating equipment...");

  // Mowers
  const mower1 = await prisma.equipment.create({
    data: { type: "MOWER", brand: "Scag", model: "V-Ride II 52\"", shortDesc: "Commercial stand-on mower", longDesc: "52\" deck, 25hp Kawasaki FX730V engine. Best for large open properties (HOAs, office parks). Velke platform for stand-on operation. Oil change every 100 hours. Blades in trailer toolbox.", status: "CHECKED_OUT", energy: "Gas", dailyRate: 8.0, requiresInsurance: true, qrSlug: "scag-vride-001" },
  });
  const mower2 = await prisma.equipment.create({
    data: { type: "MOWER", brand: "Scag", model: "V-Ride II 48\"", shortDesc: "Commercial stand-on mower (compact)", longDesc: "48\" deck, 22hp Kawasaki FX691V. Same as the 52\" but fits through standard 48\" gates. Use this one for fenced residential backyards. Spare belt in under-seat compartment.", status: "AVAILABLE", energy: "Gas", dailyRate: 8.0, requiresInsurance: true, qrSlug: "scag-vride-002" },
  });
  const mower3 = await prisma.equipment.create({
    // Per-job billing example: $4/day cap, 4 equivalent jobs → $1/job. Lets
    // dev exercise the new model alongside flat-daily pieces on the same
    // equipment list.
    data: { type: "MOWER", brand: "Honda", model: "HRN216VKA", shortDesc: "21\" push mower", longDesc: "Self-propelled 21\" push mower. Use for small yards, tight areas, or slopes where stand-on is unsafe. Variable speed drive. Bag or mulch — switch plate under deck. Runs on regular unleaded.", status: "MAINTENANCE", energy: "Gas", dailyRate: 4.0, equivalentJobs: 4, qrSlug: "honda-hrn216-001", issues: "Blade needs sharpening" },
  });
  const mower4 = await prisma.equipment.create({
    data: { type: "MOWER", brand: "Toro", model: "TimeCutter 42\"", shortDesc: "Zero-turn residential mower", longDesc: "42\" zero-turn with 22.5hp Toro V-Twin. Good mid-size option for residential lawns too large for a push mower but too small for the Scags. Lap bars for steering. Fuel shutoff valve on left side.", status: "AVAILABLE", energy: "Gas", dailyRate: 6.0, qrSlug: "toro-tc42-001" },
  });
  await prisma.equipment.create({
    data: { type: "MOWER", brand: "EGO", model: "LM2135SP", shortDesc: "21\" self-propelled battery mower", longDesc: "Battery-powered push mower. Use for noise-sensitive properties (early morning jobs, near schools/hospitals). Two 5.0Ah batteries included — good for ~45 min combined runtime. Charge overnight before use.", status: "AVAILABLE", energy: "Battery", dailyRate: 4.0, qrSlug: "ego-lm2135-001" },
  });
  // Trimmers
  const trimmer1 = await prisma.equipment.create({
    data: { type: "TRIMMER", brand: "Stihl", model: "FS 131", shortDesc: "Professional string trimmer", longDesc: "36.3cc 4-MIX engine, bike handle. Our heaviest-duty trimmer — use for thick overgrowth, heavy weed patches, and commercial edging. Runs on 50:1 mix. Bump-feed head, .095 line. Harness in trailer.", status: "AVAILABLE", energy: "Gas", dailyRate: 3.0, qrSlug: "stihl-fs131-001" },
  });
  const trimmer2 = await prisma.equipment.create({
    data: { type: "TRIMMER", brand: "Stihl", model: "FS 91 R", shortDesc: "Lightweight string trimmer", longDesc: "28.4cc, loop handle. Lighter than the FS 131 — better for all-day use and detail work around beds, fences, and obstacles. Same 50:1 fuel mix. Tap-n-go head with .080 line.", status: "CHECKED_OUT", energy: "Gas", dailyRate: 2.0, qrSlug: "stihl-fs91r-001" },
  });
  await prisma.equipment.create({
    data: { type: "TRIMMER", brand: "Echo", model: "SRM-2620T", shortDesc: "Commercial string trimmer", longDesc: "25.4cc, i-start for easy pull. Good balance between power and weight. Use as a backup or second trimmer when running two-person crews. Speed-Feed 400 head — fast line reload without disassembly.", status: "AVAILABLE", energy: "Gas", dailyRate: 3.0, qrSlug: "echo-srm2620-001" },
  });
  // Hedgers
  const trimmer3 = await prisma.equipment.create({
    data: { type: "HEDGER", brand: "Stihl", model: "HS 82", shortDesc: "30\" hedge trimmer", longDesc: "30\" double-sided blade, 22.7cc. Best for boxwood, privet, and formal hedges up to 6ft. Cut from bottom up for even shape. Clean blades with resin solvent after each use. Blade guard in case.", status: "AVAILABLE", energy: "Gas", dailyRate: 3.0, qrSlug: "stihl-hs82-001" },
  });
  await prisma.equipment.create({
    data: { type: "HEDGER", brand: "Echo", model: "HC-2810", shortDesc: "28\" double-sided hedge trimmer", longDesc: "28\" blade, 21.2cc, lighter than the Stihl. Good for routine hedge maintenance and lighter trimming. Use for holly, jasmine, and other softer hedges. Less vibration — better for extended trimming sessions.", status: "AVAILABLE", energy: "Gas", dailyRate: 3.0, qrSlug: "echo-hc2810-001" },
  });
  // Blowers
  const blower1 = await prisma.equipment.create({
    data: { type: "BLOWER", brand: "Echo", model: "PB-8010T", shortDesc: "Backpack blower", longDesc: "79.9cc, 1071 CFM. Our most powerful blower — use for large parking lots, heavy leaf cleanup, and wet debris. Tube-mounted throttle. Hip-mounted frame reduces back fatigue. Ear protection required.", status: "CHECKED_OUT", energy: "Gas", dailyRate: 3.0, qrSlug: "echo-pb8010t-001" },
  });
  const blower2 = await prisma.equipment.create({
    data: { type: "BLOWER", brand: "Stihl", model: "BR 800 C-E", shortDesc: "Backpack blower (heavy duty)", longDesc: "79.9cc, 912 CFM. Similar power to the Echo PB-8010T. Electric start — no pull cord needed. Slightly heavier but easier to get going. Use interchangeably with the Echo for large cleanups.", status: "AVAILABLE", energy: "Gas", dailyRate: 3.0, qrSlug: "stihl-br800-001" },
  });
  const blower3 = await prisma.equipment.create({
    data: { type: "BLOWER", brand: "Echo", model: "PB-580T", shortDesc: "Backpack blower (mid-range)", longDesc: "58.2cc, 510 CFM. Lighter and quieter than the big blowers. Good for residential post-mow cleanup where you don't need maximum power. Less fuel consumption — runs longer on a tank.", status: "CHECKED_OUT", energy: "Gas", dailyRate: 2.0, qrSlug: "echo-pb580t-001" },
  });
  await prisma.equipment.create({
    data: { type: "BLOWER", brand: "EGO", model: "LB6504", shortDesc: "Battery backpack blower", longDesc: "56V battery, 600 CFM. Use for noise-restricted areas and early morning residential jobs. About 30 min runtime on turbo, 60 min on low. Charge overnight. Significantly quieter than gas units.", status: "AVAILABLE", energy: "Battery", dailyRate: 2.0, qrSlug: "ego-lb6504-001" },
  });
  // Edgers
  const edger1 = await prisma.equipment.create({
    data: { type: "EDGER", brand: "Stihl", model: "FC 91", shortDesc: "Professional edger", longDesc: "28.4cc dedicated edger. Use along sidewalks, driveways, and curbs for a clean defined line. 8\" blade. Adjust depth wheel for initial cut vs. maintenance pass. Blade lasts about 3 weeks of daily use.", status: "AVAILABLE", energy: "Gas", dailyRate: 3.0, qrSlug: "stihl-fc91-001" },
  });
  const edger2 = await prisma.equipment.create({
    data: { type: "EDGER", brand: "Echo", model: "PE-2620", shortDesc: "Stick edger", longDesc: "25.4cc stick-style edger. Lighter than the Stihl FC 91 — good for workers who prefer less weight. Converts to trimmer with attachment (attachment in trailer toolbox). Same 50:1 fuel mix.", status: "AVAILABLE", energy: "Gas", dailyRate: 2.0, qrSlug: "echo-pe2620-001" },
  });
  await prisma.equipment.create({
    data: { type: "EDGER", brand: "McLane", model: "101-4.75GT", shortDesc: "Gas powered lawn edger", longDesc: "Walk-behind wheeled edger. 3.5hp Briggs & Stratton engine. Use for properties with very long edge lines (300ft+) where a stick edger would be fatiguing. Cuts deeper and straighter than handheld edgers.", status: "AVAILABLE", energy: "Gas", dailyRate: 4.0, qrSlug: "mclane-101-001" },
  });
  // Cutters (chainsaws, pole saws)
  const chainsawEquip = await prisma.equipment.create({
    // Per-job billing example with a tighter equivalentJobs (heavy wear
    // per use): $5/day cap, 2 equivalent jobs → $2.50/job.
    data: { type: "CUTTER", brand: "Stihl", model: "MS 271", shortDesc: "20\" farm & ranch chainsaw", longDesc: "50.2cc, 20\" bar. Use for limb removal, storm cleanup, and tree work up to 18\" diameter. Pre-separation air filter — clean weekly. Chain tension: finger-tight with slight pull. Chaps required when operating.", status: "AVAILABLE", energy: "Gas", dailyRate: 5.0, equivalentJobs: 2, requiresInsurance: true, qrSlug: "stihl-ms271-001" },
  });
  await prisma.equipment.create({
    data: { type: "CUTTER", brand: "Stihl", model: "HT 135", shortDesc: "Telescoping pole pruner", longDesc: "Reaches up to 16ft without a ladder. 24.1cc, 12\" bar. Use for trimming overhead branches that are too high for the chainsaw. Extend slowly — gets heavy at full reach. Two-person operation recommended for stability.", status: "AVAILABLE", energy: "Gas", dailyRate: 4.0, qrSlug: "stihl-ht135-001" },
  });
  // Aerators
  const aerator = await prisma.equipment.create({
    data: { type: "AERATOR", brand: "Billy Goat", model: "AE401H", shortDesc: "19\" reciprocating aerator", longDesc: "160cc Honda engine, 19\" working width. Reciprocating tines — works better in clay soils than drum-style. Water the lawn 24h before aerating for best results. Clean tines after each property.", status: "AVAILABLE", energy: "Gas", dailyRate: 12.0, qrSlug: "billygoat-ae401-001" },
  });
  await prisma.equipment.create({
    data: { type: "AERATOR", brand: "Ryan", model: "Lawnaire V", shortDesc: "Core aerator — 5 tine", longDesc: "Drum-style core aerator with 5 tine assemblies. Heavier unit — better for large flat lawns. Pulls 3\" plugs. Transport with trailer only (too heavy for truck bed lift). Schedule in advance — high demand in spring/fall.", status: "AVAILABLE", energy: "Gas", dailyRate: 15.0, qrSlug: "ryan-lawnaire5-001" },
  });
  // Spreaders
  const spreader = await prisma.equipment.create({
    data: { type: "SPREADER", brand: "Lesco", model: "101186", shortDesc: "80lb broadcast spreader", longDesc: "80lb hopper capacity, stainless steel frame. Use for fertilizer, seed, and pre-emergent applications. Calibrate before each product — settings chart taped inside hopper lid. Wash out after every use to prevent corrosion.", status: "AVAILABLE", energy: "Manual", dailyRate: 2.0, qrSlug: "lesco-101186-001" },
  });
  await prisma.equipment.create({
    data: { type: "SPREADER", brand: "Earthway", model: "2150", shortDesc: "50lb commercial drop spreader", longDesc: "Drop spreader for precision application along borders, near flower beds, and sidewalks where broadcast would overshoot. 22\" spread width. Use when you need exact coverage without waste or drift.", status: "AVAILABLE", energy: "Manual", dailyRate: 2.0, qrSlug: "earthway-2150-001" },
  });
  // Washers
  const pressureWasher = await prisma.equipment.create({
    data: { type: "WASHER", brand: "Simpson", model: "MSH3125", shortDesc: "3100 PSI gas pressure washer", longDesc: "3100 PSI, 2.5 GPM, Honda GC190 engine. Use for driveways, sidewalks, fences, and siding. 25° nozzle for general cleaning, 15° for stubborn stains. Never use 0° on surfaces — will gouge. Bring own water hose (min 50ft).", status: "AVAILABLE", energy: "Gas", dailyRate: 8.0, qrSlug: "simpson-msh3125-001" },
  });
  await prisma.equipment.create({
    data: { type: "WASHER", brand: "Sun Joe", model: "SPX3000", shortDesc: "2030 PSI electric pressure washer", longDesc: "2030 PSI, 1.76 GPM, electric motor. Lower power than the Simpson but much quieter and no fumes — good for covered patios, screened porches, and indoor-adjacent areas. Needs a standard outdoor outlet (GFCI).", status: "AVAILABLE", energy: "Electric", dailyRate: 5.0, qrSlug: "sunjoe-spx3000-001" },
  });
  // Misc
  const trailer = await prisma.equipment.create({
    data: { type: "MISC", brand: "Big Tex", model: "35SA", shortDesc: "12ft single-axle utility trailer", longDesc: "12ft x 6.5ft bed, 2990lb GVWR. Ramp gate for loading mowers. Tie-down hooks every 2ft. Requires 2\" ball hitch and 7-pin connector. Check tire pressure weekly (50 PSI). Registration in glovebox of assigned truck.", status: "CHECKED_OUT", energy: "N/A", dailyRate: 6.0, qrSlug: "bigtex-35sa-001" },
  });
  const wheelbarrow = await prisma.equipment.create({
    data: { type: "MISC", brand: "Jackson", model: "M6T22", shortDesc: "6 cu ft steel wheelbarrow", longDesc: "6 cubic ft steel tray, pneumatic tire. Use for mulch spreading, debris hauling, and soil transport on properties. Flat tire — needs tube replaced before returning to service.", status: "RETIRED", energy: "Manual", dailyRate: 1.0, qrSlug: "jackson-m6t22-001", retiredAt: daysAgo(10) },
  });
  await prisma.equipment.create({
    data: { type: "MISC", brand: "Gorilla Carts", model: "GOR1200", shortDesc: "1200lb poly dump cart", longDesc: "1200lb capacity poly dump cart with pull handle. Dump lever for quick unloading. Use for large mulch jobs, gravel, or hauling bags of material across properties. Fits through 36\" gates. Pneumatic tires — check pressure monthly.", status: "AVAILABLE", energy: "Manual", dailyRate: 2.0, qrSlug: "gorilla-gor1200-001" },
  });

  // ── Equipment Collections ─────────────────────────────────────────────────
  console.log("  Creating equipment collections...");

  // Look up unnamed equipment by slug for kits that mix battery/quiet variants.
  const egoMower    = await prisma.equipment.findUnique({ where: { qrSlug: "ego-lm2135-001" } });
  const egoBlower   = await prisma.equipment.findUnique({ where: { qrSlug: "ego-lb6504-001" } });
  const echoTrimmer = await prisma.equipment.findUnique({ where: { qrSlug: "echo-srm2620-001" } });
  const mclaneEdger = await prisma.equipment.findUnique({ where: { qrSlug: "mclane-101-001" } });
  const ryanAerator = await prisma.equipment.findUnique({ where: { qrSlug: "ryan-lawnaire5-001" } });
  const earthwaySpreader = await prisma.equipment.findUnique({ where: { qrSlug: "earthway-2150-001" } });
  const echoHedger  = await prisma.equipment.findUnique({ where: { qrSlug: "echo-hc2810-001" } });
  const polePruner  = await prisma.equipment.findUnique({ where: { qrSlug: "stihl-ht135-001" } });

  type CollectionSeed = { name: string; description: string; sortOrder: number; equipmentIds: string[] };
  const collectionSeeds: CollectionSeed[] = [
    {
      name: "Standard Mowing",
      description: "Most common combo for residential mow + trim + edge + clean. Grab this one when in doubt.",
      sortOrder: 10,
      equipmentIds: [mower2.id, trimmer1.id, edger1.id, blower2.id],
    },
    {
      name: "Tight Spaces Mowing",
      description: "For properties with narrow gates, fenced backyards, or anywhere the stand-on won't fit.",
      sortOrder: 20,
      equipmentIds: [mower3.id, trimmer2.id, edger2.id, blower3.id],
    },
    {
      name: "Quiet / Early Morning",
      description: "Battery-powered for noise-sensitive properties, schools, hospitals, or pre-7am jobs.",
      sortOrder: 30,
      equipmentIds: [egoMower, echoTrimmer, edger2, egoBlower].filter(Boolean).map((e) => e!.id),
    },
    {
      name: "Hedge & Trim",
      description: "Hedge maintenance, formal shrubs, and detail work. Pair with the cleanup blower.",
      sortOrder: 40,
      equipmentIds: [trimmer3.id, ...(echoHedger ? [echoHedger.id] : []), blower3.id],
    },
    {
      name: "Spring Cleanup",
      description: "Heavy debris, branch removal, and post-winter property restoration.",
      sortOrder: 50,
      equipmentIds: [blower1.id, blower2.id, chainsawEquip.id],
    },
    {
      name: "Fall Cleanup",
      description: "Leaf cleanup, gutter prep, and overhead branch trimming heading into winter.",
      sortOrder: 60,
      equipmentIds: [blower1.id, blower2.id, ...(polePruner ? [polePruner.id] : [])],
    },
    {
      name: "Aeration & Seeding",
      description: "Spring/fall aeration with overseeding and starter fertilizer.",
      sortOrder: 70,
      equipmentIds: [aerator.id, ...(ryanAerator ? [ryanAerator.id] : []), spreader.id, ...(earthwaySpreader ? [earthwaySpreader.id] : [])],
    },
    {
      name: "Long-Edge Cleanup",
      description: "Properties with very long curb or driveway edges (300+ ft) where a stick edger gets fatiguing.",
      sortOrder: 80,
      equipmentIds: [...(mclaneEdger ? [mclaneEdger.id] : []), trimmer1.id, blower2.id],
    },
  ];

  const collectionIdByName: Record<string, string> = {};
  for (const c of collectionSeeds) {
    const created = await prisma.equipmentCollection.create({
      data: {
        name: c.name,
        description: c.description,
        sortOrder: c.sortOrder,
        items: {
          create: c.equipmentIds.map((id, idx) => ({ equipmentId: id, sortOrder: 100 + idx })),
        },
      },
    });
    collectionIdByName[c.name] = created.id;
  }

  // ── Groups (crews) ─────────────────────────────────────────────────────────
  // Three groups demonstrate the main patterns:
  //  • Alpha Crew    — admin claimer, full roster, mix of worker/observer,
  //                    no custom percents (defaults to even split).
  //  • Quiet Hours   — employee claimer, custom 60/40 percents to show the
  //                    cost-split UI.
  //  • Spring Cleanup Solo — single-member group (just the claimer) for the
  //                    "I always work alone but rent under this crew" pattern.
  console.log("  Creating groups...");

  const alphaCrew = await prisma.group.create({
    data: {
      name: "Alpha Crew",
      description: "Primary mowing crew — standard residential + light commercial.",
      claimerUserId: ADMIN_WORKER_ID,
      members: {
        create: [
          { userId: EMPLOYEE_ID, role: "worker" },
          { userId: CONTRACTOR_ID, role: "worker" },
          { userId: TRAINEE_ID, role: "observer" },
        ],
      },
      preferredEquipment: {
        create: [
          { equipmentCollectionId: collectionIdByName["Standard Mowing"], sortOrder: 10 },
          { equipmentId: blower1.id, sortOrder: 20 },
        ],
      },
    },
  });

  const quietHoursCrew = await prisma.group.create({
    data: {
      name: "Quiet Hours Crew",
      description: "Battery-powered crew for noise-sensitive properties (schools, hospitals, pre-7am).",
      claimerUserId: EMPLOYEE_ID,
      members: {
        create: [
          // Custom 60/40 split: claimer (EMPLOYEE) gets 60%, CONTRACTOR gets 40%.
          // Claimer's slot is implicit; we encode their percent via a workaround
          // — see below: we add their percent to one of the worker rows.
          // Actually, because the claimer is implicit, the percent UI tracks
          // the claimer's portion separately. For DB-level seeding we set
          // CONTRACTOR_ID's percent and leave the claimer's slot unset — this
          // intentionally creates an "incomplete percent set" state that the
          // UI will surface as "percents don't sum to 100, edit to fix" so the
          // user can see what that validation looks like.
          { userId: CONTRACTOR_ID, role: "worker", equipmentCostPercent: 40 },
        ],
      },
      preferredEquipment: {
        create: [
          { equipmentCollectionId: collectionIdByName["Quiet / Early Morning"], sortOrder: 10 },
        ],
      },
    },
  });

  const springSolo = await prisma.group.create({
    data: {
      name: "Spring Cleanup (solo)",
      description: "Just one person for now — useful for renting equipment under a named crew.",
      claimerUserId: CONTRACTOR_ID,
      preferredEquipment: {
        create: [
          { equipmentCollectionId: collectionIdByName["Spring Cleanup"], sortOrder: 10 },
        ],
      },
    },
  });

  // Quiet Hours: fix up the implicit-claimer percent so the group is valid.
  // We can't store the claimer's percent on a GroupMember row (claimer is
  // implicit), so to make percents sum to 100 we'd need a different schema.
  // For now, reset Quiet Hours to even-split by clearing the custom percent —
  // keeps the seed clean. (Admins can edit on the Groups tab to re-introduce
  // percents through the proper UI flow.)
  await prisma.groupMember.updateMany({
    where: { groupId: quietHoursCrew.id, userId: CONTRACTOR_ID },
    data: { equipmentCostPercent: null },
  });

  // Group ids surfaced for the "pre-attach to an occurrence" step below.
  void springSolo;
  void quietHoursCrew;

  // ── Equipment instructions ─────────────────────────────────────────────────
  console.log("  Creating equipment instructions...");

  await prisma.equipmentInstruction.createMany({
    data: [
      // mower1 (Scag 52") — large, finicky
      { equipmentId: mower1.id, text: "Hard to start when cold — let choke run for 30s", isPreset: false, sortOrder: 0 },
      { equipmentId: mower1.id, text: "Refuel before returning", isPreset: true, sortOrder: 1 },

      // mower3 (Honda push, in maintenance)
      { equipmentId: mower3.id, text: "Sharp blade — handle with care", isPreset: true, sortOrder: 0 },

      // trimmer1 (Stihl FS 131)
      { equipmentId: trimmer1.id, text: "Loud — wear ear protection", isPreset: true, sortOrder: 0 },
      { equipmentId: trimmer1.id, text: "Uses 50:1 fuel mix only", isPreset: false, sortOrder: 1 },

      // blower1 (Echo PB-8010T) — heavy
      { equipmentId: blower1.id, text: "Heavy — two-person carry", isPreset: true, sortOrder: 0 },
      { equipmentId: blower1.id, text: "Loud — wear ear protection", isPreset: true, sortOrder: 1 },

      // chainsaw — safety
      { equipmentId: chainsawEquip.id, text: "Chaps required when operating", isPreset: false, sortOrder: 0 },
      { equipmentId: chainsawEquip.id, text: "Sharp blade — handle with care", isPreset: true, sortOrder: 1 },

      // aerator — heavy/awkward
      { equipmentId: aerator.id, text: "Heavy — two-person carry", isPreset: true, sortOrder: 0 },

      // pressure washer
      { equipmentId: pressureWasher.id, text: "Never use 0° nozzle on surfaces", isPreset: false, sortOrder: 0 },

      // trailer
      { equipmentId: trailer.id, text: "Check tire pressure weekly (50 PSI)", isPreset: false, sortOrder: 0 },
    ],
  });

  // ── Equipment checkouts (5 active) ────────────────────────────────────────
  console.log("  Creating checkouts...");

  await prisma.checkout.create({ data: { equipmentId: mower1.id, userId: EMPLOYEE_ID, reservedAt: daysAgo(5), checkedOutAt: daysAgo(5) } });
  await prisma.checkout.create({ data: { equipmentId: blower1.id, userId: CONTRACTOR_ID, reservedAt: daysAgo(3), checkedOutAt: daysAgo(3) } });
  await prisma.checkout.create({ data: { equipmentId: trimmer2.id, userId: ADMIN_WORKER_ID, reservedAt: daysAgo(2), checkedOutAt: daysAgo(2) } });
  await prisma.checkout.create({ data: { equipmentId: blower3.id, userId: TRAINEE_ID, reservedAt: daysAgo(1), checkedOutAt: daysAgo(1) } });
  await prisma.checkout.create({ data: { equipmentId: trailer.id, userId: ADMIN_WORKER_ID, reservedAt: daysAgo(7), checkedOutAt: daysAgo(7) } });
  // Past returned checkout
  await prisma.checkout.create({ data: { equipmentId: chainsawEquip.id, userId: CONTRACTOR_ID, reservedAt: daysAgo(14), checkedOutAt: daysAgo(14), releasedAt: daysAgo(12), rentalDays: 2, rentalCost: 10.0 } });

  // ── Jobs (18) ─────────────────────────────────────────────────────────────
  console.log("  Creating jobs...");

  // Harrington (VIP) - 2 recurring
  const harringtonMow = await prisma.job.create({
    data: { propertyId: harringtonMain.id, kind: "SINGLE_ADDRESS", status: "ACCEPTED", frequencyDays: 7, defaultPrice: 85.0, estimatedMinutes: 45, notes: "Premium mow + edge + blow. Client prefers diagonal mowing pattern on the front lawn. Make sure to bag clippings near the flower beds on the east side of the property. Do not use the riding mower near the stone pathway — push mow that section. Eleanor sometimes leaves garden tools near the side gate, just move them carefully." },
  });
  const harringtonLakeMow = await prisma.job.create({
    data: { propertyId: harringtonLake.id, kind: "SINGLE_ADDRESS", status: "ACCEPTED", frequencyDays: 7, defaultPrice: 65.0, estimatedMinutes: 35, notes: "Standard mow service" },
  });

  // Martinez - 1 recurring
  const martinezBiweekly = await prisma.job.create({
    data: { propertyId: martinezHome.id, kind: "SINGLE_ADDRESS", status: "ACCEPTED", frequencyDays: 14, defaultPrice: 55.0, estimatedMinutes: 40, notes: "Full service biweekly" },
  });

  // Willowbrook HOA - 2 recurring
  const willowbrookWeekly = await prisma.job.create({
    data: { propertyId: willowbrookCommon.id, kind: "ENTIRE_SITE", status: "ACCEPTED", frequencyDays: 7, defaultPrice: 250.0, estimatedMinutes: 120, notes: "Common area maintenance. Includes the main green space, walking paths (edge both sides), playground perimeter, and the retention pond embankment. Susan wants the grass kept at 3 inches max. Skip the area behind the clubhouse if an event is set up — check the bulletin board at the entrance. The irrigation system runs Tuesday mornings so the ground may be wet early." },
  });
  const willowbrookPoolMow = await prisma.job.create({
    data: { propertyId: willowbrookPool.id, kind: "SINGLE_ADDRESS", status: "ACCEPTED", frequencyDays: 14, defaultPrice: 75.0, estimatedMinutes: 30, notes: "Pool area trim and blow" },
  });

  // Chen - 1 one-off, 1 estimate
  const chenLeafCleanup = await prisma.job.create({
    data: { propertyId: chenHome.id, kind: "SINGLE_ADDRESS", status: "ACCEPTED", defaultPrice: 120.0, estimatedMinutes: 90, notes: "Fall leaf cleanup - one time" },
  });
  const chenTreeEstimate = await prisma.job.create({
    data: { propertyId: chenHome.id, kind: "SINGLE_ADDRESS", status: "PROPOSED", notes: "Tree trimming estimate for backyard oaks" },
  });

  // Thompson (VIP) - 2 recurring
  const thompsonMow = await prisma.job.create({
    data: { propertyId: thompsonMain.id, kind: "SINGLE_ADDRESS", status: "ACCEPTED", frequencyDays: 7, defaultPrice: 125.0, estimatedMinutes: 60, notes: "Full service with hedge trimming" },
  });
  const thompsonGuestMow = await prisma.job.create({
    data: { propertyId: thompsonGuest.id, kind: "SINGLE_ADDRESS", status: "ACCEPTED", frequencyDays: 14, defaultPrice: 55.0, estimatedMinutes: 30, notes: "Basic mow and blow" },
  });

  // O'Brien - 1 recurring
  const obrienMow = await prisma.job.create({
    data: { propertyId: obrienHome.id, kind: "SINGLE_ADDRESS", status: "ACCEPTED", frequencyDays: 7, defaultPrice: 60.0, estimatedMinutes: 35, notes: "Weekly mow - watch for dog" },
  });

  // Sunrise HOA - 1 recurring
  const sunriseWeekly = await prisma.job.create({
    data: { propertyId: sunriseCommon.id, kind: "ENTIRE_SITE", status: "ACCEPTED", frequencyDays: 7, defaultPrice: 350.0, estimatedMinutes: 180, notes: "Full common area service" },
  });

  // Patel - 1 recurring, 1 one-off
  const patelMow = await prisma.job.create({
    data: { propertyId: patelHome.id, kind: "SINGLE_ADDRESS", status: "ACCEPTED", frequencyDays: 7, defaultPrice: 45.0, estimatedMinutes: 25, notes: "Small yard, quick mow" },
  });
  const patelAeration = await prisma.job.create({
    data: { propertyId: patelHome.id, kind: "SINGLE_ADDRESS", status: "ACCEPTED", defaultPrice: 150.0, estimatedMinutes: 60, notes: "Fall aeration - one time" },
  });

  // River Bend Office Park - 1 recurring
  const riverBendWeekly = await prisma.job.create({
    data: { propertyId: riverBendCampus.id, kind: "ENTIRE_SITE", status: "ACCEPTED", frequencyDays: 7, defaultPrice: 400.0, estimatedMinutes: 150, notes: "Full campus grounds maintenance. Three buildings with separate lawn areas. Building A has the main entrance with flower beds that need weekly weeding. Building B has a courtyard that requires hand trimming around the benches. Building C backs up to the creek — do NOT blow debris into the water (environmental compliance). Parking lot islands need edging every other week. Tom usually meets us at 7am at the loading dock with the gate code." },
  });

  // Kim - 1 recurring
  const kimMow = await prisma.job.create({
    data: { propertyId: kimHome.id, kind: "SINGLE_ADDRESS", status: "ACCEPTED", frequencyDays: 14, defaultPrice: 50.0, estimatedMinutes: 30, notes: "Biweekly mow and edge" },
  });

  // Church - 1 recurring, 1 estimate
  const churchWeekly = await prisma.job.create({
    data: { propertyId: churchGrounds.id, kind: "ENTIRE_SITE", status: "ACCEPTED", frequencyDays: 7, defaultPrice: 200.0, estimatedMinutes: 90, notes: "Grounds maintenance - avoid Sunday mornings" },
  });
  const churchPressureWash = await prisma.job.create({
    data: { propertyId: churchGrounds.id, kind: "ENTIRE_SITE", status: "PROPOSED", notes: "Pressure wash walkways and parking lot estimate" },
  });

  // ── JobClients ────────────────────────────────────────────────────────────
  console.log("  Creating job-client links...");

  const allJobs: { job: { id: string }; client: { id: string }; contact: { id: string } }[] = [
    { job: harringtonMow, client: vipClient, contact: harringtonPrimary },
    { job: harringtonLakeMow, client: vipClient, contact: harringtonSpouse },
    { job: martinezBiweekly, client: martinezFamily, contact: martinezPrimary },
    { job: willowbrookWeekly, client: willowbrookHoa, contact: willowbrookManager },
    { job: willowbrookPoolMow, client: willowbrookHoa, contact: willowbrookManager },
    { job: chenLeafCleanup, client: chenResidence, contact: chenPrimary },
    { job: chenTreeEstimate, client: chenResidence, contact: chenPrimary },
    { job: thompsonMow, client: vipThompson, contact: thompsonPrimary },
    { job: thompsonGuestMow, client: vipThompson, contact: thompsonSpouse },
    { job: obrienMow, client: obrienFamily, contact: obrienPrimary },
    { job: sunriseWeekly, client: sunriseHoa, contact: sunriseManager },
    { job: patelMow, client: patelResidence, contact: patelPrimary },
    { job: patelAeration, client: patelResidence, contact: patelPrimary },
    { job: riverBendWeekly, client: riverBend, contact: riverBendManager },
    { job: kimMow, client: kimResidence, contact: kimPrimary },
    { job: churchWeekly, client: lakesideChurch, contact: churchPrimary },
    { job: churchPressureWash, client: lakesideChurch, contact: churchPrimary },
  ];

  for (const { job, client } of allJobs) {
    await prisma.jobClient.create({ data: { jobId: job.id, clientId: client.id, role: "owner" } });
  }

  // ── JobRecommendedCollections ─────────────────────────────────────────────
  console.log("  Creating job-recommended-collection links...");

  type JobCollectionLink = { jobId: string; collectionName: string; sortOrder?: number };
  const jobCollectionLinks: JobCollectionLink[] = [
    // VIP residential — premium combo
    { jobId: harringtonMow.id, collectionName: "Standard Mowing" },
    { jobId: harringtonLakeMow.id, collectionName: "Standard Mowing" },
    // Standard biweekly residential
    { jobId: martinezBiweekly.id, collectionName: "Standard Mowing" },
    // HOAs
    { jobId: willowbrookWeekly.id, collectionName: "Standard Mowing" },
    { jobId: willowbrookWeekly.id, collectionName: "Long-Edge Cleanup", sortOrder: 110 },
    { jobId: sunriseWeekly.id, collectionName: "Standard Mowing" },
    { jobId: riverBendWeekly.id, collectionName: "Standard Mowing" },
    // Tight-spaces / fenced backyard pool area
    { jobId: willowbrookPoolMow.id, collectionName: "Tight Spaces Mowing" },
    // Leaf cleanup
    { jobId: chenLeafCleanup.id, collectionName: "Fall Cleanup" },
    // Aeration job
    { jobId: patelAeration.id, collectionName: "Aeration & Seeding" },
    // Church grounds — extra cleanup since it's a public space
    { jobId: churchWeekly.id, collectionName: "Standard Mowing" },
    { jobId: churchWeekly.id, collectionName: "Hedge & Trim", sortOrder: 110 },
    // Quiet collection for early-morning HOA
    { jobId: thompsonMow.id, collectionName: "Quiet / Early Morning" },
  ];

  for (const link of jobCollectionLinks) {
    const collectionId = collectionIdByName[link.collectionName];
    if (!collectionId) continue;
    await prisma.jobRecommendedCollection.create({
      data: { jobId: link.jobId, collectionId, sortOrder: link.sortOrder ?? 100 },
    });
  }

  // ── JobContacts ───────────────────────────────────────────────────────────
  console.log("  Creating job-contact links...");

  for (const { job, contact } of allJobs) {
    await prisma.jobContact.create({ data: { jobId: job.id, clientContactId: contact.id, role: "decision_maker" } });
  }

  // ── JobSchedules (recurring jobs only) ────────────────────────────────────
  console.log("  Creating schedules...");

  const schedules: { jobId: string; cadence: "WEEKLY" | "BIWEEKLY" | "MONTHLY"; interval: number; dayOfWeek: number; startH: number; endH: number; horizon?: number }[] = [
    { jobId: harringtonMow.id, cadence: "WEEKLY", interval: 1, dayOfWeek: 1, startH: 8, endH: 12 },
    { jobId: harringtonLakeMow.id, cadence: "WEEKLY", interval: 1, dayOfWeek: 1, startH: 13, endH: 17 },
    { jobId: martinezBiweekly.id, cadence: "BIWEEKLY", interval: 2, dayOfWeek: 3, startH: 8, endH: 12 },
    { jobId: willowbrookWeekly.id, cadence: "WEEKLY", interval: 1, dayOfWeek: 2, startH: 7, endH: 15 },
    { jobId: willowbrookPoolMow.id, cadence: "BIWEEKLY", interval: 2, dayOfWeek: 4, startH: 8, endH: 10 },
    { jobId: thompsonMow.id, cadence: "WEEKLY", interval: 1, dayOfWeek: 3, startH: 9, endH: 13 },
    { jobId: thompsonGuestMow.id, cadence: "BIWEEKLY", interval: 2, dayOfWeek: 3, startH: 14, endH: 16 },
    { jobId: obrienMow.id, cadence: "WEEKLY", interval: 1, dayOfWeek: 4, startH: 8, endH: 11 },
    { jobId: sunriseWeekly.id, cadence: "WEEKLY", interval: 1, dayOfWeek: 5, startH: 7, endH: 14 },
    { jobId: patelMow.id, cadence: "WEEKLY", interval: 1, dayOfWeek: 2, startH: 15, endH: 17 },
    { jobId: riverBendWeekly.id, cadence: "WEEKLY", interval: 1, dayOfWeek: 1, startH: 6, endH: 12 },
    { jobId: kimMow.id, cadence: "BIWEEKLY", interval: 2, dayOfWeek: 5, startH: 10, endH: 12 },
    { jobId: churchWeekly.id, cadence: "WEEKLY", interval: 1, dayOfWeek: 2, startH: 14, endH: 17 },
  ];

  for (const s of schedules) {
    await prisma.jobSchedule.create({
      data: {
        jobId: s.jobId,
        cadence: s.cadence,
        interval: s.interval,
        dayOfWeek: s.dayOfWeek,
        preferredStartHour: s.startH,
        preferredEndHour: s.endH,
        autoRenew: true,
        horizonDays: s.horizon ?? 21,
        nextGenerateAt: daysFromNow(s.interval === 1 ? 7 : 14),
        active: true,
      },
    });
  }

  // ── JobAssigneeDefaults ───────────────────────────────────────────────────
  console.log("  Creating default assignees...");

  const defaults: { jobId: string; userId: string; role: string }[] = [
    { jobId: harringtonMow.id, userId: ADMIN_WORKER_ID, role: "primary" },
    { jobId: harringtonMow.id, userId: EMPLOYEE_ID, role: "helper" },
    { jobId: harringtonLakeMow.id, userId: CONTRACTOR_ID, role: "primary" },
    { jobId: martinezBiweekly.id, userId: EMPLOYEE_ID, role: "primary" },
    { jobId: willowbrookWeekly.id, userId: ADMIN_WORKER_ID, role: "primary" },
    { jobId: willowbrookWeekly.id, userId: CONTRACTOR_ID, role: "helper" },
    { jobId: thompsonMow.id, userId: CONTRACTOR_ID, role: "primary" },
    { jobId: thompsonMow.id, userId: TRAINEE_ID, role: "helper" },
    { jobId: obrienMow.id, userId: EMPLOYEE_ID, role: "primary" },
    { jobId: sunriseWeekly.id, userId: ADMIN_WORKER_ID, role: "primary" },
    { jobId: sunriseWeekly.id, userId: EMPLOYEE_ID, role: "helper" },
    { jobId: sunriseWeekly.id, userId: CONTRACTOR_ID, role: "helper" },
    { jobId: patelMow.id, userId: EMPLOYEE_ID, role: "primary" },
    { jobId: patelMow.id, userId: TRAINEE_ID, role: "helper" },
    { jobId: riverBendWeekly.id, userId: ADMIN_WORKER_ID, role: "primary" },
    { jobId: riverBendWeekly.id, userId: CONTRACTOR_ID, role: "helper" },
    { jobId: kimMow.id, userId: EMPLOYEE_ID, role: "primary" },
    { jobId: churchWeekly.id, userId: EMPLOYEE_ID, role: "primary" },
  ];
  for (const d of defaults) {
    await prisma.jobAssigneeDefault.create({ data: d });
  }

  // ── Helper to create occurrence + assignees ───────────────────────────────
  // type OccData — using any for flexibility with new fields
  type Assignee = { userId: string; role?: string };

  async function occ(data: any, assignees?: Assignee[]) {
    // Default-stamp hoursApprovedAt to completedAt for any occurrence that
    // has a completion time — mirrors the auto-approve path that runs at
    // runtime when actual hours fall within the variance threshold. Lets
    // seeded "happy path" rows pass through without flooding the
    // unapproved-hours alert queue. Outlier rows opt out by passing
    // `hoursApprovedAt: null` explicitly.
    if (data.completedAt && data.hoursApprovedAt === undefined) {
      data = { ...data, hoursApprovedAt: data.completedAt };
    }
    const o = await prisma.jobOccurrence.create({ data });
    if (assignees?.length) {
      for (const a of assignees) {
        await prisma.jobOccurrenceAssignee.create({
          data: { occurrenceId: o.id, userId: a.userId, role: a.role ?? null, assignedById: ADMIN_WORKER_ID },
        });
      }
    }
    return o;
  }

  // ── Job Occurrences (~60) ─────────────────────────────────────────────────
  console.log("  Creating occurrences...");

  // ─── COMPLETED (past) ─────────────────────────────────────────────────────
  const cHarrington21 = await occ(
    { jobId: harringtonMow.id, kind: "SINGLE_ADDRESS", startAt: daysAgo(21, 8), endAt: addMinutes(daysAgo(21, 8), 45), status: "CLOSED", workflow: "STANDARD", jobTags: '["MOW","TRIM","BLOW"]', price: 85.0, estimatedMinutes: 45, startedAt: daysAgo(21, 8), completedAt: addMinutes(daysAgo(21, 8), 40) },
    [{ userId: ADMIN_WORKER_ID, role: "primary" }, { userId: EMPLOYEE_ID, role: "helper" }],
  );
  const cHarrington14 = await occ(
    { jobId: harringtonMow.id, kind: "SINGLE_ADDRESS", startAt: daysAgo(14, 8), endAt: addMinutes(daysAgo(14, 8), 45), status: "CLOSED", workflow: "STANDARD", jobTags: '["MOW","TRIM","BLOW"]', price: 85.0, estimatedMinutes: 45, startedAt: daysAgo(14, 8), completedAt: addMinutes(daysAgo(14, 8), 42) },
    [{ userId: ADMIN_WORKER_ID, role: "primary" }, { userId: EMPLOYEE_ID, role: "helper" }],
  );
  const cHarrington7 = await occ(
    { jobId: harringtonMow.id, kind: "SINGLE_ADDRESS", startAt: daysAgo(6, 8), endAt: addMinutes(daysAgo(6, 8), 45), status: "CLOSED", workflow: "STANDARD", jobTags: '["MOW","TRIM","BLOW"]', price: 85.0, estimatedMinutes: 45, startedAt: daysAgo(6, 8), completedAt: addMinutes(daysAgo(6, 8), 50) },
    [{ userId: ADMIN_WORKER_ID, role: "primary" }, { userId: EMPLOYEE_ID, role: "helper" }],
  );
  const cLake14 = await occ(
    { jobId: harringtonLakeMow.id, kind: "SINGLE_ADDRESS", startAt: daysAgo(14, 13), endAt: addMinutes(daysAgo(14, 13), 35), status: "CLOSED", workflow: "STANDARD", jobTags: '["MOW"]', price: 65.0, estimatedMinutes: 35, startedAt: daysAgo(14, 13), completedAt: addMinutes(daysAgo(14, 13), 30) },
    [{ userId: CONTRACTOR_ID, role: "primary" }],
  );
  const cLake7 = await occ(
    { jobId: harringtonLakeMow.id, kind: "SINGLE_ADDRESS", startAt: daysAgo(6, 13), endAt: addMinutes(daysAgo(6, 13), 35), status: "CLOSED", workflow: "STANDARD", jobTags: '["MOW"]', price: 65.0, estimatedMinutes: 35, startedAt: daysAgo(6, 13), completedAt: addMinutes(daysAgo(6, 13), 32) },
    [{ userId: CONTRACTOR_ID, role: "primary" }],
  );
  const cMartinez14 = await occ(
    { jobId: martinezBiweekly.id, kind: "SINGLE_ADDRESS", startAt: daysAgo(14, 9), endAt: addMinutes(daysAgo(14, 9), 40), status: "CLOSED", workflow: "STANDARD", jobTags: '["MOW","TRIM","EDGE","BLOW"]', price: 55.0, estimatedMinutes: 40, startedAt: daysAgo(14, 9), completedAt: addMinutes(daysAgo(14, 9), 38) },
    [{ userId: EMPLOYEE_ID, role: "primary" }],
  );
  const cWillowbrook14 = await occ(
    { jobId: willowbrookWeekly.id, kind: "ENTIRE_SITE", startAt: daysAgo(14, 7), endAt: addMinutes(daysAgo(14, 7), 120), status: "CLOSED", workflow: "STANDARD", jobTags: '["MOW","TRIM","BLOW"]', price: 250.0, estimatedMinutes: 120, startedAt: daysAgo(14, 7), completedAt: addMinutes(daysAgo(14, 7), 110) },
    [{ userId: ADMIN_WORKER_ID, role: "primary" }, { userId: CONTRACTOR_ID, role: "helper" }],
  );
  const cWillowbrook7 = await occ(
    { jobId: willowbrookWeekly.id, kind: "ENTIRE_SITE", startAt: daysAgo(5, 7), endAt: addMinutes(daysAgo(5, 7), 120), status: "CLOSED", workflow: "STANDARD", jobTags: '["MOW","TRIM","BLOW"]', price: 250.0, estimatedMinutes: 120, startedAt: daysAgo(5, 7), completedAt: addMinutes(daysAgo(5, 7), 115) },
    [{ userId: ADMIN_WORKER_ID, role: "primary" }, { userId: CONTRACTOR_ID, role: "helper" }],
  );
  const cThompson14 = await occ(
    { jobId: thompsonMow.id, kind: "SINGLE_ADDRESS", startAt: daysAgo(14, 9), endAt: addMinutes(daysAgo(14, 9), 60), status: "CLOSED", workflow: "STANDARD", jobTags: '["MOW","TRIM","EDGE","BLOW"]', price: 125.0, estimatedMinutes: 60, startedAt: daysAgo(14, 9), completedAt: addMinutes(daysAgo(14, 9), 55) },
    [{ userId: CONTRACTOR_ID, role: "primary" }, { userId: TRAINEE_ID, role: "helper" }],
  );
  const cThompson7 = await occ(
    { jobId: thompsonMow.id, kind: "SINGLE_ADDRESS", startAt: daysAgo(5, 9), endAt: addMinutes(daysAgo(5, 9), 60), status: "CLOSED", workflow: "STANDARD", jobTags: '["MOW","TRIM","EDGE","BLOW"]', price: 125.0, estimatedMinutes: 60, startedAt: daysAgo(5, 9), completedAt: addMinutes(daysAgo(5, 9), 58) },
    [{ userId: CONTRACTOR_ID, role: "primary" }, { userId: TRAINEE_ID, role: "helper" }],
  );
  const cObrien7 = await occ(
    { jobId: obrienMow.id, kind: "SINGLE_ADDRESS", startAt: daysAgo(4, 8), endAt: addMinutes(daysAgo(4, 8), 35), status: "CLOSED", workflow: "STANDARD", jobTags: '["MOW"]', price: 60.0, estimatedMinutes: 35, startedAt: daysAgo(4, 8), completedAt: addMinutes(daysAgo(4, 8), 33) },
    [{ userId: EMPLOYEE_ID, role: "primary" }],
  );
  const cSunrise7 = await occ(
    { jobId: sunriseWeekly.id, kind: "ENTIRE_SITE", startAt: daysAgo(6, 7), endAt: addMinutes(daysAgo(6, 7), 180), status: "CLOSED", workflow: "STANDARD", jobTags: '["MOW","TRIM","EDGE","BLOW"]', price: 350.0, estimatedMinutes: 180, startedAt: daysAgo(6, 7), completedAt: addMinutes(daysAgo(6, 7), 170) },
    [{ userId: ADMIN_WORKER_ID, role: "primary" }, { userId: EMPLOYEE_ID, role: "helper" }, { userId: CONTRACTOR_ID, role: "helper" }],
  );
  const cPatel7 = await occ(
    { jobId: patelMow.id, kind: "SINGLE_ADDRESS", startAt: daysAgo(3, 15), endAt: addMinutes(daysAgo(3, 15), 25), status: "CLOSED", workflow: "STANDARD", jobTags: '["MOW"]', price: 45.0, estimatedMinutes: 25, startedAt: daysAgo(3, 15), completedAt: addMinutes(daysAgo(3, 15), 22) },
    [{ userId: EMPLOYEE_ID, role: "primary" }, { userId: TRAINEE_ID, role: "helper" }],
  );
  const cRiverBend7 = await occ(
    { jobId: riverBendWeekly.id, kind: "ENTIRE_SITE", startAt: daysAgo(6, 6), endAt: addMinutes(daysAgo(6, 6), 150), status: "CLOSED", workflow: "STANDARD", jobTags: '["MOW","TRIM","BLOW"]', price: 400.0, estimatedMinutes: 150, startedAt: daysAgo(6, 6), completedAt: addMinutes(daysAgo(6, 6), 145) },
    [{ userId: ADMIN_WORKER_ID, role: "primary" }, { userId: CONTRACTOR_ID, role: "helper" }],
  );
  const cChurch7 = await occ(
    { jobId: churchWeekly.id, kind: "ENTIRE_SITE", startAt: daysAgo(5, 14), endAt: addMinutes(daysAgo(5, 14), 90), status: "CLOSED", workflow: "STANDARD", jobTags: '["MOW","TRIM","BLOW"]', price: 200.0, estimatedMinutes: 90, startedAt: daysAgo(5, 14), completedAt: addMinutes(daysAgo(5, 14), 85) },
    [{ userId: EMPLOYEE_ID, role: "primary" }],
  );
  const cKim14 = await occ(
    { jobId: kimMow.id, kind: "SINGLE_ADDRESS", startAt: daysAgo(14, 10), endAt: addMinutes(daysAgo(14, 10), 30), status: "CLOSED", workflow: "STANDARD", jobTags: '["MOW"]', price: 50.0, estimatedMinutes: 30, startedAt: daysAgo(14, 10), completedAt: addMinutes(daysAgo(14, 10), 28) },
    [{ userId: EMPLOYEE_ID, role: "primary" }],
  );

  // ─── HOURS-APPROVAL OUTLIERS ──────────────────────────────────────────────
  // Explicit hoursApprovedAt: null marks these rows as "needs review" —
  // they exercise the title-bar alert badge, the orange chip on the card,
  // the Approve Hours button, and the W-2 export pre-download warning.
  // Each has an actual time deliberately outside the 30% variance window.
  const cMartinezOutlier = await occ(
    {
      jobId: martinezBiweekly.id, kind: "SINGLE_ADDRESS",
      startAt: daysAgo(7, 9), endAt: addMinutes(daysAgo(7, 9), 40),
      status: "CLOSED", workflow: "STANDARD",
      jobTags: '["MOW","TRIM","EDGE","BLOW"]',
      price: 55.0, estimatedMinutes: 40,
      startedAt: daysAgo(7, 9),
      // 40-min estimate, 1 worker, actual 70 min → 75% over → unapproved
      completedAt: addMinutes(daysAgo(7, 9), 70),
      hoursApprovedAt: null,
    },
    [{ userId: EMPLOYEE_ID, role: "primary" }],
  );
  const cChurchOutlier = await occ(
    {
      jobId: churchWeekly.id, kind: "ENTIRE_SITE",
      startAt: daysAgo(12, 14), endAt: addMinutes(daysAgo(12, 14), 90),
      status: "CLOSED", workflow: "STANDARD",
      jobTags: '["MOW","TRIM","BLOW"]',
      price: 200.0, estimatedMinutes: 90,
      startedAt: daysAgo(12, 14),
      // 90-min estimate, 1 worker, actual 145 min → 61% over → unapproved
      completedAt: addMinutes(daysAgo(12, 14), 145),
      hoursApprovedAt: null,
    },
    [{ userId: CONTRACTOR_ID, role: "primary" }],
  );
  // Under-estimate outlier: worker finished much faster than expected.
  const cKimOutlier = await occ(
    {
      jobId: kimMow.id, kind: "SINGLE_ADDRESS",
      startAt: daysAgo(2, 10), endAt: addMinutes(daysAgo(2, 10), 30),
      status: "PENDING_PAYMENT", workflow: "STANDARD",
      jobTags: '["MOW"]',
      price: 50.0, estimatedMinutes: 30,
      startedAt: daysAgo(2, 10),
      // 30-min estimate, 1 worker, actual 12 min → 60% under → unapproved
      completedAt: addMinutes(daysAgo(2, 10), 12),
      hoursApprovedAt: null,
    },
    [{ userId: EMPLOYEE_ID, role: "primary" }],
  );

  // ─── OVERDUE (past, still SCHEDULED, unclaimed) ───────────────────────────
  await occ({ jobId: harringtonLakeMow.id, kind: "SINGLE_ADDRESS", startAt: daysAgo(1, 13), endAt: addMinutes(daysAgo(1, 13), 35), status: "SCHEDULED", workflow: "STANDARD", jobTags: '["MOW"]', price: 65.0, estimatedMinutes: 35 });
  await occ({ jobId: martinezBiweekly.id, kind: "SINGLE_ADDRESS", startAt: daysAgo(1, 9), endAt: addMinutes(daysAgo(1, 9), 40), status: "SCHEDULED", workflow: "STANDARD", jobTags: '["MOW","TRIM","EDGE","BLOW"]', price: 55.0, estimatedMinutes: 40 });
  await occ({ jobId: willowbrookWeekly.id, kind: "ENTIRE_SITE", startAt: daysAgo(2, 7), endAt: addMinutes(daysAgo(2, 7), 120), status: "SCHEDULED", workflow: "STANDARD", jobTags: '["MOW","TRIM","BLOW"]', price: 250.0, estimatedMinutes: 120 });
  await occ({ jobId: obrienMow.id, kind: "SINGLE_ADDRESS", startAt: daysAgo(1, 8), endAt: addMinutes(daysAgo(1, 8), 35), status: "SCHEDULED", workflow: "STANDARD", jobTags: '["MOW"]', price: 60.0, estimatedMinutes: 35 });
  await occ({ jobId: sunriseWeekly.id, kind: "ENTIRE_SITE", startAt: daysAgo(2, 7), endAt: addMinutes(daysAgo(2, 7), 180), status: "SCHEDULED", workflow: "STANDARD", jobTags: '["MOW","TRIM","EDGE","BLOW"]', price: 350.0, estimatedMinutes: 180 });
  await occ({ jobId: riverBendWeekly.id, kind: "ENTIRE_SITE", startAt: daysAgo(1, 6), endAt: addMinutes(daysAgo(1, 6), 150), status: "SCHEDULED", workflow: "STANDARD", jobTags: '["MOW","TRIM","BLOW"]', price: 400.0, estimatedMinutes: 150 });
  await occ({ jobId: patelMow.id, kind: "SINGLE_ADDRESS", startAt: daysAgo(3, 15), endAt: addMinutes(daysAgo(3, 15), 25), status: "SCHEDULED", workflow: "STANDARD", jobTags: '["MOW"]', price: 45.0, estimatedMinutes: 25 });
  await occ({ jobId: churchWeekly.id, kind: "ENTIRE_SITE", startAt: daysAgo(1, 14), endAt: addMinutes(daysAgo(1, 14), 90), status: "SCHEDULED", workflow: "STANDARD", jobTags: '["MOW","TRIM","BLOW"]', price: 200.0, estimatedMinutes: 90 });
  // Overdue assigned but not completed
  await occ(
    { jobId: thompsonMow.id, kind: "SINGLE_ADDRESS", startAt: daysAgo(1, 9), endAt: addMinutes(daysAgo(1, 9), 60), status: "SCHEDULED", workflow: "STANDARD", jobTags: '["MOW","TRIM","EDGE","BLOW"]', price: 125.0, estimatedMinutes: 60 },
    [{ userId: CONTRACTOR_ID, role: "primary" }],
  );
  // Overdue — started but never completed (IN_PROGRESS)
  await occ(
    { jobId: obrienMow.id, kind: "SINGLE_ADDRESS", startAt: daysAgo(2, 8), endAt: addMinutes(daysAgo(2, 8), 35), status: "IN_PROGRESS", workflow: "STANDARD", jobTags: '["MOW"]', price: 60.0, estimatedMinutes: 35, startedAt: daysAgo(2, 8) },
    [{ userId: EMPLOYEE_ID, role: "primary" }],
  );
  // Overdue — completed but payment not accepted (PENDING_PAYMENT)
  await occ(
    { jobId: willowbrookPoolMow.id, kind: "SINGLE_ADDRESS", startAt: daysAgo(3, 8), endAt: addMinutes(daysAgo(3, 8), 30), status: "PENDING_PAYMENT", workflow: "STANDARD", jobTags: '["MOW","TRIM","BLOW"]', price: 75.0, estimatedMinutes: 30, startedAt: daysAgo(3, 8), completedAt: addMinutes(daysAgo(3, 8), 28) },
    [{ userId: ADMIN_WORKER_ID, role: "primary" }],
  );
  // Overdue — assigned to trainee, still scheduled
  await occ(
    { jobId: patelMow.id, kind: "SINGLE_ADDRESS", startAt: daysAgo(2, 15), endAt: addMinutes(daysAgo(2, 15), 25), status: "SCHEDULED", workflow: "STANDARD", jobTags: '["MOW"]', price: 45.0, estimatedMinutes: 25 },
    [{ userId: EMPLOYEE_ID, role: "primary" }, { userId: TRAINEE_ID, role: "helper" }],
  );

  // ─── TODAY / TOMORROW ─────────────────────────────────────────────────────
  // Assigned today
  const todayHarrington = await occ(
    { jobId: harringtonMow.id, kind: "SINGLE_ADDRESS", startAt: daysFromNow(0, 8), endAt: addMinutes(daysFromNow(0, 8), 45), status: "SCHEDULED", workflow: "STANDARD", jobTags: '["MOW","TRIM","BLOW"]', price: 85.0, estimatedMinutes: 45, isClientConfirmed: true },
    [{ userId: ADMIN_WORKER_ID, role: "primary" }, { userId: EMPLOYEE_ID, role: "helper" }],
  );
  const todayWillowbrook = await occ(
    { jobId: willowbrookWeekly.id, kind: "ENTIRE_SITE", startAt: daysFromNow(0, 7), endAt: addMinutes(daysFromNow(0, 7), 120), status: "SCHEDULED", workflow: "STANDARD", jobTags: '["MOW","TRIM","BLOW"]', price: 250.0, estimatedMinutes: 120, pinnedNote: "Cut shorter — board meeting tomorrow" },
    [{ userId: ADMIN_WORKER_ID, role: "primary" }],
  );
  await occ(
    { jobId: patelMow.id, kind: "SINGLE_ADDRESS", startAt: daysFromNow(0, 15), endAt: addMinutes(daysFromNow(0, 15), 25), status: "SCHEDULED", workflow: "STANDARD", jobTags: '["MOW"]', price: 45.0, estimatedMinutes: 25 },
    [{ userId: EMPLOYEE_ID, role: "primary" }, { userId: TRAINEE_ID, role: "helper" }],
  );
  const todayRiverBend = await occ(
    { jobId: riverBendWeekly.id, kind: "ENTIRE_SITE", startAt: daysFromNow(0, 6), endAt: addMinutes(daysFromNow(0, 6), 150), status: "SCHEDULED", workflow: "STANDARD", jobTags: '["MOW","TRIM","BLOW"]', price: 400.0, estimatedMinutes: 150, isClientConfirmed: true, pinnedNote: "Bag clippings — client event this weekend", pinnedNoteRepeats: false },
    [{ userId: ADMIN_WORKER_ID, role: "primary" }, { userId: CONTRACTOR_ID, role: "helper" }],
  );
  // In progress today (must be confirmed to have been started)
  await occ(
    { jobId: obrienMow.id, kind: "SINGLE_ADDRESS", startAt: daysFromNow(0, 8), endAt: addMinutes(daysFromNow(0, 8), 35), status: "IN_PROGRESS", workflow: "STANDARD", jobTags: '["MOW"]', price: 60.0, estimatedMinutes: 35, startedAt: daysFromNow(0, 8), isClientConfirmed: true },
    [{ userId: EMPLOYEE_ID, role: "primary" }],
  );

  // Unclaimed today
  await occ({ jobId: martinezBiweekly.id, kind: "SINGLE_ADDRESS", startAt: daysFromNow(0, 9), endAt: addMinutes(daysFromNow(0, 9), 40), status: "SCHEDULED", workflow: "STANDARD", jobTags: '["MOW","TRIM","EDGE","BLOW"]', price: 55.0, estimatedMinutes: 40 });
  await occ({ jobId: churchWeekly.id, kind: "ENTIRE_SITE", startAt: daysFromNow(0, 14), endAt: addMinutes(daysFromNow(0, 14), 90), status: "SCHEDULED", workflow: "STANDARD", jobTags: '["MOW","TRIM","BLOW"]', price: 200.0, estimatedMinutes: 90 });

  // Assigned tomorrow
  const tomorrowChenLeaf = await occ(
    { jobId: chenLeafCleanup.id, kind: "SINGLE_ADDRESS", startAt: daysFromNow(1, 9), endAt: addMinutes(daysFromNow(1, 9), 90), status: "SCHEDULED", workflow: "ONE_OFF", jobTags: '["LEAF_CLEANUP"]', price: 120.0, estimatedMinutes: 90, isOneOff: true },
    [{ userId: EMPLOYEE_ID, role: "primary" }, { userId: TRAINEE_ID, role: "helper" }],
  );
  await occ(
    { jobId: thompsonMow.id, kind: "SINGLE_ADDRESS", startAt: daysFromNow(1, 9), endAt: addMinutes(daysFromNow(1, 9), 60), status: "SCHEDULED", workflow: "STANDARD", jobTags: '["MOW","TRIM","EDGE","BLOW"]', price: 125.0, estimatedMinutes: 60 },
    [{ userId: CONTRACTOR_ID, role: "primary" }, { userId: TRAINEE_ID, role: "helper" }],
  );

  // Admin-assigned tomorrow (diverse: confirmed, unconfirmed, estimate, event)
  await occ(
    { jobId: harringtonMow.id, kind: "SINGLE_ADDRESS", startAt: daysFromNow(1, 8), endAt: addMinutes(daysFromNow(1, 8), 45), status: "SCHEDULED", workflow: "STANDARD", jobTags: '["MOW","TRIM","BLOW"]', price: 85.0, estimatedMinutes: 45, isClientConfirmed: true },
    [{ userId: ADMIN_WORKER_ID, role: "primary" }, { userId: EMPLOYEE_ID, role: "helper" }],
  );
  await occ(
    { jobId: willowbrookWeekly.id, kind: "ENTIRE_SITE", startAt: daysFromNow(1, 10), endAt: addMinutes(daysFromNow(1, 10), 120), status: "SCHEDULED", workflow: "STANDARD", jobTags: '["MOW","TRIM","EDGE","BLOW"]', price: 250.0, estimatedMinutes: 120 },
    [{ userId: ADMIN_WORKER_ID, role: "primary" }, { userId: CONTRACTOR_ID, role: "helper" }],
  );
  await occ(
    { jobId: obrienMow.id, kind: "SINGLE_ADDRESS", startAt: daysFromNow(1, 14), endAt: addMinutes(daysFromNow(1, 14), 30), status: "SCHEDULED", workflow: "STANDARD", jobTags: '["MOW"]', price: 60.0, estimatedMinutes: 30 },
    [{ userId: ADMIN_WORKER_ID, role: "primary" }],
  );
  await occ(
    { jobId: chenTreeEstimate.id, kind: "SINGLE_ADDRESS", startAt: daysFromNow(1, 11), endAt: addMinutes(daysFromNow(1, 11), 60), status: "SCHEDULED", workflow: "ESTIMATE", price: null, estimatedMinutes: 60, isEstimate: true },
    [{ userId: ADMIN_WORKER_ID, role: "primary" }],
  );

  // Unclaimed tomorrow
  await occ({ jobId: harringtonLakeMow.id, kind: "SINGLE_ADDRESS", startAt: daysFromNow(1, 13), endAt: addMinutes(daysFromNow(1, 13), 35), status: "SCHEDULED", workflow: "STANDARD", jobTags: '["MOW"]', price: 65.0, estimatedMinutes: 35 });
  // Big tomorrow job pre-attached to Alpha Crew — admin assignment path.
  // Materializes the full Alpha roster as assignees so the UI shows the
  // Group chip + collapsed assignee list immediately. Group claimer (ADMIN)
  // can then start/complete; non-claimer members can also start/pause/complete.
  const sunriseTomorrowOcc = await occ({ jobId: sunriseWeekly.id, kind: "ENTIRE_SITE", startAt: daysFromNow(1, 7), endAt: addMinutes(daysFromNow(1, 7), 180), status: "SCHEDULED", workflow: "STANDARD", jobTags: '["MOW","TRIM","EDGE","BLOW"]', price: 350.0, estimatedMinutes: 180 });
  await prisma.jobOccurrence.update({
    where: { id: sunriseTomorrowOcc.id },
    data: { assignedGroupId: alphaCrew.id },
  });
  await prisma.jobOccurrenceAssignee.createMany({
    data: [
      // Claimer of the group: self-assigned (assignedById === userId).
      { occurrenceId: sunriseTomorrowOcc.id, userId: ADMIN_WORKER_ID, assignedById: ADMIN_WORKER_ID },
      // Workers + observer: assigned-by the group claimer.
      { occurrenceId: sunriseTomorrowOcc.id, userId: EMPLOYEE_ID, assignedById: ADMIN_WORKER_ID },
      { occurrenceId: sunriseTomorrowOcc.id, userId: CONTRACTOR_ID, assignedById: ADMIN_WORKER_ID },
      { occurrenceId: sunriseTomorrowOcc.id, userId: TRAINEE_ID, role: "observer", assignedById: ADMIN_WORKER_ID },
    ],
  });
  await occ({ jobId: kimMow.id, kind: "SINGLE_ADDRESS", startAt: daysFromNow(1, 10), endAt: addMinutes(daysFromNow(1, 10), 30), status: "SCHEDULED", workflow: "STANDARD", jobTags: '["MOW"]', price: 50.0, estimatedMinutes: 30 });

  // ─── UPCOMING (2-7 days) ──────────────────────────────────────────────────
  // Assigned
  await occ(
    { jobId: harringtonMow.id, kind: "SINGLE_ADDRESS", startAt: daysFromNow(7, 8), endAt: addMinutes(daysFromNow(7, 8), 45), status: "SCHEDULED", workflow: "STANDARD", jobTags: '["MOW","TRIM","BLOW"]', price: 85.0, estimatedMinutes: 45 },
    [{ userId: ADMIN_WORKER_ID, role: "primary" }],
  );
  await occ(
    { jobId: harringtonLakeMow.id, kind: "SINGLE_ADDRESS", startAt: daysFromNow(7, 13), endAt: addMinutes(daysFromNow(7, 13), 35), status: "SCHEDULED", workflow: "STANDARD", jobTags: '["MOW"]', price: 65.0, estimatedMinutes: 35 },
    [{ userId: CONTRACTOR_ID, role: "primary" }],
  );
  await occ(
    { jobId: obrienMow.id, kind: "SINGLE_ADDRESS", startAt: daysFromNow(3, 8), endAt: addMinutes(daysFromNow(3, 8), 35), status: "SCHEDULED", workflow: "STANDARD", jobTags: '["MOW"]', price: 60.0, estimatedMinutes: 35 },
    [{ userId: EMPLOYEE_ID, role: "primary" }],
  );
  await occ(
    { jobId: riverBendWeekly.id, kind: "ENTIRE_SITE", startAt: daysFromNow(6, 6), endAt: addMinutes(daysFromNow(6, 6), 150), status: "SCHEDULED", workflow: "STANDARD", jobTags: '["MOW","TRIM","BLOW"]', price: 400.0, estimatedMinutes: 150 },
    [{ userId: ADMIN_WORKER_ID, role: "primary" }, { userId: CONTRACTOR_ID, role: "helper" }],
  );

  // Unclaimed upcoming
  await occ({ jobId: willowbrookWeekly.id, kind: "ENTIRE_SITE", startAt: daysFromNow(5, 7), endAt: addMinutes(daysFromNow(5, 7), 120), status: "SCHEDULED", workflow: "STANDARD", jobTags: '["MOW","TRIM","BLOW"]', price: 250.0, estimatedMinutes: 120 });
  await occ({ jobId: sunriseWeekly.id, kind: "ENTIRE_SITE", startAt: daysFromNow(5, 7), endAt: addMinutes(daysFromNow(5, 7), 180), status: "SCHEDULED", workflow: "STANDARD", jobTags: '["MOW","TRIM","EDGE","BLOW"]', price: 350.0, estimatedMinutes: 180 });
  await occ({ jobId: patelMow.id, kind: "SINGLE_ADDRESS", startAt: daysFromNow(4, 15), endAt: addMinutes(daysFromNow(4, 15), 25), status: "SCHEDULED", workflow: "STANDARD", jobTags: '["MOW"]', price: 45.0, estimatedMinutes: 25 });
  await occ({ jobId: churchWeekly.id, kind: "ENTIRE_SITE", startAt: daysFromNow(6, 14), endAt: addMinutes(daysFromNow(6, 14), 90), status: "SCHEDULED", workflow: "STANDARD", jobTags: '["MOW","TRIM","BLOW"]', price: 200.0, estimatedMinutes: 90 });

  // Tentative upcoming
  await occ(
    { jobId: martinezBiweekly.id, kind: "SINGLE_ADDRESS", startAt: daysFromNow(6, 9), endAt: addMinutes(daysFromNow(6, 9), 40), status: "SCHEDULED", workflow: "STANDARD", jobTags: '["MOW","TRIM","EDGE","BLOW"]', price: 55.0, estimatedMinutes: 40, isTentative: true },
    [{ userId: EMPLOYEE_ID, role: "primary" }],
  );
  await occ(
    { jobId: thompsonGuestMow.id, kind: "SINGLE_ADDRESS", startAt: daysFromNow(3, 14), endAt: addMinutes(daysFromNow(3, 14), 30), status: "SCHEDULED", workflow: "STANDARD", jobTags: '["MOW"]', price: 55.0, estimatedMinutes: 30, isTentative: true },
    [{ userId: CONTRACTOR_ID, role: "primary" }],
  );

  // ─── FURTHER OUT (8-14 days) ──────────────────────────────────────────────
  await occ(
    { jobId: harringtonMow.id, kind: "SINGLE_ADDRESS", startAt: daysFromNow(14, 8), endAt: addMinutes(daysFromNow(14, 8), 45), status: "SCHEDULED", workflow: "STANDARD", jobTags: '["MOW","TRIM","BLOW"]', price: 85.0, estimatedMinutes: 45 },
    [{ userId: ADMIN_WORKER_ID, role: "primary" }, { userId: EMPLOYEE_ID, role: "helper" }],
  );
  await occ({ jobId: willowbrookPoolMow.id, kind: "SINGLE_ADDRESS", startAt: daysFromNow(10, 8), endAt: addMinutes(daysFromNow(10, 8), 30), status: "SCHEDULED", workflow: "STANDARD", jobTags: '["MOW","TRIM","BLOW"]', price: 75.0, estimatedMinutes: 30 });
  await occ({ jobId: willowbrookWeekly.id, kind: "ENTIRE_SITE", startAt: daysFromNow(12, 7), endAt: addMinutes(daysFromNow(12, 7), 120), status: "SCHEDULED", workflow: "STANDARD", jobTags: '["MOW","TRIM","BLOW"]', price: 250.0, estimatedMinutes: 120, isTentative: true, isAdminOnly: true });

  // ─── CANCELED ─────────────────────────────────────────────────────────────
  await occ({ jobId: harringtonMow.id, kind: "SINGLE_ADDRESS", startAt: daysAgo(28, 8), endAt: addMinutes(daysAgo(28, 8), 45), status: "CANCELED", workflow: "STANDARD", jobTags: '["MOW","TRIM","BLOW"]', price: 85.0, estimatedMinutes: 45 });
  await occ({ jobId: willowbrookWeekly.id, kind: "ENTIRE_SITE", startAt: daysAgo(21, 7), endAt: addMinutes(daysAgo(21, 7), 120), status: "CANCELED", workflow: "STANDARD", jobTags: '["MOW","TRIM","BLOW"]', price: 250.0, estimatedMinutes: 120 });
  await occ({ jobId: thompsonMow.id, kind: "SINGLE_ADDRESS", startAt: daysAgo(21, 9), endAt: addMinutes(daysAgo(21, 9), 60), status: "CANCELED", workflow: "STANDARD", jobTags: '["MOW","TRIM","EDGE","BLOW"]', price: 125.0, estimatedMinutes: 60 });

  // ─── ESTIMATES ────────────────────────────────────────────────────────────
  const estChenTree = await occ({ jobId: chenTreeEstimate.id, kind: "SINGLE_ADDRESS", startAt: daysFromNow(3, 10), endAt: addMinutes(daysFromNow(3, 10), 60), status: "PROPOSAL_SUBMITTED", workflow: "ESTIMATE", jobTags: '["TREE_TRIM"]', isEstimate: true, isAdminOnly: true, proposalAmount: 450, proposalNotes: "3 large live oaks in the backyard need trimming. Two are approximately 30ft tall with branches overhanging the fence line into the neighbor's yard. The third is smaller (~20ft) but has significant dead wood that should be removed. Estimate includes all debris removal and hauling. We would need the chipper for this job. Recommend scheduling on a weekday when the neighbor is home so we can coordinate fence-line access. Lisa mentioned she also wants us to look at the crepe myrtle out front but that can be a separate estimate." });
  const estChurchWash = await occ({ jobId: churchPressureWash.id, kind: "ENTIRE_SITE", startAt: daysFromNow(8, 10), endAt: addMinutes(daysFromNow(8, 10), 120), status: "PROPOSAL_SUBMITTED", workflow: "ESTIMATE", jobTags: '["PLANT"]', isEstimate: true, isAdminOnly: true, proposalAmount: 800, proposalNotes: "Full walkway and parking lot pressure wash covering approximately 5000 sqft of concrete. The main walkway from the parking lot to the front entrance has significant algae buildup on the north-facing side. Parking lot has oil stains in several spots that will need degreaser pre-treatment. We should avoid Sunday entirely and Saturday afternoon due to services. Pastor David said Tuesday or Wednesday would be ideal. Will need to bring the 3100 PSI unit and at least 200ft of hose to reach the far end of the lot. Estimate includes surface cleaner attachment rental." });

  // ─── ONE-OFF (aeration) ───────────────────────────────────────────────────
  await occ(
    { jobId: patelAeration.id, kind: "SINGLE_ADDRESS", startAt: daysFromNow(5, 10), endAt: addMinutes(daysFromNow(5, 10), 60), status: "SCHEDULED", workflow: "ONE_OFF", jobTags: '["AERATION"]', price: 150.0, estimatedMinutes: 60, isOneOff: true },
    [{ userId: EMPLOYEE_ID, role: "primary" }],
  );

  // ── Payments (for completed occurrences) ──────────────────────────────────
  console.log("  Creating payments...");

  // Worker type lookup for fee calculation
  const contractorIds = new Set([CONTRACTOR_ID]);
  const employeeIds = new Set([ADMIN_WORKER_ID, EMPLOYEE_ID, TRAINEE_ID]);
  const PLATFORM_FEE_PCT = 20;
  const BUSINESS_MARGIN_PCT = 30;

  // Processor-fee config per method — mirrors the seeded PAYMENT_METHODS
  // taxonomy defaults (§5/§6 of docs/FINANCIAL_SYSTEM.md). Only Venmo charges
  // a fee; Cash/Check/Zelle are zero-fee. Kept in sync manually here so the
  // seed produces realistic processor-fee data for tax-export testing.
  const METHOD_FEES: Record<string, { feePercent: number; feeFixed: number }> = {
    CASH: { feePercent: 0, feeFixed: 0 },
    CHECK: { feePercent: 0, feeFixed: 0 },
    ZELLE: { feePercent: 0, feeFixed: 0 },
    VENMO: { feePercent: 1.9, feeFixed: 0.10 },
  };

  // Random-hours date helper for payment.createdAt only — gives payments realistic
  // collection times scattered through the day. Renamed to avoid shadowing the
  // module-level `daysAgo()` (which would silently break all the occurrence creations
  // above that pass an explicit hour argument).
  function daysAgoRandom(n: number): Date {
    const d = new Date();
    d.setDate(d.getDate() - n);
    d.setHours(10 + Math.floor(Math.random() * 8), Math.floor(Math.random() * 60), 0, 0);
    return d;
  }

  // Only the four methods the business actually accepts (Cash, Check, Venmo,
  // Zelle) — the PAYMENT_METHODS taxonomy. Venmo entries carry a processor
  // fee; the loop below computes and stores it so tax-export testing has
  // realistic fee data. Mix: 4 Cash, 5 Check, 4 Venmo, 3 Zelle.
  const paymentData: { occId: string; amount: number; method: "CASH" | "CHECK" | "VENMO" | "ZELLE"; collector: string; splits: { userId: string; amount: number }[]; createdAt: Date }[] = [
    { occId: cHarrington21.id, amount: 85, method: "CASH", collector: ADMIN_WORKER_ID, splits: [{ userId: ADMIN_WORKER_ID, amount: 50 }, { userId: EMPLOYEE_ID, amount: 35 }], createdAt: daysAgoRandom(20) },
    { occId: cHarrington14.id, amount: 85, method: "CHECK", collector: ADMIN_WORKER_ID, splits: [{ userId: ADMIN_WORKER_ID, amount: 50 }, { userId: EMPLOYEE_ID, amount: 35 }], createdAt: daysAgoRandom(13) },
    { occId: cHarrington7.id, amount: 85, method: "VENMO", collector: ADMIN_WORKER_ID, splits: [{ userId: ADMIN_WORKER_ID, amount: 50 }, { userId: EMPLOYEE_ID, amount: 35 }], createdAt: daysAgoRandom(6) },
    { occId: cLake14.id, amount: 65, method: "CASH", collector: CONTRACTOR_ID, splits: [{ userId: CONTRACTOR_ID, amount: 65 }], createdAt: daysAgoRandom(13) },
    { occId: cLake7.id, amount: 65, method: "VENMO", collector: CONTRACTOR_ID, splits: [{ userId: CONTRACTOR_ID, amount: 65 }], createdAt: daysAgoRandom(6) },
    { occId: cMartinez14.id, amount: 55, method: "ZELLE", collector: EMPLOYEE_ID, splits: [{ userId: EMPLOYEE_ID, amount: 55 }], createdAt: daysAgoRandom(12) },
    { occId: cWillowbrook14.id, amount: 250, method: "CHECK", collector: ADMIN_WORKER_ID, splits: [{ userId: ADMIN_WORKER_ID, amount: 150 }, { userId: CONTRACTOR_ID, amount: 100 }], createdAt: daysAgoRandom(13) },
    { occId: cWillowbrook7.id, amount: 250, method: "ZELLE", collector: ADMIN_WORKER_ID, splits: [{ userId: ADMIN_WORKER_ID, amount: 150 }, { userId: CONTRACTOR_ID, amount: 100 }], createdAt: daysAgoRandom(5) },
    { occId: cThompson14.id, amount: 125, method: "VENMO", collector: CONTRACTOR_ID, splits: [{ userId: CONTRACTOR_ID, amount: 85 }, { userId: TRAINEE_ID, amount: 40 }], createdAt: daysAgoRandom(11) },
    { occId: cThompson7.id, amount: 125, method: "VENMO", collector: CONTRACTOR_ID, splits: [{ userId: CONTRACTOR_ID, amount: 85 }, { userId: TRAINEE_ID, amount: 40 }], createdAt: daysAgoRandom(5) },
    { occId: cObrien7.id, amount: 60, method: "CASH", collector: EMPLOYEE_ID, splits: [{ userId: EMPLOYEE_ID, amount: 60 }], createdAt: daysAgoRandom(4) },
    { occId: cSunrise7.id, amount: 350, method: "CHECK", collector: ADMIN_WORKER_ID, splits: [{ userId: ADMIN_WORKER_ID, amount: 150 }, { userId: EMPLOYEE_ID, amount: 100 }, { userId: CONTRACTOR_ID, amount: 100 }], createdAt: daysAgoRandom(6) },
    { occId: cPatel7.id, amount: 45, method: "CASH", collector: TRAINEE_ID, splits: [{ userId: TRAINEE_ID, amount: 45 }], createdAt: daysAgoRandom(3) },
    { occId: cRiverBend7.id, amount: 400, method: "CHECK", collector: ADMIN_WORKER_ID, splits: [{ userId: ADMIN_WORKER_ID, amount: 250 }, { userId: CONTRACTOR_ID, amount: 150 }], createdAt: daysAgoRandom(6) },
    { occId: cChurch7.id, amount: 200, method: "CHECK", collector: EMPLOYEE_ID, splits: [{ userId: EMPLOYEE_ID, amount: 200 }], createdAt: daysAgoRandom(5) },
    { occId: cKim14.id, amount: 50, method: "ZELLE", collector: EMPLOYEE_ID, splits: [{ userId: EMPLOYEE_ID, amount: 50 }], createdAt: daysAgoRandom(10) },
  ];

  for (const p of paymentData) {
    // Calculate platform fee (contractor splits) and business margin (employee/trainee splits)
    const contractorSplitTotal = p.splits.filter((s) => contractorIds.has(s.userId)).reduce((sum, s) => sum + s.amount, 0);
    const employeeSplitTotal = p.splits.filter((s) => employeeIds.has(s.userId)).reduce((sum, s) => sum + s.amount, 0);
    const platformFeeAmount = contractorSplitTotal > 0 ? Math.round(contractorSplitTotal * PLATFORM_FEE_PCT) / 100 : null;
    const businessMarginAmount = employeeSplitTotal > 0 ? Math.round(employeeSplitTotal * BUSINESS_MARGIN_PCT) / 100 : null;

    // Processor fee: snapshot from METHOD_FEES (mirrors the taxonomy). Stored
    // on every payment — zero for Cash/Check/Zelle, ~1.9%+$0.10 for Venmo.
    const feeCfg = METHOD_FEES[p.method] ?? { feePercent: 0, feeFixed: 0 };
    const processorFeeAmount = Math.round((p.amount * feeCfg.feePercent / 100 + feeCfg.feeFixed) * 100) / 100;
    const netReceived = Math.round((p.amount - processorFeeAmount) * 100) / 100;

    await prisma.payment.create({
      data: {
        occurrenceId: p.occId,
        amountPaid: p.amount,
        method: p.method,
        collectedById: p.collector,
        createdAt: p.createdAt,
        platformFeePercent: platformFeeAmount != null ? PLATFORM_FEE_PCT : null,
        platformFeeAmount,
        businessMarginPercent: businessMarginAmount != null ? BUSINESS_MARGIN_PCT : null,
        businessMarginAmount,
        // Processor-fee fields — what tax exports read for the "Payment
        // Processing Fees" line and the netReceived column.
        processorFeePercent: feeCfg.feePercent,
        processorFeeFixed: feeCfg.feeFixed,
        processorFeeAmount,
        grossCharged: p.amount,
        netReceived,
        // These are CLOSED occurrences — historical, fully-settled payments.
        // Confirmed so they appear in the cash-basis tax exports (which
        // filter on confirmed=true + confirmedAt).
        confirmed: true,
        confirmedAt: p.createdAt,
        confirmedById: MICHAEL_ID,
        splits: { create: p.splits },
      },
    });
  }

  // ── Expenses ──────────────────────────────────────────────────────────────
  console.log("  Creating expenses...");

  // Each per-job expense also writes a paired BusinessExpense so the
  // tax ledger reflects everything the company spent (matching MVP-2 model).
  const expenseData: { occId: string; userId: string; cost: number; desc: string; category: string; vendor?: string }[] = [
    { occId: cWillowbrook7.id, userId: ADMIN_WORKER_ID, cost: 25.0, desc: "Fuel for mowers", category: "Fuel", vendor: "Shell" },
    { occId: cWillowbrook14.id, userId: ADMIN_WORKER_ID, cost: 28.0, desc: "Fuel for mowers", category: "Fuel", vendor: "Shell" },
    { occId: cMartinez14.id, userId: EMPLOYEE_ID, cost: 12.5, desc: "Trimmer line replacement", category: "Supplies", vendor: "Stihl Pro Dealer" },
    { occId: cHarrington7.id, userId: EMPLOYEE_ID, cost: 8.0, desc: "Edger blade", category: "Supplies", vendor: "Pro Lawn Supply" },
    { occId: cSunrise7.id, userId: ADMIN_WORKER_ID, cost: 35.0, desc: "Fuel and 2-cycle oil", category: "Fuel", vendor: "Shell" },
    { occId: cRiverBend7.id, userId: CONTRACTOR_ID, cost: 18.0, desc: "Mulch bags (2)", category: "Supplies", vendor: "Lowes" },
    { occId: cThompson7.id, userId: CONTRACTOR_ID, cost: 15.0, desc: "Hedge trimmer fuel mix", category: "Supplies", vendor: "Pro Lawn Supply" },
    { occId: cObrien7.id, userId: EMPLOYEE_ID, cost: 6.0, desc: "Trash bags for debris", category: "Supplies", vendor: "Home Depot" },
  ];

  for (const e of expenseData) {
    const be = await prisma.businessExpense.create({
      data: {
        createdById: e.userId,
        date: new Date(),
        cost: e.cost,
        description: e.desc,
        category: e.category,
        vendor: e.vendor ?? null,
        occurrenceId: e.occId,
      },
    });
    await prisma.expense.create({
      data: {
        occurrenceId: e.occId,
        createdById: e.userId,
        cost: e.cost,
        description: e.desc,
        businessExpenseId: be.id,
      },
    });
  }

  // ── Business expenses (not tied to a specific job) ───────────────────────
  console.log("  Creating business expenses...");

  // Categories below match the Schedule C-aligned list enforced by the API.
  // recurrence flag drives the "Due to record" panel suggestions.
  type RecurrenceCadence = "WEEKLY" | "MONTHLY" | "QUARTERLY" | "ANNUALLY";
  // Recurrence dates are tuned so the "Due to record" panel demos visibly:
  //   QuickBooks (monthly) — last 35d ago → next ~5d overdue
  //   Facebook Ads (monthly) — last 33d ago → next ~3d overdue
  //   State Farm liability (quarterly) — last 95d ago → next ~5d overdue
  //   Annual business license — last ~358d ago → next due in ~7d
  const businessExpenseData: { ago: number; cost: number; desc: string; category: string; vendor?: string; notes?: string; recurrence?: RecurrenceCadence }[] = [
    // Capital purchases on/after 2026-05-28 → land in qb-fixed-assets.csv,
    // excluded from qb-expenses.csv. The negative `ago` values date these
    // a few days into the future relative to seed-time "today", so the
    // threshold (cost ≥ $500 AND date ≥ 2026-05-28) catches them.
    { ago: -2, cost: 4250.00, desc: "Commercial zero-turn mower (Ferris IS 3200Z 61\")", category: "Depreciation", vendor: "Ferris Dealer", notes: "5-yr useful life; place in service immediately." },
    { ago: -1, cost: 875.00, desc: "Trailer ramp gate replacement", category: "Repairs and maintenance", vendor: "Big Tex", notes: "Threshold capital purchase — depreciate." },
    // Today / this week
    { ago: 0, cost: 64.27, desc: "Diesel for trailer truck", category: "Fuel", vendor: "Shell" },
    { ago: 3, cost: 142.50, desc: "Trimmer line bulk pack", category: "Supplies", vendor: "Stihl Pro Dealer" },
    // This month, prior weeks
    { ago: 14, cost: 89.43, desc: "Truck oil change & inspection", category: "Vehicle Maintenance", vendor: "Jiffy Lube", notes: "Receipt in glovebox" },
    { ago: 18, cost: 47.21, desc: "Office supplies (paper, pens, toner)", category: "Office expense", vendor: "Staples" },
    { ago: 33, cost: 125.00, desc: "Facebook Ads — neighborhood targeting", category: "Advertising", vendor: "Meta", recurrence: "MONTHLY" },
    { ago: 35, cost: 18.99, desc: "QuickBooks Online — monthly", category: "Office expense", vendor: "Intuit", recurrence: "MONTHLY" },
    // Earlier this year
    { ago: 38, cost: 1250.00, desc: "New backpack blower (Echo PB-8010T)", category: "Supplies", vendor: "Pro Lawn Supply" },
    { ago: 65, cost: 18.99, desc: "QuickBooks Online — monthly", category: "Office expense", vendor: "Intuit", recurrence: "MONTHLY" },
    { ago: 72, cost: 215.85, desc: "Mower deck repair (welding + new blades)", category: "Repairs and maintenance", vendor: "Mike's Mower Shop" },
    { ago: 95, cost: 285.00, desc: "General liability insurance", category: "Insurance", vendor: "State Farm Commercial", recurrence: "QUARTERLY" },
    { ago: 124, cost: 75.00, desc: "Logo redesign (vector files)", category: "Advertising", vendor: "Fiverr designer" },
    // Last year (for "all time" totals)
    { ago: 188, cost: 285.00, desc: "General liability insurance", category: "Insurance", vendor: "State Farm Commercial", recurrence: "QUARTERLY" },
    { ago: 240, cost: 12.50, desc: "Bank wire fee", category: "Other", vendor: "Chase Business" },
    { ago: 320, cost: 595.00, desc: "Tax prep (small business return)", category: "Legal and professional services", vendor: "H&R Block" },
    { ago: 358, cost: 320.00, desc: "Annual business license renewal", category: "Taxes and licenses", vendor: "City of Springfield", recurrence: "ANNUALLY" },
  ];

  for (const e of businessExpenseData) {
    await prisma.businessExpense.create({
      data: {
        createdById: ADMIN_WORKER_ID,
        date: daysAgo(e.ago, 12),
        cost: e.cost,
        description: e.desc,
        category: e.category,
        vendor: e.vendor ?? null,
        notes: e.notes ?? null,
        recurrence: e.recurrence ?? null,
      },
    });
  }

  // Equity entries — capital contributions (owner → business) and owner
  // draws (business → owner). Same table as expenses, discriminated by
  // `type`. Used to exercise the Accounting Type filter, equity-only
  // badges, and the qb-equity.csv export. Category/equipmentId stay null
  // for these (they post to QB equity accounts, not Schedule C lines).
  // No vendor on equity entries — they're between the owner and the
  // business, there's no external party. Account-flow context (e.g.,
  // "from personal checking") goes in notes when relevant.
  const equityEntryData: {
    ago: number;
    cost: number;
    desc: string;
    type: "CAPITAL_CONTRIBUTION" | "OWNER_DRAW";
    notes?: string;
    recurrence?: RecurrenceCadence;
  }[] = [
    // Recent owner draws — recurring monthly so the "Due to record" panel
    // surfaces the next one.
    { ago: 2, cost: 2500.00, desc: "Monthly owner draw", type: "OWNER_DRAW", recurrence: "MONTHLY" },
    { ago: 32, cost: 2500.00, desc: "Monthly owner draw", type: "OWNER_DRAW", recurrence: "MONTHLY" },
    { ago: 62, cost: 2200.00, desc: "Monthly owner draw", type: "OWNER_DRAW", recurrence: "MONTHLY" },
    // Capital contributions — one-offs, typical startup pattern (initial
    // seed + a top-up to cover a big equipment purchase).
    { ago: 365, cost: 10000.00, desc: "Initial owner investment", type: "CAPITAL_CONTRIBUTION", notes: "Seed capital to start operations" },
    { ago: 95, cost: 3500.00, desc: "Cash injection for equipment purchase", type: "CAPITAL_CONTRIBUTION", notes: "Covered down payment on commercial mower" },
  ];

  for (const e of equityEntryData) {
    await prisma.businessExpense.create({
      data: {
        createdById: ADMIN_WORKER_ID,
        type: e.type,
        date: daysAgo(e.ago, 12),
        cost: e.cost,
        description: e.desc,
        notes: e.notes ?? null,
        recurrence: e.recurrence ?? null,
      },
    });
  }

  // ── Supplies (step-3) ────────────────────────────────────────────────────
  // Inventory-tracked consumables. Each purchase creates a paired
  // BusinessExpense (tax-ledger) entry. After purchases run, two of the
  // supplies have an ACTIVE hold against an upcoming occurrence to demo the
  // reservation flow.
  console.log("  Creating supplies + purchases + holds...");

  const supplyCatalog: {
    key: string;
    name: string;
    unit: string;
    upc?: string;
    category: string;
    businessCost: number;
    jobPayoutCost: number;
    description?: string;
    purchases: { ago: number; quantity: number; unitCost: number; vendor: string; invoiceNumber?: string }[];
  }[] = [
    {
      key: "MULCH",
      name: "Hardwood mulch",
      unit: "bag",
      upc: "012345678901",
      category: "Supplies",
      businessCost: 4.0,
      jobPayoutCost: 4.2,
      description: "2 cu. ft. bags. Markup of $0.20/bag covers fetch time.",
      purchases: [
        { ago: 2, quantity: 30, unitCost: 4.0, vendor: "Lowes", invoiceNumber: "L-44120" },
        { ago: 16, quantity: 24, unitCost: 3.85, vendor: "Home Depot", invoiceNumber: "HD-22988" },
      ],
    },
    {
      key: "TRIMMER_LINE",
      name: "Trimmer line 0.095",
      unit: "spool",
      upc: "022345678902",
      category: "Supplies",
      businessCost: 18.0,
      jobPayoutCost: 18.0,
      description: "Pro-grade square cross-section, 0.095\" gauge, 3 lb spool.",
      purchases: [
        { ago: 7, quantity: 8, unitCost: 18.0, vendor: "Stihl Pro Dealer" },
      ],
    },
    {
      key: "EDGER_BLADE",
      name: "Edger blade",
      unit: "blade",
      category: "Supplies",
      businessCost: 6.5,
      jobPayoutCost: 7.0,
      purchases: [
        { ago: 11, quantity: 12, unitCost: 6.5, vendor: "Pro Lawn Supply" },
      ],
    },
    {
      key: "FERTILIZER",
      name: "Granular fertilizer 24-4-8",
      unit: "bag",
      category: "Supplies",
      businessCost: 32.0,
      jobPayoutCost: 34.0,
      description: "50 lb bag covers ~12,500 sq ft.",
      purchases: [
        { ago: 30, quantity: 6, unitCost: 32.0, vendor: "Pro Lawn Supply", invoiceNumber: "PLS-1042" },
      ],
    },
    {
      key: "TRASH_BAGS",
      name: "Heavy-duty trash bags",
      unit: "bag",
      category: "Supplies",
      businessCost: 0.6,
      jobPayoutCost: 0.75,
      description: "55-gal contractor bags, 3 mil.",
      purchases: [
        { ago: 5, quantity: 50, unitCost: 0.6, vendor: "Costco" },
      ],
    },
    {
      key: "FUEL_2CYC",
      name: "Premixed 2-cycle fuel",
      unit: "can",
      category: "Fuel",
      businessCost: 24.0,
      jobPayoutCost: 24.0,
      description: "TruFuel 50:1 quart cans. Categorized as Fuel (not Supplies).",
      purchases: [
        { ago: 4, quantity: 12, unitCost: 24.0, vendor: "Pro Lawn Supply" },
      ],
    },
  ];

  const createdSupplies: Record<string, string> = {}; // key → supply id
  for (const s of supplyCatalog) {
    const created = await prisma.supply.create({
      data: {
        createdById: ADMIN_WORKER_ID,
        name: s.name,
        unit: s.unit,
        upc: s.upc ?? null,
        category: s.category,
        businessCost: s.businessCost,
        jobPayoutCost: s.jobPayoutCost,
        description: s.description ?? null,
        onHand: 0,
      },
    });
    createdSupplies[s.key] = created.id;

    for (const p of s.purchases) {
      const totalCost = Math.round(p.quantity * p.unitCost * 100) / 100;
      const be = await prisma.businessExpense.create({
        data: {
          createdById: ADMIN_WORKER_ID,
          date: daysAgo(p.ago, 10),
          cost: totalCost,
          description: `${s.name} × ${p.quantity} ${s.unit}`,
          category: s.category,
          vendor: p.vendor,
          invoiceNumber: p.invoiceNumber ?? null,
        },
      });
      await prisma.supplyPurchase.create({
        data: {
          supplyId: created.id,
          quantity: p.quantity,
          unitCost: p.unitCost,
          totalCost,
          date: daysAgo(p.ago, 10),
          vendor: p.vendor,
          invoiceNumber: p.invoiceNumber ?? null,
          businessExpenseId: be.id,
          createdById: ADMIN_WORKER_ID,
        },
      });
      await prisma.supply.update({
        where: { id: created.id },
        data: { onHand: { increment: p.quantity }, businessCost: p.unitCost },
      });
    }
  }

  // Two ACTIVE holds against future occurrences — demo the reservation flow.
  const holdSeeds: { supplyKey: string; occId: string; quantity: number }[] = [
    { supplyKey: "MULCH", occId: cWillowbrook14.id, quantity: 8 },
    { supplyKey: "TRIMMER_LINE", occId: cMartinez14.id, quantity: 1 },
  ];
  for (const h of holdSeeds) {
    const supplyId = createdSupplies[h.supplyKey];
    if (!supplyId) continue;
    const supply = await prisma.supply.findUniqueOrThrow({ where: { id: supplyId } });
    const totalCharge = Math.round(h.quantity * supply.jobPayoutCost * 100) / 100;
    const expense = await prisma.expense.create({
      data: {
        occurrenceId: h.occId,
        createdById: EMPLOYEE_ID,
        cost: totalCharge,
        description: `${supply.name} × ${h.quantity} ${supply.unit}`,
      },
    });
    await prisma.supplyHold.create({
      data: {
        supplyId,
        occurrenceId: h.occId,
        quantity: h.quantity,
        jobPayoutCost: supply.jobPayoutCost,
        status: "ACTIVE",
        expenseId: expense.id,
        createdById: EMPLOYEE_ID,
      },
    });
  }

  // ── Audit events ──────────────────────────────────────────────────────────
  console.log("  Creating audit events...");

  // Client creation
  const allClients = [
    { id: vipClient.id, name: "Harrington Estate", ago: 45 },
    { id: martinezFamily.id, name: "Martinez Family", ago: 42 },
    { id: willowbrookHoa.id, name: "Willowbrook HOA", ago: 40 },
    { id: chenResidence.id, name: "Chen Residence", ago: 35 },
    { id: vipThompson.id, name: "Thompson Manor", ago: 33 },
    { id: obrienFamily.id, name: "O'Brien Family", ago: 30 },
    { id: sunriseHoa.id, name: "Sunrise Meadows HOA", ago: 28 },
    { id: patelResidence.id, name: "Patel Residence", ago: 25 },
    { id: riverBend.id, name: "River Bend Office Park", ago: 22 },
    { id: kimResidence.id, name: "Kim Residence", ago: 20 },
    { id: garciaFamily.id, name: "Garcia Family", ago: 18 },
    { id: lakesideChurch.id, name: "Lakeside Community Church", ago: 15 },
  ];
  for (const c of allClients) {
    await prisma.auditEvent.create({
      data: { scope: "CLIENT", verb: "CREATED", actorUserId: MICHAEL_ID, metadata: { clientId: c.id, displayName: c.name }, createdAt: daysAgo(c.ago, 10) },
    });
  }

  // User approvals
  const approvals = [
    { userId: ADMIN_WORKER_ID, name: "Admin Worker", ago: 50 },
    { userId: CONTRACTOR_ID, name: "Contractor Worker", ago: 48 },
    { userId: EMPLOYEE_ID, name: "Employee Worker", ago: 48 },
    { userId: TRAINEE_ID, name: "Trainee Worker", ago: 45 },
    { userId: CLIENT_USER_ID, name: "Client User", ago: 42 },
  ];
  for (const a of approvals) {
    await prisma.auditEvent.create({
      data: { scope: "USER", verb: "APPROVED", actorUserId: MICHAEL_ID, metadata: { userId: a.userId, displayName: a.name }, createdAt: daysAgo(a.ago, 9) },
    });
  }

  // Worker type assignments
  const workerTypes = [
    { userId: ADMIN_WORKER_ID, type: "EMPLOYEE", ago: 50 },
    { userId: CONTRACTOR_ID, type: "CONTRACTOR", ago: 48 },
    { userId: EMPLOYEE_ID, type: "EMPLOYEE", ago: 48 },
    { userId: TRAINEE_ID, type: "TRAINEE", ago: 45 },
  ];
  for (const w of workerTypes) {
    await prisma.auditEvent.create({
      data: { scope: "USER", verb: "WORKER_TYPE_SET", actorUserId: MICHAEL_ID, metadata: { userId: w.userId, workerType: w.type }, createdAt: daysAgo(w.ago, 10) },
    });
  }

  // Role assignments
  await prisma.auditEvent.create({
    data: { scope: "USER", verb: "ROLE_ASSIGNED", actorUserId: MICHAEL_ID, metadata: { userId: ADMIN_WORKER_ID, role: "ADMIN" }, createdAt: daysAgo(50, 11) },
  });

  // Equipment events
  const equipEvents: { eqId: string; desc: string; userId: string; verb: "CHECKED_OUT" | "RELEASED" | "MAINTENANCE_START"; ago: number; meta?: Record<string, unknown> }[] = [
    { eqId: mower1.id, desc: "Commercial stand-on mower", userId: EMPLOYEE_ID, verb: "CHECKED_OUT", ago: 5 },
    { eqId: blower1.id, desc: "Backpack blower", userId: CONTRACTOR_ID, verb: "CHECKED_OUT", ago: 3 },
    { eqId: trimmer2.id, desc: "Lightweight string trimmer", userId: ADMIN_WORKER_ID, verb: "CHECKED_OUT", ago: 2 },
    { eqId: blower3.id, desc: "Backpack blower (mid-range)", userId: TRAINEE_ID, verb: "CHECKED_OUT", ago: 1 },
    { eqId: trailer.id, desc: "12ft utility trailer", userId: ADMIN_WORKER_ID, verb: "CHECKED_OUT", ago: 7 },
    { eqId: chainsawEquip.id, desc: "20\" chainsaw", userId: CONTRACTOR_ID, verb: "CHECKED_OUT", ago: 14 },
    { eqId: chainsawEquip.id, desc: "20\" chainsaw", userId: CONTRACTOR_ID, verb: "RELEASED", ago: 12 },
    { eqId: mower3.id, desc: "21\" push mower", userId: ADMIN_WORKER_ID, verb: "MAINTENANCE_START", ago: 2, meta: { reason: "Blade needs sharpening" } },
  ];
  for (const e of equipEvents) {
    await prisma.auditEvent.create({
      data: { scope: "EQUIPMENT", verb: e.verb, actorUserId: e.userId, metadata: { equipmentId: e.eqId, shortDesc: e.desc, ...e.meta }, createdAt: daysAgo(e.ago, 9) },
    });
  }

  // Job creation events
  const jobEvents = [
    { id: harringtonMow.id, note: "Harrington Main - weekly mow", ago: 30 },
    { id: harringtonLakeMow.id, note: "Harrington Lake - weekly mow", ago: 30 },
    { id: martinezBiweekly.id, note: "Martinez - biweekly full service", ago: 28 },
    { id: willowbrookWeekly.id, note: "Willowbrook HOA - weekly maintenance", ago: 25 },
    { id: willowbrookPoolMow.id, note: "Willowbrook Pool - biweekly trim", ago: 25 },
    { id: chenLeafCleanup.id, note: "Chen - leaf cleanup (one-off)", ago: 10 },
    { id: chenTreeEstimate.id, note: "Chen - tree trimming estimate", ago: 5 },
    { id: thompsonMow.id, note: "Thompson Main - weekly full service", ago: 22 },
    { id: thompsonGuestMow.id, note: "Thompson Guest - biweekly mow", ago: 22 },
    { id: obrienMow.id, note: "O'Brien - weekly mow", ago: 20 },
    { id: sunriseWeekly.id, note: "Sunrise HOA - weekly maintenance", ago: 18 },
    { id: patelMow.id, note: "Patel - weekly mow", ago: 15 },
    { id: patelAeration.id, note: "Patel - fall aeration (one-off)", ago: 8 },
    { id: riverBendWeekly.id, note: "River Bend - weekly campus maintenance", ago: 15 },
    { id: kimMow.id, note: "Kim - biweekly mow", ago: 12 },
    { id: churchWeekly.id, note: "Lakeside Church - weekly grounds", ago: 10 },
    { id: churchPressureWash.id, note: "Lakeside Church - pressure wash estimate", ago: 3 },
  ];
  for (const j of jobEvents) {
    await prisma.auditEvent.create({
      data: { scope: "JOB", verb: "CREATED", actorUserId: ADMIN_WORKER_ID, metadata: { jobId: j.id, note: j.note }, createdAt: daysAgo(j.ago, 11) },
    });
  }

  // Completed occurrence audit events
  const completedOccs = [
    { id: cHarrington21.id, actor: ADMIN_WORKER_ID, at: addMinutes(daysAgo(21, 8), 40) },
    { id: cHarrington14.id, actor: ADMIN_WORKER_ID, at: addMinutes(daysAgo(14, 8), 42) },
    { id: cHarrington7.id, actor: ADMIN_WORKER_ID, at: addMinutes(daysAgo(7, 8), 50) },
    { id: cLake14.id, actor: CONTRACTOR_ID, at: addMinutes(daysAgo(14, 13), 30) },
    { id: cLake7.id, actor: CONTRACTOR_ID, at: addMinutes(daysAgo(7, 13), 32) },
    { id: cMartinez14.id, actor: EMPLOYEE_ID, at: addMinutes(daysAgo(14, 9), 38) },
    { id: cWillowbrook14.id, actor: ADMIN_WORKER_ID, at: addMinutes(daysAgo(14, 7), 110) },
    { id: cWillowbrook7.id, actor: ADMIN_WORKER_ID, at: addMinutes(daysAgo(7, 7), 115) },
    { id: cThompson14.id, actor: CONTRACTOR_ID, at: addMinutes(daysAgo(14, 9), 55) },
    { id: cThompson7.id, actor: CONTRACTOR_ID, at: addMinutes(daysAgo(7, 9), 58) },
    { id: cObrien7.id, actor: EMPLOYEE_ID, at: addMinutes(daysAgo(7, 8), 33) },
    { id: cSunrise7.id, actor: ADMIN_WORKER_ID, at: addMinutes(daysAgo(7, 7), 170) },
    { id: cPatel7.id, actor: TRAINEE_ID, at: addMinutes(daysAgo(7, 15), 22) },
    { id: cRiverBend7.id, actor: ADMIN_WORKER_ID, at: addMinutes(daysAgo(7, 6), 145) },
    { id: cChurch7.id, actor: EMPLOYEE_ID, at: addMinutes(daysAgo(7, 14), 85) },
    { id: cKim14.id, actor: EMPLOYEE_ID, at: addMinutes(daysAgo(14, 10), 28) },
  ];
  for (const c of completedOccs) {
    await prisma.auditEvent.create({
      data: { scope: "JOB", verb: "UPDATED", action: "occurrence_completed", actorUserId: c.actor, metadata: { occurrenceId: c.id, status: "CLOSED" }, createdAt: c.at },
    });
  }

  // VIP designation events
  await prisma.auditEvent.create({
    data: { scope: "CLIENT", verb: "UPDATED", action: "vip_designated", actorUserId: MICHAEL_ID, metadata: { clientId: vipClient.id, displayName: "Harrington Estate", isVip: true }, createdAt: daysAgo(40, 14) },
  });
  await prisma.auditEvent.create({
    data: { scope: "CLIENT", verb: "UPDATED", action: "vip_designated", actorUserId: MICHAEL_ID, metadata: { clientId: vipThompson.id, displayName: "Thompson Manor", isVip: true }, createdAt: daysAgo(30, 14) },
  });

  // Garcia paused
  await prisma.auditEvent.create({
    data: { scope: "CLIENT", verb: "UPDATED", action: "status_changed", actorUserId: ADMIN_WORKER_ID, metadata: { clientId: garciaFamily.id, displayName: "Garcia Family", status: "PAUSED", reason: "Winter pause" }, createdAt: daysAgo(10, 11) },
  });

  // Kim paused
  await prisma.auditEvent.create({
    data: { scope: "CLIENT", verb: "UPDATED", action: "status_changed", actorUserId: ADMIN_WORKER_ID, metadata: { clientId: kimResidence.id, displayName: "Kim Residence", status: "PAUSED", reason: "Traveling abroad" }, createdAt: daysAgo(5, 11) },
  });

  // Dawson archived
  await prisma.auditEvent.create({
    data: { scope: "CLIENT", verb: "UPDATED", action: "status_changed", actorUserId: MICHAEL_ID, metadata: { clientId: oldClient.id, displayName: "Dawson Residence", status: "ARCHIVED", reason: "Moved out of area" }, createdAt: daysAgo(60, 11) },
  });

  // ── Fee/margin settings ────────────────────────────────────────────────────
  console.log("  Creating fee/margin settings...");

  const feeSettings = [
    { key: "CONTRACTOR_PLATFORM_FEE_PERCENT", value: "20", description: "Platform fee percentage charged on contractor (1099) payment splits" },
    { key: "EMPLOYEE_BUSINESS_MARGIN_PERCENT", value: "30", description: "Business margin percentage retained from employee (W-2) and trainee payment splits" },
    { key: "HIGH_VALUE_JOB_THRESHOLD", value: "200", description: "Jobs at or above this price require insurance for contractors to claim" },
    { key: "HOURS_APPROVAL_VARIANCE_THRESHOLD_PERCENT", value: "30", description: "Percent variance (over OR under the estimate) that auto-approves logged hours for payroll. Anything outside this window leaves hoursApprovedAt null and surfaces in the 'Hours awaiting review' alert until an admin reviews. Same threshold drives the visual '⚠ X% over estimate' warning on the JobsTab card." },
    { key: "MIN_WAGE_PER_HOUR", value: "7.25", description: "Minimum wage floor (USD/hour) used by the Operations → Worker Performance compliance check. Defaults to the federal FLSA minimum ($7.25) which is what applies in NC (no state-level higher floor). If you operate in a state with a higher minimum (e.g., NJ, NY, CA), bump this to match. Drives color coding on the per-worker $/hr column; contractors are shown for reclassification-risk monitoring (the floor is not a legal requirement for true 1099 workers)." },
    { key: "FIXED_ASSET_MIN_COST", value: "500", description: "Capitalization threshold (USD). BusinessExpense purchases at or above this cost, dated on/after the policy start date, are treated as Fixed Assets — excluded from qb-expenses.csv and emitted into qb-fixed-assets.csv instead. Policy start date is currently hardcoded in code; only the dollar threshold is editable here." },
    { key: "WORKDAY_APPROVAL_CUTOFF_HOUR_ET", value: "4", description: "Hour (0-23, ET) the next morning at which workday approval becomes available to admins/supers and the worker's edit window closes. Default 4 covers late-night work that wraps past midnight. Symmetric — worker can still edit until this hour the next day; admin can approve from this hour onward." },
    { key: "PAYROLL_PERIOD_CADENCE", value: "WEEKLY", description: "How often you run payroll. Sets the default date range on the Exports tab." },
    {
      key: "PAYMENT_METHODS",
      value: JSON.stringify([
        {
          key: "VENMO",
          label: "Venmo",
          feePercent: 1.9,
          feeFixed: 0.10,
          supportsClientRequest: true,
          supportsOnSite: true,
          deepLinkTemplate: "venmo://paycharge?txn=pay&recipients={VENMO_BUSINESS_HANDLE}&amount={{amount}}&note={{note}}",
          instructions: "Send {{amount}} to @{VENMO_BUSINESS_HANDLE} on Venmo",
          active: true,
        },
        {
          key: "ZELLE",
          label: "Zelle",
          feePercent: 0,
          feeFixed: 0,
          supportsClientRequest: true,
          supportsOnSite: true,
          deepLinkTemplate: null,
          instructions: "Tap below to view our Zelle recipient. Send the amount via Zelle from your bank's app, then come back here and tap \"I've sent the payment\" so we know to look for it.",
          // payToTarget drives the manual-pay modal — same big orange button
          // as Venmo, but tapping opens a modal showing this address in big
          // text with a copy button (Zelle has no universal deep link).
          payToTarget: "{ZELLE_ADDRESS}",
          active: true,
          preferred: true,
        },
        {
          key: "CASH",
          label: "Cash",
          feePercent: 0,
          feeFixed: 0,
          supportsClientRequest: false,
          supportsOnSite: true,
          deepLinkTemplate: null,
          instructions: null,
          active: true,
        },
        {
          key: "CHECK",
          label: "Check",
          feePercent: 0,
          feeFixed: 0,
          supportsClientRequest: true,
          supportsOnSite: true,
          deepLinkTemplate: null,
          instructions: "Make check payable to Seedlings Lawn Care LLC",
          active: true,
        },
      ]),
      description: "Configurable taxonomy of accepted payment methods. Each entry controls fee, where it's shown, deep link, and client instructions. Adding a method here changes the UI without code changes.",
    },
    {
      key: "PAYMENT_FROM_OPTIONS",
      value: JSON.stringify([
        { label: "Chase business card" },
        { label: "Chase business checking" },
        { label: "Owner cash" },
        { label: "Owner personal card" },
        { label: "Venmo balance" },
        { label: "Zelle (bank transfer)" },
      ]),
      description: "Presets for the 'Payment From' picker in the Super → Money → Ledger Add Expense dialog. Each entry is a free-form label (e.g., 'Chase business card', 'Owner cash'). Operator can still leave the field blank or pick 'Other' and type a custom value. Used for matching expense rows to bank/card statements at month-end.",
    },
    {
      key: "EXPENSE_CATEGORIES",
      value: JSON.stringify([
        // plSection drives the P&L Report tab grouping. Only Supplies rolls
        // into Cost of Goods Sold; every other category here is an Operating
        // Expense. Mirrors QB Online's Account Type → P&L section logic.
        // Field is optional in storage: a row without plSection defaults to
        // EXCLUDE_FROM_PNL at load time — the operator must proactively
        // classify a new category as COGS or OPERATING_EXPENSE before it
        // shows up on the report. Safer than silently lumping rows into a
        // section that hasn't been reviewed.
        { label: "Advertising", scheduleCLine: "8", qbAccount: "Advertising & marketing", selectable: true, plSection: "OPERATING_EXPENSE" },
        // "Car and truck expenses" was a single category; split into Fuel +
        // Vehicle Maintenance to match the QB chart of accounts which
        // tracks them separately under the Vehicle & Auto parent.
        { label: "Fuel", scheduleCLine: "9", qbAccount: "Fuel", selectable: true, plSection: "OPERATING_EXPENSE" },
        { label: "Vehicle Maintenance", scheduleCLine: "9", qbAccount: "Vehicle Maintenance & Repairs", selectable: true, plSection: "OPERATING_EXPENSE" },
        { label: "Contract labor", scheduleCLine: "11", qbAccount: "Contract Labor", selectable: true, plSection: "OPERATING_EXPENSE" },
        // Depreciation isn't logged manually in this app (fixed assets are
        // capitalized via the QB Fixed Assets export, depreciation lives in
        // QB itself). Default to EXCLUDE so the row doesn't show as "Unmapped"
        // on the P&L if accidentally used; operator can flip it later.
        { label: "Depreciation", scheduleCLine: "13", qbAccount: null, selectable: true, plSection: "EXCLUDE_FROM_PNL" },
        { label: "Insurance", scheduleCLine: "15", qbAccount: "Insurance", selectable: true, plSection: "OPERATING_EXPENSE" },
        { label: "Legal and professional services", scheduleCLine: "17", qbAccount: "Legal & Professional Fees", selectable: true, plSection: "OPERATING_EXPENSE" },
        { label: "Office expense", scheduleCLine: "18", qbAccount: "Software & Subscriptions", selectable: true, plSection: "OPERATING_EXPENSE" },
        // Rent / lease categories carry no QB account by default — operator
        // adds one + flips plSection to OPERATING_EXPENSE the first time
        // they actually rent something. Until then, EXCLUDE keeps the P&L clean.
        { label: "Rent or lease — vehicles/equipment", scheduleCLine: "20a", qbAccount: null, selectable: true, plSection: "EXCLUDE_FROM_PNL" },
        { label: "Rent or lease — other business property", scheduleCLine: "20b", qbAccount: null, selectable: true, plSection: "EXCLUDE_FROM_PNL" },
        { label: "Repairs and maintenance", scheduleCLine: "21", qbAccount: "Vehicle Maintenance & Repairs", selectable: true, plSection: "OPERATING_EXPENSE" },
        // The ONLY COGS line in the default taxonomy. Materials consumed in
        // providing the service land here; the QB P&L renders this under
        // Cost of Goods Sold above Gross Profit.
        { label: "Supplies", scheduleCLine: "22", qbAccount: "Direct Supplies and Materials", selectable: true, plSection: "COGS" },
        { label: "Taxes and licenses", scheduleCLine: "23", qbAccount: "Taxes & Licenses", selectable: true, plSection: "OPERATING_EXPENSE" },
        // Travel / Meals / Utilities: same pattern — no default QB routing,
        // so default to EXCLUDE. Operator flips to OPERATING_EXPENSE the
        // first time they use them.
        { label: "Travel", scheduleCLine: "24a", qbAccount: null, selectable: true, plSection: "EXCLUDE_FROM_PNL" },
        { label: "Meals", scheduleCLine: "24b", qbAccount: null, selectable: true, plSection: "EXCLUDE_FROM_PNL" },
        { label: "Utilities", scheduleCLine: "25", qbAccount: null, selectable: true, plSection: "EXCLUDE_FROM_PNL" },
        // Synthetic, export-only — sourced from Payment rows, never hand-logged.
        { label: "Payment Processing Fees", scheduleCLine: "10", qbAccount: "Payment Processing Fees", selectable: false, plSection: "OPERATING_EXPENSE" },
        // Catch-all. qbAccount = null routes rows to "Unmapped" in the QB CSV
        // so the operator re-categorizes in QB after import.
        { label: "Other", scheduleCLine: "27a", qbAccount: null, selectable: true, plSection: "OPERATING_EXPENSE" },
      ]),
      description: "Expense-category taxonomy. Each entry maps a category to (a) its Schedule C line for the CPA-facing CSV, (b) its QuickBooks chart-of-accounts name for the QB import CSV, and (c) its P&L section (COGS vs OPERATING_EXPENSE) for the in-app P&L Report. Editing here needs no code change. Account names must match QB exactly (capitalization + spacing).",
    },
    {
      // Equipment-rental income routing for the QB Income export. The
      // Tax Line + QB account are CPA-tweakable from Settings without
      // a code deploy — change the line to "6" if the operator's CPA
      // prefers "Other gross receipts" instead of bundling with Line 1.
      // See memory/project_equipment_rental_income.md.
      key: "EQUIPMENT_RENTAL_INCOME_CONFIG",
      value: JSON.stringify({
        qbAccount: "Equipment Rental Income",
        scheduleCLine: "1",
      }),
      description: "Routing for equipment rental income in the QB Income export. `qbAccount` must match the QB chart-of-accounts entry exactly (capitalization + spacing). `scheduleCLine` is the Schedule C tax line — default '1' (Gross receipts, alongside service revenue); change to '6' (Other gross receipts) if your CPA prefers separate visibility.",
    },
  ];
  for (const s of feeSettings) {
    await prisma.setting.upsert({
      where: { key: s.key },
      create: { key: s.key, value: s.value, description: s.description, updatedById: MICHAEL_ID },
      update: { value: s.value, description: s.description, updatedById: MICHAEL_ID },
    });
  }

  // Equipment kinds configuration
  const equipmentKindsValue = JSON.stringify([
    { key: "MOWER", label: "Mower" },
    { key: "TRIMMER", label: "Trimmer" },
    { key: "EDGER", label: "Edger" },
    { key: "BLOWER", label: "Blower" },
    { key: "HEDGER", label: "Hedger" },
    { key: "CUTTER", label: "Chainsaw" },
    { key: "AERATOR", label: "Aerator" },
    { key: "SPREADER", label: "Spreader" },
    { key: "WASHER", label: "Pressure Washer" },
    { key: "MISC", label: "Misc" },
  ]);
  await prisma.setting.upsert({
    where: { key: "EQUIPMENT_KINDS" },
    create: { key: "EQUIPMENT_KINDS", value: equipmentKindsValue, description: "Equipment kinds with labels. Array of {key, label}. Used in equipment filter and suggestions.", updatedById: MICHAEL_ID },
    update: { value: equipmentKindsValue, description: "Equipment kinds with labels. Array of {key, label}. Used in equipment filter and suggestions.", updatedById: MICHAEL_ID },
  });

  // Service types configuration (unified: tags + equipment mapping)
  const serviceTypesValue = JSON.stringify([
    { key: "MOW", label: "Mow", equipmentKind: "MOWER" },
    { key: "TRIM", label: "Trim", equipmentKind: "TRIMMER" },
    { key: "EDGE", label: "Edge", equipmentKind: "EDGER" },
    { key: "BLOW", label: "Blow", equipmentKind: "BLOWER" },
    { key: "HEDGE", label: "Hedge", equipmentKind: "HEDGER" },
    { key: "LEAF_CLEANUP", label: "Leaf Cleanup", equipmentKind: "BLOWER" },
    { key: "AERATION", label: "Aeration", equipmentKind: "AERATOR" },
    { key: "MULCH", label: "Mulch", equipmentKind: "MISC" },
    { key: "WEED", label: "Weed" },
    { key: "FERTILIZE", label: "Fertilize", equipmentKind: "SPREADER" },
    { key: "TREE_TRIM", label: "Tree Trim", equipmentKind: "CUTTER" },
    { key: "PLANT", label: "Plant" },
  ]);
  await prisma.setting.upsert({
    where: { key: "SERVICE_TYPES" },
    create: { key: "SERVICE_TYPES", value: serviceTypesValue, description: "Service types with labels and optional equipment mapping. Array of {key, label, equipmentKind?}. Order determines UI display.", updatedById: MICHAEL_ID },
    update: { value: serviceTypesValue, description: "Service types with labels and optional equipment mapping. Array of {key, label, equipmentKind?}. Order determines UI display.", updatedById: MICHAEL_ID },
  });

  // Company-document taxonomy + per-version upload cap.
  const documentTypesValue = JSON.stringify([
    { key: "ARTICLES_OF_ORGANIZATION", label: "Articles of Organization", singleton: true, description: "Company formation documents filed with the state." },
    { key: "EIN_LETTER", label: "EIN Letter", singleton: true, description: "IRS letter confirming the company's Employer Identification Number." },
    { key: "OPERATING_AGREEMENT", label: "Operating Agreement", singleton: true, description: "Internal governance document defining ownership and management." },
    { key: "INSURANCE_CERT", label: "Insurance Certificate", singleton: false, description: "Liability, auto, and umbrella coverage certificates from our carriers." },
    { key: "BUSINESS_LICENSE", label: "Business License", singleton: false, description: "Local and state business licenses, one per jurisdiction or renewal cycle." },
    { key: "VENDOR_CONTRACT", label: "Vendor Contract", singleton: false, description: "Service or supply agreements with vendors." },
    { key: "TAX_RETURN", label: "Tax Return", singleton: false, description: "Federal and state tax returns, one per year." },
  ]);
  await prisma.setting.upsert({
    where: { key: "DOCUMENT_TYPES" },
    create: { key: "DOCUMENT_TYPES", value: documentTypesValue, description: "Company document types. Array of {key, label, singleton}. singleton=true means only one active doc per type is allowed.", updatedById: MICHAEL_ID },
    update: { value: documentTypesValue, description: "Company document types. Array of {key, label, singleton}. singleton=true means only one active doc per type is allowed.", updatedById: MICHAEL_ID },
  });
  await prisma.setting.upsert({
    where: { key: "DOCUMENT_MAX_SIZE_MB" },
    create: { key: "DOCUMENT_MAX_SIZE_MB", value: "25", description: "Max file size (MB) for a single CompanyDocument version upload.", updatedById: MICHAEL_ID },
    update: { description: "Max file size (MB) for a single CompanyDocument version upload.", updatedById: MICHAEL_ID },
  });

  // ── Payment request settings ──────────────────────────────────────────────
  const paymentSettings = [
    { key: "BUSINESS_NAME", value: "Seedlings Lawn Care", description: "Display name of the business — appears on receipts, the public payment page, and other client-facing surfaces." },
    { key: "VENMO_BUSINESS_HANDLE", value: "SeedlingsLawnCare", description: "@handle clients use to send Venmo payments (no @ prefix)." },
    { key: "ZELLE_ADDRESS", value: "seedlingslawncare", description: "Email or phone clients use to send Zelle payments." },
    { key: "PAYMENT_REQUEST_BASE_URL", value: "https://www.seedlings.team", description: "Base URL used when generating payment-request SMS/email links (e.g., {BASE}/pay/{token})." },
    { key: "PAYMENT_REQUEST_TOKEN_EXPIRY_HOURS", value: "72", description: "Hours a payment-request token stays valid after the job transitions to PENDING_PAYMENT." },
    { key: "PAYMENT_REQUEST_STALE_DAYS", value: "4", description: "A payment request sent to a client but not yet paid is flagged 'stale' after this many days — surfaced as a Super alert and worklist so it isn't forgotten." },
    { key: "DEFAULT_PAYMENT_COMMUNICATIONS_MODE", value: "CLAIMER", description: "How clients are notified when a payment is due after a finished job. Set to 'Server' to have the app automatically text or email the client. Set to 'Claimer' to have whoever finished the job send the message from their own phone or email. Workers can override this on their profile." },
    { key: "MAX_PHOTOS_PER_JOB", value: "10", description: "Maximum number of photos a worker can upload to a single job. Lowering this only restricts future uploads — photos already on a job are never removed." },
    { key: "PHOTO_MAX_EDGE_PX", value: "1200", description: "Longest edge in pixels for uploaded photos. Photos are resized down to this size before upload to save bandwidth. Only applies to new uploads — already-stored photos keep their original size." },
    { key: "PHOTO_JPEG_QUALITY", value: "0.8", description: "JPEG quality for uploaded photos (0.1 = smaller files, lower quality; 1.0 = largest files, best quality). 0.8 is the recommended balance. Only applies to new uploads." },
    { key: "NOTIFY_PAYMENT_APPROVAL_VIA_SMS_EMAIL", value: "false", description: "When a client reports they sent a payment, push notifications to admins always fire (free). Turn this on to also send a paid SMS (Twilio) or email (Resend) on top of the push. Default is off to keep notification costs at zero." },
    { key: "OUTGOING_COMMS_CC", value: '{"emails":[],"phones":[]}', description: "Recipients automatically CC'd on client SMS/email comms opened from the app (the owner and any supervisors). Email addresses are added as visible cc=; phone numbers join the SMS as additional recipients, which on iOS/Android creates a group thread the client can see. Org policy is full transparency — no silent BCC. Only applies to templated comms (invoices, reschedules, reminders, work-day confirms). Plain contact-menu opens stay 1:1." },
  ];
  for (const s of paymentSettings) {
    await prisma.setting.upsert({
      where: { key: s.key },
      create: { key: s.key, value: s.value, description: s.description, updatedById: MICHAEL_ID },
      update: { description: s.description, updatedById: MICHAEL_ID },
    });
  }

  // ── Company documents (metadata only — for Timeline tab demo) ─────────────
  // These docs have no uploaded version, which means they won't be openable
  // from the Documents tab, but they appear in the Timeline as doc expirations
  // so we can see the mixed-feed UX without uploading real files.
  console.log("  Creating example company documents...");
  const docDaysFromNow = (n: number): Date => {
    const d = new Date();
    d.setUTCHours(12, 0, 0, 0);
    d.setUTCDate(d.getUTCDate() + n);
    return d;
  };
  const docSeed: Array<{
    type: string;
    title: string;
    description?: string;
    expiresAt: Date;
    adminHidden?: boolean;
  }> = [
    {
      type: "INSURANCE_CERT",
      title: "GL — State Farm 2026",
      description: "Primary general liability, $1M/$2M limits.",
      expiresAt: docDaysFromNow(25), // soon (within 30d)
    },
    {
      type: "INSURANCE_CERT",
      title: "Auto policy — Geico 2026",
      description: "Commercial auto coverage on the fleet trucks.",
      expiresAt: docDaysFromNow(5), // urgent (within 7d)
    },
    {
      type: "INSURANCE_CERT",
      title: "Workers comp — Hartford 2025",
      description: "Workers comp policy, last renewed previous year.",
      expiresAt: docDaysFromNow(-3), // expired (past)
    },
    {
      type: "BUSINESS_LICENSE",
      title: "State business license — VA",
      expiresAt: docDaysFromNow(90), // future (>30d)
    },
    {
      type: "BUSINESS_LICENSE",
      title: "Fairfax County operating permit",
      expiresAt: docDaysFromNow(45),
    },
  ];
  for (const d of docSeed) {
    const existing = await prisma.companyDocument.findFirst({
      where: { title: d.title, type: d.type },
    });
    if (existing) {
      await prisma.companyDocument.update({
        where: { id: existing.id },
        data: {
          description: d.description ?? null,
          expiresAt: d.expiresAt,
          adminHidden: !!d.adminHidden,
        },
      });
    } else {
      await prisma.companyDocument.create({
        data: {
          type: d.type,
          title: d.title,
          description: d.description ?? null,
          expiresAt: d.expiresAt,
          adminHidden: !!d.adminHidden,
          createdById: MICHAEL_ID,
        },
      });
    }
  }

  // ── Business Start Date — non-destructive money cleanup ──────────────────
  // Seeded as DISABLED by default. The user flips the toggle in Settings
  // when they're ready to engage the filter. Production deploys land OFF.
  // See apps/api/src/lib/businessStartCutoff.ts.
  await prisma.setting.upsert({
    where: { key: "BUSINESS_START_DATE" },
    create: {
      key: "BUSINESS_START_DATE",
      // Pick a representative cutoff for dev — seeded backdated rows below
      // straddle this date so the filter can be exercised end-to-end.
      value: "2026-06-01",
      description: "Cutoff date for the Business Start Date filter (YYYY-MM-DD). When the toggle below is ON, payments, expenses, equipment charges, and audit events from BEFORE this date are hidden from every view and export. No data is deleted — Super can temporarily reveal pre-cutoff history via the page-level toggle.",
      updatedById: MICHAEL_ID,
    },
    update: { description: "Cutoff date for the Business Start Date filter (YYYY-MM-DD). When the toggle below is ON, payments, expenses, equipment charges, and audit events from BEFORE this date are hidden from every view and export. No data is deleted — Super can temporarily reveal pre-cutoff history via the page-level toggle.", updatedById: MICHAEL_ID },
  });
  await prisma.setting.upsert({
    where: { key: "BUSINESS_START_DATE_ENABLED" },
    create: {
      key: "BUSINESS_START_DATE_ENABLED",
      // OFF by default — flipping it on in Settings engages the filter.
      value: "false",
      description: "Master switch for the Business Start Date filter. Off = every money view shows full history. On = pre-cutoff money rows are hidden from every view and export (Super can transiently reveal them).",
      updatedById: MICHAEL_ID,
    },
    update: { description: "Master switch for the Business Start Date filter. Off = every money view shows full history. On = pre-cutoff money rows are hidden from every view and export (Super can transiently reveal them).", updatedById: MICHAEL_ID },
  });
  await prisma.setting.upsert({
    where: { key: "QB_INCLUDE_CONTRACT_LABOR" },
    create: {
      key: "QB_INCLUDE_CONTRACT_LABOR",
      // ON by default — the app's qb-journal-expenses.csv is the only
      // path getting contractor labor into QB until Gusto's QB
      // integration is configured. Flip OFF after enabling Gusto-QB
      // sync; the integration posts contractor payments directly so
      // the app's rows become duplicative.
      value: "true",
      description: "When ON, qb-journal-expenses.csv emits Contract Labor rows for contractor payments (post-GP splits, GP wage-path work, and historical advances). When OFF, the entire Contract Labor section is dropped — appropriate once Gusto's QuickBooks integration is configured to post contractor payments to QB directly. Default ON.",
      updatedById: MICHAEL_ID,
    },
    update: { description: "When ON, qb-journal-expenses.csv emits Contract Labor rows for contractor payments (post-GP splits, GP wage-path work, and historical advances). When OFF, the entire Contract Labor section is dropped — appropriate once Gusto's QuickBooks integration is configured to post contractor payments to QB directly. Default ON.", updatedById: MICHAEL_ID },
  });
  await prisma.setting.upsert({
    where: { key: "EQUIPMENT_BILLING_ENABLED" },
    create: {
      key: "EQUIPMENT_BILLING_ENABLED",
      // OFF by default in this seed — the operator absorbs equipment
      // cost into a higher contractor commission while finalizing the
      // billing + sales-tax model with a CPA. Flip ON once the
      // settlement workflow is finalized.
      value: "false",
      description: "Master toggle for equipment billing. When ON, equipment checkouts charge contractors per the equipment's daily rate (employees + trainees always pay $0). When OFF, every checkout release records rentalCost = 0 regardless of equipment dailyRate or worker type — equipment chips still render but show $0. Use this when absorbing equipment cost into a higher CONTRACTOR_PLATFORM_FEE_PERCENT. Pending CPA review of the billing model.",
      updatedById: MICHAEL_ID,
    },
    update: { description: "Master toggle for equipment billing. When ON, equipment checkouts charge contractors per the equipment's daily rate (employees + trainees always pay $0). When OFF, every checkout release records rentalCost = 0 regardless of equipment dailyRate or worker type — equipment chips still render but show $0. Use this when absorbing equipment cost into a higher CONTRACTOR_PLATFORM_FEE_PERCENT. Pending CPA review of the billing model.", updatedById: MICHAEL_ID },
  });

  // ── Timeline categories taxonomy ──────────────────────────────────────────
  const timelineCategoriesValue = JSON.stringify([
    { key: "TAXES", label: "Taxes", description: "Tax filings, estimated payments, and IRS deadlines." },
    { key: "INSURANCE", label: "Insurance", description: "Policy renewals, premium payments, and carrier audits." },
    { key: "LICENSING", label: "Licensing", description: "Business licenses, permits, and renewals across jurisdictions." },
    { key: "COMPLIANCE", label: "Compliance", description: "Regulatory filings and compliance reviews." },
    { key: "OPERATIONS", label: "Operations", description: "Internal operational milestones (season kickoffs, off-season prep)." },
    { key: "FINANCE", label: "Finance", description: "Bookkeeping, audits, and other financial calendar items." },
  ]);
  await prisma.setting.upsert({
    where: { key: "TIMELINE_CATEGORIES" },
    create: { key: "TIMELINE_CATEGORIES", value: timelineCategoriesValue, description: "Timeline event categories. Array of {key, label, description}.", updatedById: MICHAEL_ID },
    update: { value: timelineCategoriesValue, description: "Timeline event categories. Array of {key, label, description}.", updatedById: MICHAEL_ID },
  });

  // ── Timeline events ───────────────────────────────────────────────────────
  console.log("  Creating timeline events...");
  // Helper to anchor a recurring event on a date this calendar year (the
  // RRULE will roll it forward to the next future occurrence at read time).
  const thisYear = new Date().getFullYear();
  const date = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  const timelineSeed: Array<{
    title: string;
    description?: string;
    category?: string;
    rrule: string | null;
    anchorDate: Date;
    adminHidden?: boolean;
  }> = [
    {
      title: "Tax filing deadline",
      description: "Federal income tax returns due. Make sure books are closed and the CPA has everything.",
      category: "TAXES",
      rrule: "FREQ=YEARLY;BYMONTH=4;BYMONTHDAY=15",
      anchorDate: date(thisYear, 4, 15),
    },
    {
      title: "Q1 estimated taxes",
      description: "Quarterly estimated tax payment due to IRS.",
      category: "TAXES",
      rrule: "FREQ=YEARLY;BYMONTH=4;BYMONTHDAY=15",
      anchorDate: date(thisYear, 4, 15),
    },
    {
      title: "Q2 estimated taxes",
      category: "TAXES",
      rrule: "FREQ=YEARLY;BYMONTH=6;BYMONTHDAY=15",
      anchorDate: date(thisYear, 6, 15),
    },
    {
      title: "Q3 estimated taxes",
      category: "TAXES",
      rrule: "FREQ=YEARLY;BYMONTH=9;BYMONTHDAY=15",
      anchorDate: date(thisYear, 9, 15),
    },
    {
      title: "Q4 estimated taxes",
      category: "TAXES",
      rrule: "FREQ=YEARLY;BYMONTH=1;BYMONTHDAY=15",
      anchorDate: date(thisYear + 1, 1, 15),
    },
    {
      title: "Annual workers comp audit",
      description: "Carrier audit window — submit payroll figures.",
      category: "INSURANCE",
      rrule: "FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=1",
      anchorDate: date(thisYear, 3, 1),
      adminHidden: true, // example of a Super-only event
    },
    {
      title: "Spring season kickoff meeting",
      description: "Standalone (non-recurring) example.",
      category: "OPERATIONS",
      rrule: null,
      anchorDate: date(thisYear, 3, 15),
    },
    {
      title: "Annual GL policy renewal",
      description: "Renew general liability policy with carrier.",
      category: "INSURANCE",
      rrule: "FREQ=YEARLY;BYMONTH=6;BYMONTHDAY=1",
      anchorDate: date(thisYear, 6, 1),
    },
    {
      title: "Business license renewal — VA",
      category: "LICENSING",
      rrule: "FREQ=YEARLY;BYMONTH=12;BYMONTHDAY=31",
      anchorDate: date(thisYear, 12, 31),
    },
    {
      title: "Quarterly bookkeeping reconciliation",
      description: "Match books to bank/credit card statements.",
      category: "FINANCE",
      rrule: "FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=15",
      anchorDate: date(thisYear, 3, 15),
    },
  ];
  for (const e of timelineSeed) {
    const existing = await prisma.timelineEvent.findFirst({
      where: { title: e.title },
    });
    if (existing) {
      await prisma.timelineEvent.update({
        where: { id: existing.id },
        data: {
          description: e.description ?? null,
          category: e.category ?? null,
          rrule: e.rrule,
          anchorDate: e.anchorDate,
          adminHidden: !!e.adminHidden,
        },
      });
    } else {
      await prisma.timelineEvent.create({
        data: {
          title: e.title,
          description: e.description ?? null,
          category: e.category ?? null,
          rrule: e.rrule,
          anchorDate: e.anchorDate,
          adminHidden: !!e.adminHidden,
          createdById: MICHAEL_ID,
        },
      });
    }
  }

  // ── Notification templates ────────────────────────────────────────────────
  console.log("  Creating notification templates...");
  const notifTemplates = [
    { name: "Cancelled — weather", title: "Today is cancelled", body: "Today's jobs are cancelled due to weather. Stay home — we'll reschedule.", sortOrder: 10 },
    { name: "Schedule change", title: "Schedule update", body: "Your schedule has changed. Please open Seedlings and review your upcoming jobs.", sortOrder: 20 },
    { name: "Equipment notice", title: "Equipment reminder", body: "Please return any checked-out equipment by end of day.", sortOrder: 30 },
    { name: "All hands meeting", title: "Team meeting", body: "Quick team meeting tomorrow at 9am at HQ. See you there.", sortOrder: 40 },
  ];
  for (const t of notifTemplates) {
    const existing = await prisma.notificationTemplate.findFirst({ where: { name: t.name } });
    if (existing) {
      await prisma.notificationTemplate.update({ where: { id: existing.id }, data: t });
    } else {
      await prisma.notificationTemplate.create({ data: t });
    }
  }

  // ── Pricing settings ───────────────────────────────────────────────────────
  console.log("  Creating pricing entries...");

  // Tagged entries surface as inline hints in the add-on dialog and
  // estimate workflow whenever ANY of their tags matches the selected
  // service. Each entry can carry one or more tags (see "Bagged
  // clippings" and "Debris disposal" examples for multi-tag). Two
  // reference-only entries (empty jobTags) demonstrate the "browse-only"
  // pattern that still shows in the guide but doesn't auto-hint.
  const pricingEntries: Array<{ key: string; label: string; description: string; unit: string; amount: number; sortOrder: number; jobTags?: string[] }> = [
    // Reference-only (no jobTags → no auto-hint, only in the guide)
    { key: "pricing_general_labor", label: "General Labor", description: "Hourly rate for general labor tasks like cleanup, hauling, debris removal, and other non-specialized work", unit: "per hour per person", amount: 60, sortOrder: 1 },
    { key: "pricing_mowing_acre", label: "Mowing (per acre)", description: "Standard mowing rate for open acreage using a riding mower. Includes basic trimming along fence lines and obstacles", unit: "per acre", amount: 150, sortOrder: 2 },

    // Tagged — each maps to a JOB_TAGS key so picking that tag in the
    // add-on dialog or estimate workflow lights up the inline hint.
    { key: "pricing_mow_standard", label: "Mow - standard yard", description: "Single-visit residential mow on a typical quarter-acre lot. Includes deck-discharge pattern; bag is +$10.", unit: "per visit", amount: 65, sortOrder: 10, jobTags: ["MOW"] },
    { key: "pricing_trim_standard", label: "String trim", description: "Trim along fence lines, beds, trees, and obstacles. Pair with Mow as standard.", unit: "per visit", amount: 25, sortOrder: 20, jobTags: ["TRIM"] },
    { key: "pricing_edge_standard", label: "Edge - driveway + walks", description: "Stick-edge driveway, sidewalks, and curb. ~150 linear ft assumed.", unit: "per visit", amount: 25, sortOrder: 30, jobTags: ["EDGE"] },
    { key: "pricing_blow_standard", label: "Blow off hardscapes", description: "Clean drive, walks, and patios after mow/trim/edge.", unit: "per visit", amount: 15, sortOrder: 40, jobTags: ["BLOW"] },
    { key: "pricing_hedge_small", label: "Hedge - small (under 6 ft)", description: "Boxwood, privet, ornamental. Per-visit shape-up; heavier rejuvenation cuts billed at labor rate.", unit: "per visit", amount: 75, sortOrder: 50, jobTags: ["HEDGE"] },
    { key: "pricing_leaf_cleanup_yard", label: "Leaf cleanup - typical yard", description: "Bag-and-haul leaf cleanup on a residential lot. Pricing scales with leaf load; storm cleanup is separate.", unit: "per visit", amount: 180, sortOrder: 60, jobTags: ["LEAF_CLEANUP"] },
    { key: "pricing_aeration_5k", label: "Aeration - up to 5,000 sq ft", description: "Core aeration with double-pass on compacted areas. Add seed/starter fertilizer separately.", unit: "per visit", amount: 145, sortOrder: 70, jobTags: ["AERATION"] },
    { key: "pricing_mulch_per_yard", label: "Mulch - installed", description: "Premium hardwood mulch, spread to 2-3\" depth. Edging touchup included.", unit: "per cubic yard installed", amount: 95, sortOrder: 80, jobTags: ["MULCH"] },
    { key: "pricing_weed_beds", label: "Weed beds", description: "Hand-pull weeds and apply pre-emergent in landscape beds.", unit: "per visit", amount: 60, sortOrder: 90, jobTags: ["WEED"] },
    { key: "pricing_fertilize_lawn", label: "Fertilize lawn", description: "Granular fertilizer application, broadcast spreader. Mid-grade NPK; weed-and-feed is +$25.", unit: "per visit", amount: 85, sortOrder: 100, jobTags: ["FERTILIZE"] },
    { key: "pricing_tree_trim_small", label: "Tree trim - small (under 20 ft)", description: "Crown thin / shape with pole pruner. Chainsaw work over 4\" diameter is separate.", unit: "per tree", amount: 120, sortOrder: 110, jobTags: ["TREE_TRIM"] },
    { key: "pricing_plant_install_1gal", label: "Plant install - 1 gal", description: "Plant install: dig, amend soil, mulch in. Per-plant rate for 1-gallon sizes.", unit: "per plant", amount: 28, sortOrder: 120, jobTags: ["PLANT"] },

    // Multi-tag examples - a single entry that applies as a hint across
    // several service tags. Same row surfaces in the add-on dialog
    // whether the worker picks MOW, LEAF_CLEANUP, or TREE_TRIM.
    { key: "pricing_bagged_clippings", label: "Bagged clippings - upcharge", description: "Per-visit upcharge to bag grass clippings or leaf debris instead of mulching/discharging in place. Common on MOW and LEAF_CLEANUP visits.", unit: "per visit", amount: 10, sortOrder: 200, jobTags: ["MOW", "LEAF_CLEANUP"] },
    { key: "pricing_debris_disposal", label: "Debris disposal / haul-off", description: "Trailer load haul-off for yard debris generated on site. Applies to leaf cleanup, tree trim, mulch tear-out, and any heavy-debris visit.", unit: "per trailer load", amount: 75, sortOrder: 210, jobTags: ["LEAF_CLEANUP", "TREE_TRIM", "MULCH"] },
  ];
  for (const p of pricingEntries) {
    const value = JSON.stringify({
      label: p.label,
      description: p.description,
      unit: p.unit,
      amount: p.amount,
      sortOrder: p.sortOrder,
      // Always persist the array shape; readers fall back to legacy
      // single-string `jobTag` for old rows that haven't been re-saved.
      jobTags: p.jobTags ?? [],
    });
    await prisma.setting.upsert({
      where: { key: p.key },
      create: { key: p.key, value, updatedById: MICHAEL_ID },
      update: { value, updatedById: MICHAEL_ID },
    });
  }

  // ── Reminders ──────────────────────────────────────────────────────────────
  console.log("  Creating reminders...");

  // Admin Worker: reminder due today to follow up on Chen tree estimate
  await prisma.reminder.create({
    data: { userId: ADMIN_WORKER_ID, occurrenceId: estChenTree.id, remindAt: daysFromNow(0, 9), note: "Follow up with Lisa Chen on tree trimming pricing" },
  });
  // Admin Worker: future reminder on church pressure wash
  await prisma.reminder.create({
    data: { userId: ADMIN_WORKER_ID, occurrenceId: estChurchWash.id, remindAt: daysFromNow(5, 9), note: "Check if church board approved pressure wash" },
  });
  // Employee: reminder due yesterday (overdue) on a completed job
  await prisma.reminder.create({
    data: { userId: EMPLOYEE_ID, occurrenceId: cObrien7.id, remindAt: daysAgo(1, 9), note: "Ask O'Brien about recurring schedule change" },
  });

  // ── Tasks ──────────────────────────────────────────────────────────────────
  console.log("  Creating tasks...");

  const taskData: { title: string; startAt: Date; userId: string; notes?: string; status?: string; linkedOccurrenceId?: string }[] = [
    { title: "Buy mulch bags for Harrington", startAt: daysFromNow(0, 9), userId: ADMIN_WORKER_ID, notes: "Need 10 bags of premium hardwood mulch from Home Depot", linkedOccurrenceId: todayHarrington.id },
    { title: "Call Lisa Chen about tree trimming schedule", startAt: daysFromNow(1, 10), userId: ADMIN_WORKER_ID, linkedOccurrenceId: estChenTree.id },
    { title: "Sharpen mower blades", startAt: daysAgo(1, 8), userId: EMPLOYEE_ID, notes: "Honda push mower in maintenance — blades need sharpening before next use", status: "CLOSED" },
    { title: "Pick up new trimmer line", startAt: daysFromNow(2, 9), userId: CONTRACTOR_ID, notes: "Stihl .095 round, 3lb spool" },
  ];

  for (const t of taskData) {
    const task = await prisma.jobOccurrence.create({
      data: {
        jobId: null,
        kind: null,
        title: t.title,
        notes: t.notes ?? null,
        startAt: t.startAt,
        status: (t.status ?? "SCHEDULED") as any,
        source: "MANUAL",
        workflow: "TASK",
        linkedOccurrenceId: t.linkedOccurrenceId ?? null,
      },
    });
    await prisma.jobOccurrenceAssignee.create({
      data: { occurrenceId: task.id, userId: t.userId, assignedById: t.userId },
    });
  }

  // ── Pinned occurrences ─────────────────────────────────────────────────────
  console.log("  Creating pinned occurrences...");

  // Admin Worker pins today's Harrington mow and Willowbrook
  await prisma.pinnedOccurrence.create({ data: { userId: ADMIN_WORKER_ID, occurrenceId: todayHarrington.id } });
  await prisma.pinnedOccurrence.create({ data: { userId: ADMIN_WORKER_ID, occurrenceId: todayWillowbrook.id } });
  // Employee pins tomorrow's leaf cleanup
  await prisma.pinnedOccurrence.create({ data: { userId: EMPLOYEE_ID, occurrenceId: tomorrowChenLeaf.id } });

  console.log("  Creating liked occurrences...");
  await prisma.likedOccurrence.create({ data: { userId: ADMIN_WORKER_ID, occurrenceId: todayHarrington.id } });
  await prisma.likedOccurrence.create({ data: { userId: ADMIN_WORKER_ID, occurrenceId: cThompson7.id } });
  await prisma.likedOccurrence.create({ data: { userId: EMPLOYEE_ID, occurrenceId: cObrien7.id } });
  await prisma.likedOccurrence.create({ data: { userId: CONTRACTOR_ID, occurrenceId: cSunrise7.id } });

  console.log("  Creating occurrence instructions...");
  // Willowbrook today: 2 instructions, one repeating preset + one one-time custom
  await prisma.occurrenceInstruction.create({ data: { occurrenceId: todayWillowbrook.id, text: "Cut shorter", isPreset: true, repeats: true, sortOrder: 0 } });
  await prisma.occurrenceInstruction.create({ data: { occurrenceId: todayWillowbrook.id, text: "Board meeting tomorrow — extra clean edges", isPreset: false, repeats: false, sortOrder: 1 } });
  // River Bend today: 3 instructions, mix of repeating and one-time
  await prisma.occurrenceInstruction.create({ data: { occurrenceId: todayRiverBend.id, text: "Bag clippings", isPreset: true, repeats: false, sortOrder: 0 } });
  await prisma.occurrenceInstruction.create({ data: { occurrenceId: todayRiverBend.id, text: "Watch for pet", isPreset: true, repeats: true, sortOrder: 1 } });
  await prisma.occurrenceInstruction.create({ data: { occurrenceId: todayRiverBend.id, text: "Client event this weekend — park on street", isPreset: false, repeats: false, sortOrder: 2 } });
  // Harrington today: 1 repeating instruction
  await prisma.occurrenceInstruction.create({ data: { occurrenceId: todayHarrington.id, text: "Gate code changed", isPreset: true, repeats: true, sortOrder: 0 } });

  console.log("  Creating linked occurrences...");
  // Link the Harrington today and tomorrow occurrences
  const linkGroup1 = "link-group-harrington-1";
  await prisma.jobOccurrence.update({ where: { id: todayHarrington.id }, data: { linkGroupId: linkGroup1 } });
  await prisma.jobOccurrence.update({ where: { id: cHarrington7.id }, data: { linkGroupId: linkGroup1 } });

  console.log("  Creating standalone reminders...");
  const reminder1 = await prisma.jobOccurrence.create({
    data: {
      title: "Renew business insurance policy",
      startAt: daysFromNow(5, 9),
      status: "SCHEDULED",
      source: "MANUAL",
      workflow: "REMINDER",
      notes: "Policy expires end of month. Call State Farm agent at (512) 555-0199.",
    } as any,
  });
  await prisma.jobOccurrenceAssignee.create({ data: { occurrenceId: reminder1.id, userId: ADMIN_WORKER_ID, assignedById: ADMIN_WORKER_ID } });

  const reminder2 = await prisma.jobOccurrence.create({
    data: {
      title: "Order new trimmer line bulk pack",
      startAt: daysFromNow(1, 9),
      status: "SCHEDULED",
      source: "MANUAL",
      workflow: "REMINDER",
      notes: "Running low. Stihl .095 round — check Amazon for bulk pricing.",
    } as any,
  });
  await prisma.jobOccurrenceAssignee.create({ data: { occurrenceId: reminder2.id, userId: EMPLOYEE_ID, assignedById: EMPLOYEE_ID } });

  const reminder3 = await prisma.jobOccurrence.create({
    data: {
      title: "Schedule truck oil change",
      startAt: daysAgo(2, 9),
      status: "SCHEDULED",
      source: "MANUAL",
      workflow: "REMINDER",
    } as any,
  });
  await prisma.jobOccurrenceAssignee.create({ data: { occurrenceId: reminder3.id, userId: ADMIN_WORKER_ID, assignedById: ADMIN_WORKER_ID } });

  console.log("  Creating light estimates...");
  const lightEst1 = await prisma.jobOccurrence.create({
    data: {
      title: "Johnson backyard cleanup & mulch",
      startAt: daysFromNow(3, 10),
      status: "SCHEDULED",
      source: "MANUAL",
      workflow: "ESTIMATE",
      isEstimate: true,
      isAdminOnly: true,
      contactName: "Mark Johnson",
      contactPhone: "(555) 888-1234",
      contactEmail: "mark.johnson@example.com",
      estimateAddress: "4521 Ridgewood Dr, Austin, TX 78731",
      notes: "Neighbor referral from Thompson. Large backyard, needs full cleanup and mulch install. Has 3 flower beds and a hedge row.",
    } as any,
  });
  await prisma.jobOccurrenceAssignee.create({ data: { occurrenceId: lightEst1.id, userId: ADMIN_WORKER_ID, assignedById: ADMIN_WORKER_ID } });
  await prisma.jobOccurrenceAssignee.create({ data: { occurrenceId: lightEst1.id, userId: CONTRACTOR_ID, assignedById: ADMIN_WORKER_ID } });

  const lightEst2 = await prisma.jobOccurrence.create({
    data: {
      title: "Nguyen front yard renovation estimate",
      startAt: daysFromNow(5, 14),
      status: "PROPOSAL_SUBMITTED",
      source: "MANUAL",
      workflow: "ESTIMATE",
      isEstimate: true,
      isAdminOnly: true,
      contactName: "Tina Nguyen",
      contactPhone: "(555) 777-5678",
      estimateAddress: "892 Barton Springs Rd, Austin, TX 78704",
      proposalAmount: 1200,
      proposalNotes: "Front yard renovation: remove existing sod, install new St. Augustine, edge all beds, add 15 bags of mulch. Includes labor and materials. Two-day job — day 1 demo, day 2 install.",
      notes: "Called in from website. Wants to improve curb appeal before listing house.",
    } as any,
  });
  await prisma.jobOccurrenceAssignee.create({ data: { occurrenceId: lightEst2.id, userId: ADMIN_WORKER_ID, assignedById: ADMIN_WORKER_ID } });

  console.log("  Creating comments...");
  await prisma.occurrenceComment.create({ data: { occurrenceId: todayHarrington.id, authorId: ADMIN_WORKER_ID, body: "Gate code changed to 5912 — confirmed with James this morning." } });
  await prisma.occurrenceComment.create({ data: { occurrenceId: todayHarrington.id, authorId: EMPLOYEE_ID, body: "Got it, thanks. Also the sprinkler heads near the driveway are sticking up — watch the mower." } });
  await prisma.occurrenceComment.create({ data: { occurrenceId: todayWillowbrook.id, authorId: ADMIN_WORKER_ID, body: "HOA board meeting next week — Susan wants the entrance looking sharp. Extra attention on edging please." } });
  await prisma.occurrenceComment.create({ data: { occurrenceId: cThompson7.id, authorId: CONTRACTOR_ID, body: "Dog was loose in the backyard last time. Call ahead to make sure it's inside." } });

  // ── Audit-triggering test data ──────────────────────────────────────────
  console.log("  Creating audit test data...");

  // 1. Duplicate client name (matches "Patel Residence")
  await prisma.client.create({
    data: { type: "PERSON", displayName: "Patel Residence", notesInternal: "Possible duplicate — entered by mistake?" },
  });

  // 2. Duplicate property address (matches "914 Pecan St" — O'Brien Home)
  await prisma.property.create({
    data: { clientId: obrienFamily.id, displayName: "O'Brien Backyard", street1: "914 Pecan St", city: "Pflugerville", state: "TX", postalCode: "78660", country: "US", kind: "SINGLE" },
  });

  // 3. Duplicate active job (same property+kind as obrienMow)
  await prisma.job.create({
    data: { propertyId: obrienHome.id, kind: "SINGLE_ADDRESS", status: "ACCEPTED", frequencyDays: 14, defaultPrice: 50.0, estimatedMinutes: 35, notes: "Duplicate mow job — might be accidental" },
  });

  // 4. Duplicate repeating occurrences (two SCHEDULED on same job, 1 day apart)
  await prisma.jobOccurrence.create({
    data: { jobId: martinezBiweekly.id, kind: "SINGLE_ADDRESS", startAt: daysFromNow(3, 8), status: "SCHEDULED", source: "GENERATED", workflow: "STANDARD" } as any,
  });
  await prisma.jobOccurrence.create({
    data: { jobId: martinezBiweekly.id, kind: "SINGLE_ADDRESS", startAt: daysFromNow(4, 8), status: "SCHEDULED", source: "GENERATED", workflow: "STANDARD" } as any,
  });

  // 5. Missing next occurrence: completed repeating job, no SCHEDULED sibling
  const orphanJob = await prisma.job.create({
    data: { propertyId: sunriseCommon.id, kind: "ENTIRE_SITE", status: "ACCEPTED", frequencyDays: 7, defaultPrice: 180.0, estimatedMinutes: 90, notes: "Weekly common area mow — next occurrence should have been auto-created" },
  });
  await prisma.jobOccurrence.create({
    // hoursApprovedAt stamped explicitly because this row bypasses the
    // occ() helper. Orphan-scenario row, irrelevant to payroll testing.
    data: { jobId: orphanJob.id, kind: "ENTIRE_SITE", startAt: daysAgo(10, 8), completedAt: daysAgo(10, 10), hoursApprovedAt: daysAgo(10, 10), status: "CLOSED", source: "GENERATED", workflow: "STANDARD" } as any,
  });
  // Intentionally NO scheduled occurrence for this job — simulates a failed auto-create

  // ── Events (team-scoped, admin creates, assigned team sees) ─────────────
  console.log("  Creating events...");

  const weeklyMeeting = await prisma.jobOccurrence.create({
    data: {
      title: "Weekly Team Meeting",
      notes: "Discuss weekly schedule, assignments, and any issues. Meet at the warehouse.",
      startAt: daysFromNow(1, 11),
      status: "SCHEDULED",
      source: "MANUAL",
      workflow: "EVENT",
      frequencyDays: 7,
    } as any,
  });
  await prisma.jobOccurrenceAssignee.createMany({
    data: [
      { occurrenceId: weeklyMeeting.id, userId: MICHAEL_ID, assignedById: MICHAEL_ID },
      { occurrenceId: weeklyMeeting.id, userId: ADMIN_WORKER_ID, assignedById: MICHAEL_ID },
      { occurrenceId: weeklyMeeting.id, userId: CONTRACTOR_ID, assignedById: MICHAEL_ID },
      { occurrenceId: weeklyMeeting.id, userId: EMPLOYEE_ID, assignedById: MICHAEL_ID },
    ],
  });

  const equipmentInspection = await prisma.jobOccurrence.create({
    data: {
      title: "Monthly Equipment Inspection",
      notes: "Check all mowers, trimmers, and blowers. Log any maintenance needs.",
      startAt: daysFromNow(5, 8),
      status: "SCHEDULED",
      source: "MANUAL",
      workflow: "EVENT",
      frequencyDays: 30,
    } as any,
  });
  await prisma.jobOccurrenceAssignee.createMany({
    data: [
      { occurrenceId: equipmentInspection.id, userId: MICHAEL_ID, assignedById: MICHAEL_ID },
      { occurrenceId: equipmentInspection.id, userId: ADMIN_WORKER_ID, assignedById: MICHAEL_ID },
    ],
  });

  const pastEvent = await prisma.jobOccurrence.create({
    data: {
      title: "Safety Training",
      notes: "Annual safety training — required for all workers.",
      startAt: daysAgo(3, 9),
      completedAt: daysAgo(3, 11),
      status: "CLOSED",
      source: "MANUAL",
      workflow: "EVENT",
    } as any,
  });
  await prisma.jobOccurrenceAssignee.create({
    data: { occurrenceId: pastEvent.id, userId: MICHAEL_ID, assignedById: MICHAEL_ID },
  });

  // ── Followups (team-scoped, with attached clients/jobs) ────────────────
  console.log("  Creating followups...");

  const followupThompson = await prisma.jobOccurrence.create({
    data: {
      title: "Follow up on Thompson pricing",
      notes: "Discuss new pricing for expanded service area. They want a quote for the back lot.",
      startAt: daysFromNow(2, 9),
      status: "SCHEDULED",
      source: "MANUAL",
      workflow: "FOLLOWUP",
    } as any,
  });
  await prisma.jobOccurrenceAssignee.create({
    data: { occurrenceId: followupThompson.id, userId: MICHAEL_ID, assignedById: MICHAEL_ID },
  });
  await prisma.followupClient.create({
    data: { occurrenceId: followupThompson.id, clientId: vipThompson.id },
  });

  const followupWillowbrook = await prisma.jobOccurrence.create({
    data: {
      title: "Willowbrook HOA contract renewal",
      notes: "Contract expires end of month. Confirm renewal terms and schedule meeting with board.",
      startAt: daysFromNow(7, 10),
      status: "SCHEDULED",
      source: "MANUAL",
      workflow: "FOLLOWUP",
      frequencyDays: 30,
    } as any,
  });
  await prisma.jobOccurrenceAssignee.createMany({
    data: [
      { occurrenceId: followupWillowbrook.id, userId: MICHAEL_ID, assignedById: MICHAEL_ID },
      { occurrenceId: followupWillowbrook.id, userId: ADMIN_WORKER_ID, assignedById: MICHAEL_ID },
    ],
  });
  await prisma.followupClient.create({
    data: { occurrenceId: followupWillowbrook.id, clientId: willowbrookHoa.id },
  });
  await prisma.followupJob.create({
    data: { occurrenceId: followupWillowbrook.id, jobId: willowbrookWeekly.id },
  });

  const followupChen = await prisma.jobOccurrence.create({
    data: {
      title: "Check on Chen tree estimate",
      notes: "They said they'd decide by this week.",
      startAt: daysFromNow(0, 14),
      status: "SCHEDULED",
      source: "MANUAL",
      workflow: "FOLLOWUP",
    } as any,
  });
  await prisma.jobOccurrenceAssignee.create({
    data: { occurrenceId: followupChen.id, userId: MICHAEL_ID, assignedById: MICHAEL_ID },
  });
  await prisma.followupClient.create({
    data: { occurrenceId: followupChen.id, clientId: chenResidence.id },
  });
  await prisma.followupJob.create({
    data: { occurrenceId: followupChen.id, jobId: chenTreeEstimate.id },
  });

  // ── Announcements (universally visible) ────────────────────────────────
  console.log("  Creating announcements...");

  const ann1 = await prisma.jobOccurrence.create({
    data: {
      title: "Office closed — Memorial Day",
      notes: "No scheduled work. Emergency calls only.",
      startAt: daysFromNow(10, 9),
      status: "SCHEDULED",
      source: "MANUAL",
      workflow: "ANNOUNCEMENT",
    } as any,
  });
  await prisma.jobOccurrenceAssignee.create({ data: { occurrenceId: ann1.id, userId: MICHAEL_ID, assignedById: MICHAEL_ID } });

  const ann2 = await prisma.jobOccurrence.create({
    data: {
      title: "Payroll Reminder",
      notes: "Submit all hours and expenses by end of day Friday.",
      startAt: daysFromNow(3, 9),
      status: "SCHEDULED",
      source: "MANUAL",
      workflow: "ANNOUNCEMENT",
    } as any,
  });
  await prisma.jobOccurrenceAssignee.create({ data: { occurrenceId: ann2.id, userId: MICHAEL_ID, assignedById: MICHAEL_ID } });

  const ann3 = await prisma.jobOccurrence.create({
    data: {
      title: "New mulch supplier — effective immediately",
      notes: "We're switching to GreenGrow Mulch. Old stock must be used first. See warehouse board for details.",
      startAt: daysAgo(1, 9),
      status: "SCHEDULED",
      source: "MANUAL",
      workflow: "ANNOUNCEMENT",
    } as any,
  });
  await prisma.jobOccurrenceAssignee.create({ data: { occurrenceId: ann3.id, userId: MICHAEL_ID, assignedById: MICHAEL_ID } });

  const ann4 = await prisma.jobOccurrence.create({
    data: {
      title: "Spring rate adjustments",
      notes: "New seasonal rates are in effect. Check the pricing sheet on the shared drive.",
      startAt: daysAgo(5, 9),
      status: "SCHEDULED",
      source: "MANUAL",
      workflow: "ANNOUNCEMENT",
    } as any,
  });
  await prisma.jobOccurrenceAssignee.create({ data: { occurrenceId: ann4.id, userId: MICHAEL_ID, assignedById: MICHAEL_ID } });

  const ann5 = await prisma.jobOccurrence.create({
    data: {
      title: "Truck maintenance scheduled Thursday",
      notes: "Truck #2 going in for brake service. Plan routes accordingly — only Truck #1 and #3 available.",
      startAt: daysFromNow(4, 7),
      status: "SCHEDULED",
      source: "MANUAL",
      workflow: "ANNOUNCEMENT",
    } as any,
  });
  await prisma.jobOccurrenceAssignee.create({ data: { occurrenceId: ann5.id, userId: MICHAEL_ID, assignedById: MICHAEL_ID } });

  const ann6 = await prisma.jobOccurrence.create({
    data: {
      title: "Safety vests required on all HOA sites",
      notes: "Starting next week, all workers must wear high-vis vests on HOA properties. Vests available at the warehouse.",
      startAt: daysFromNow(6, 9),
      status: "SCHEDULED",
      source: "MANUAL",
      workflow: "ANNOUNCEMENT",
    } as any,
  });
  await prisma.jobOccurrenceAssignee.create({ data: { occurrenceId: ann6.id, userId: MICHAEL_ID, assignedById: MICHAEL_ID } });

  const ann7 = await prisma.jobOccurrence.create({
    data: {
      title: "Client appreciation BBQ — next Saturday",
      notes: "Annual client appreciation event at the office. All hands on deck for setup at 10am. Event starts at noon.",
      startAt: daysFromNow(12, 10),
      status: "SCHEDULED",
      source: "MANUAL",
      workflow: "ANNOUNCEMENT",
    } as any,
  });
  await prisma.jobOccurrenceAssignee.create({ data: { occurrenceId: ann7.id, userId: MICHAEL_ID, assignedById: MICHAEL_ID } });

  const ann8 = await prisma.jobOccurrence.create({
    data: {
      title: "New edging technique training video",
      notes: "Check the team group chat for the link. Everyone should watch it before Monday.",
      startAt: daysFromNow(1, 9),
      status: "SCHEDULED",
      source: "MANUAL",
      workflow: "ANNOUNCEMENT",
    } as any,
  });
  await prisma.jobOccurrenceAssignee.create({ data: { occurrenceId: ann8.id, userId: MICHAEL_ID, assignedById: MICHAEL_ID } });

  await seedWorkdayFixtures();

  await applySettingSections();

  console.log("  Seed complete!");
}

/**
 * Workday fixtures — one row per seed worker covering every UI state so the
 * Worker Home strip + dialogs can be eyeballed end-to-end without manual
 * setup. Anchored on the actual current wall-clock so all the live
 * durations tick correctly in the strip.
 *
 *   EMPLOYEE_ID    → IN_PROGRESS (started 3h ago, no pauses)
 *   CONTRACTOR_ID  → PAUSED (started 4h ago, paused 30m ago, 12m prior pause)
 *   TRAINEE_ID     → COMPLETED (8h day with 30m lunch — today's edit window
 *                    is still open so the "Edit times" affordance fires)
 *   ADMIN_WORKER_ID → forgot-yesterday (open IN_PROGRESS row from yesterday,
 *                    nothing today — surfaces the orange catch-up strip)
 *   MICHAEL_ID     → NOT_STARTED (no row — surfaces the "Start workday" button)
 */
async function seedWorkdayFixtures() {
  console.log("  Workday fixtures (one row per state for each seed worker)...");

  const now = new Date();
  const today = etFormatDate(now);
  const yesterday = etFormatDate(daysAgo(1));
  const mins = (n: number) => n * 60 * 1000;
  const hrs = (n: number) => n * 60 * 60 * 1000;

  // ── EMPLOYEE_ID: IN_PROGRESS ────────────────────────────────────────
  await prisma.workerWorkday.create({
    data: {
      userId: EMPLOYEE_ID,
      workdayDate: today,
      startedAt: new Date(now.getTime() - hrs(3)),
    },
  });

  // ── CONTRACTOR_ID: PAUSED ──────────────────────────────────────────
  // Started 4h ago, took a 12-minute break that's already accumulated
  // into totalPausedMs, currently paused since 30m ago. Live UI shows
  // both the closed and the open pause segments.
  await prisma.workerWorkday.create({
    data: {
      userId: CONTRACTOR_ID,
      workdayDate: today,
      startedAt: new Date(now.getTime() - hrs(4)),
      pausedAt: new Date(now.getTime() - mins(30)),
      totalPausedMs: mins(12),
    },
  });

  // ── TRAINEE_ID: COMPLETED ──────────────────────────────────────────
  // 8h workday with a 30-minute lunch break. Anchors at 8:00 AM ET so
  // the times render consistently regardless of when the seed runs.
  // Today's same-day edit window is still open so the strip renders the
  // "Edit times" link.
  const traineeStart = new Date(now.getTime() - hrs(9));
  const traineeEnd = new Date(traineeStart.getTime() + hrs(8) + mins(30));
  await prisma.workerWorkday.create({
    data: {
      userId: TRAINEE_ID,
      workdayDate: today,
      startedAt: traineeStart,
      endedAt: traineeEnd,
      totalPausedMs: mins(30),
    },
  });

  // ── ADMIN_WORKER_ID: forgot-yesterday ───────────────────────────────
  // IN_PROGRESS row from yesterday, never ended. The Home strip surfaces
  // the orange "you forgot to end your workday" prompt with a "Set end
  // time" button that opens the catch-up dialog.
  await prisma.workerWorkday.create({
    data: {
      userId: ADMIN_WORKER_ID,
      workdayDate: yesterday,
      startedAt: new Date(now.getTime() - hrs(28)), // ~yesterday 8am-ish
    },
  });

  // ── MICHAEL_ID: NOT_STARTED ─────────────────────────────────────────
  // No row at all — exercises the "Workday hasn't started yet" + Start
  // workday button on the Hero strip.
  //  (No-op: deliberately seeding nothing for Michael.)

  // ─── Super Workdays tab fixtures ──────────────────────────────────────
  // Past-day rows for the Super approval surface. Two days back is well
  // outside the 4 AM ET cutoff so the approval window is always open
  // regardless of when the seed runs. Each fixture exercises a different
  // group in the Super tab: APPROVED, PENDING APPROVAL, NEEDS ENDING.
  //
  // `daysAgo(n, hour)` returns a Date at hour HH:00 local-time, N calendar
  // days back — DST-safe via `.setDate()` per the existing seed pattern.
  const twoDaysAgoDate = etFormatDate(daysAgo(2));
  const threeDaysAgoDate = etFormatDate(daysAgo(3));
  // Yesterday's date — when this seed's approvals were stamped — so the
  // "Approved by Michael on …" line renders with a plausible timestamp.
  const yesterdayApproval = daysAgo(1, 16); // 4 PM yesterday

  // EMPLOYEE_ID — APPROVED row (two days ago)
  // Already approved by Michael; appears in the "Approved" section with
  // an "Approved by Michael" subline and a (re)Review button.
  await prisma.workerWorkday.create({
    data: {
      userId: EMPLOYEE_ID,
      workdayDate: twoDaysAgoDate,
      startedAt: daysAgo(2, 8),
      endedAt: daysAgo(2, 17),
      totalPausedMs: mins(30),
      approvedAt: yesterdayApproval,
      approvedById: MICHAEL_ID,
    },
  });

  // CONTRACTOR_ID — PENDING APPROVAL row (two days ago)
  // Ended cleanly but no admin has reviewed yet. Appears in the "Pending
  // approval" section with a checkbox for bulk approve + Review button.
  await prisma.workerWorkday.create({
    data: {
      userId: CONTRACTOR_ID,
      workdayDate: twoDaysAgoDate,
      startedAt: daysAgo(2, 7),
      endedAt: daysAgo(2, 17),
      totalPausedMs: mins(45),
    },
  });

  // TRAINEE_ID — PENDING APPROVAL row (two days ago)
  // Second pending row so bulk-approve has more than one row to select.
  await prisma.workerWorkday.create({
    data: {
      userId: TRAINEE_ID,
      workdayDate: twoDaysAgoDate,
      startedAt: daysAgo(2, 9),
      endedAt: daysAgo(2, 17),
      totalPausedMs: mins(20),
    },
  });

  // ADMIN_WORKER_ID — NEEDS ENDING row (three days ago)
  // Never ended. Exercises the unified Review dialog's "open" banner and
  // the "Set the end time below to close it before approving" flow.
  await prisma.workerWorkday.create({
    data: {
      userId: ADMIN_WORKER_ID,
      workdayDate: threeDaysAgoDate,
      startedAt: daysAgo(3, 8),
    },
  });

  // MICHAEL_ID — APPROVED row (two days ago) approved by self.
  // Lets the "Approved by" line render for the seeded admin (self-approval
  // is allowed since Michael is a Super; the audit log captures it).
  await prisma.workerWorkday.create({
    data: {
      userId: MICHAEL_ID,
      workdayDate: twoDaysAgoDate,
      startedAt: daysAgo(2, 8),
      endedAt: daysAgo(2, 17),
      totalPausedMs: mins(30),
      approvedAt: yesterdayApproval,
      approvedById: MICHAEL_ID,
    },
  });

  // ─── Backfill: workdays aligned with seeded completed jobs ───────────
  // The Worker Reconciliation Cockpit (and the Workdays CSV) is only
  // useful when workers have BOTH workday hours AND completed jobs on
  // the same days. The state-only fixtures above cover the UI states
  // but don't tie to specific jobs. This pass walks every completed
  // occurrence in the seed and ensures the assignees have a workday
  // for that date — so the reconciliation tab shows a "healthy"
  // period view with hours, jobs, and meaningful hourly rates,
  // alongside the deliberately-anomalous rows above.
  //
  // Uses upsert so the per-state fixtures take precedence (won't
  // overwrite an open IN_PROGRESS row for ADMIN_WORKER yesterday with
  // a closed one here).
  console.log("    Workday backfill aligned with completed jobs...");
  const completedOccs = await prisma.jobOccurrence.findMany({
    where: {
      completedAt: { not: null },
      workflow: { in: ["STANDARD", "ONE_OFF", "ESTIMATE"] },
    },
    select: {
      completedAt: true,
      assignees: {
        where: { role: { not: "observer" } },
        select: { userId: true },
      },
    },
  });
  // Bucket by (userId, workdayDate) so each worker gets exactly one
  // workday per date even if they did multiple jobs that day.
  const workdayKeys = new Set<string>();
  for (const occ of completedOccs) {
    if (!occ.completedAt) continue;
    const dateKey = etFormatDate(occ.completedAt);
    for (const a of occ.assignees) {
      workdayKeys.add(`${a.userId}|${dateKey}`);
    }
  }
  let backfilledCount = 0;
  for (const key of workdayKeys) {
    const [userId, dateKey] = key.split("|");
    // Build an 8 AM → 5 PM ET workday with a 30-minute lunch break.
    // Easy to read on the Workdays tab and lands the effective hourly
    // in a realistic ballpark. Anchor on the ET date the job was
    // completed; `daysAgo` math runs in local time so it lines up.
    const [y, m, d] = dateKey.split("-").map(Number);
    const startedAt = new Date(`${dateKey}T08:00:00-04:00`);
    const endedAt = new Date(`${dateKey}T17:00:00-04:00`);
    // Skip future dates (DST safety + paranoia)
    if (endedAt.getTime() > Date.now() + 60 * 1000) continue;
    await prisma.workerWorkday.upsert({
      where: { userId_workdayDate: { userId, workdayDate: dateKey } },
      create: {
        userId,
        workdayDate: dateKey,
        startedAt,
        endedAt,
        totalPausedMs: mins(30),
      },
      // Don't clobber the state-only fixtures above — those carry
      // deliberate IN_PROGRESS / PAUSED / NEEDS_ENDING shapes the UI
      // tests rely on.
      update: {},
    });
    backfilledCount += 1;
    void y; void m; void d;
  }
  console.log(`    Backfilled ${backfilledCount} workday rows from ${completedOccs.length} completed occurrences.`);
}

// ── Payments-focused template ──────────────────────────────────────────────
//
// A minimal, intentionally-noisy-free dataset for end-to-end testing of the
// payment lifecycle. Creates 4 clients with varied contact configurations,
// a single recurring job per client, and a handful of occurrences each
// representing one distinct payment-related scenario. Reuse `WORKERS` and
// `MICHAEL_ID` from the existing user constants — same fixed user IDs as
// the main seed so Clerk auth keeps working without re-onboarding.
// Snapshot per-worker promised payouts using the canonical math. Mirrors
// services/payments.ts → computeBreakdown — kept inline here to avoid an
// API↔seed import cycle. Reads rates from Setting.
async function computePromisedPayoutsForSeed(
  price: number,
  expenses: number,
  splits: { userId: string; percent: number }[],
) {
  const [feeS, marginS] = await Promise.all([
    prisma.setting.findUnique({ where: { key: "CONTRACTOR_PLATFORM_FEE_PERCENT" } }),
    prisma.setting.findUnique({ where: { key: "EMPLOYEE_BUSINESS_MARGIN_PERCENT" } }),
  ]);
  const contractorFee = Number(feeS?.value ?? 0);
  const employeeMargin = Number(marginS?.value ?? 0);
  const N = Math.max(0, price - expenses);
  const totalPct = splits.reduce((s, x) => s + x.percent, 0) || 100;
  const users = await prisma.user.findMany({
    where: { id: { in: splits.map((s) => s.userId) } },
    select: { id: true, workerType: true },
  });
  const typeById = new Map(users.map((u) => [u.id, u.workerType]));
  const rows = splits.map((s) => {
    const normalized = (s.percent / totalPct) * 100;
    const gross = N * (normalized / 100);
    const wt = typeById.get(s.userId) ?? null;
    const isEmp = wt === "EMPLOYEE" || wt === "TRAINEE";
    const ratePercent = isEmp ? employeeMargin : contractorFee;
    const fee = gross * (ratePercent / 100);
    return {
      userId: s.userId,
      workerType: wt,
      splitPercent: Math.round(normalized * 100) / 100,
      gross: Math.round(gross * 100) / 100,
      ratePercent,
      fee: Math.round(fee * 100) / 100,
      net: Math.round((gross - fee) * 100) / 100,
    };
  });
  const distributed = rows.reduce((s, r) => s + r.net + r.fee, 0);
  const residual = Math.round((N - distributed) * 100) / 100;
  if (Math.abs(residual) >= 0.01 && rows.length > 0) {
    rows[0].net = Math.round((rows[0].net + residual) * 100) / 100;
  }
  return rows;
}

// Shared infrastructure for both payment-flow templates: the 5 sample
// clients/properties/jobs plus a 2-week spread of SCHEDULED occurrences so
// the worker JobsTab always has work to pick up. Returns the job rows so
// the caller can layer PENDING_PAYMENT scenarios on top (active variant)
// or leave the dataset alone (clean variant).
async function seedPaymentsBase() {
  console.log("  Worker types in use: CONTRACTOR_ID=CONTRACTOR, EMPLOYEE_ID=EMPLOYEE, TRAINEE_ID=TRAINEE, ADMIN_WORKER_ID=EMPLOYEE");
  // Ensure the Exports tab cadence setting exists even when this template is
  // run on a DB that hasn't had the default seed applied yet. Idempotent —
  // won't clobber an existing value the user has tuned.
  await prisma.setting.upsert({
    where: { key: "PAYROLL_PERIOD_CADENCE" },
    create: { key: "PAYROLL_PERIOD_CADENCE", value: "WEEKLY", description: "How often you run payroll. Sets the default date range on the Exports tab.", updatedById: MICHAEL_ID },
    update: { description: "How often you run payroll. Sets the default date range on the Exports tab." },
  });
  // Business Start Date — also seeded here so the payments-clean / payments-
  // active templates show the toggle in Settings. Idempotent; off by default.
  // See apps/api/src/lib/businessStartCutoff.ts.
  await prisma.setting.upsert({
    where: { key: "BUSINESS_START_DATE" },
    create: { key: "BUSINESS_START_DATE", value: "2026-06-01", description: "Cutoff date for the Business Start Date filter (YYYY-MM-DD). When the toggle below is ON, payments, expenses, equipment charges, and audit events from BEFORE this date are hidden from every view and export. No data is deleted — Super can temporarily reveal pre-cutoff history via the page-level toggle.", updatedById: MICHAEL_ID },
    update: { description: "Cutoff date for the Business Start Date filter (YYYY-MM-DD). When the toggle below is ON, payments, expenses, equipment charges, and audit events from BEFORE this date are hidden from every view and export. No data is deleted — Super can temporarily reveal pre-cutoff history via the page-level toggle." },
  });
  await prisma.setting.upsert({
    where: { key: "BUSINESS_START_DATE_ENABLED" },
    create: { key: "BUSINESS_START_DATE_ENABLED", value: "false", description: "Master switch for the Business Start Date filter. Off = every money view shows full history. On = pre-cutoff money rows are hidden from every view and export (Super can transiently reveal them).", updatedById: MICHAEL_ID },
    update: { description: "Master switch for the Business Start Date filter. Off = every money view shows full history. On = pre-cutoff money rows are hidden from every view and export (Super can transiently reveal them)." },
  });
  await prisma.setting.upsert({
    where: { key: "QB_INCLUDE_CONTRACT_LABOR" },
    create: { key: "QB_INCLUDE_CONTRACT_LABOR", value: "true", description: "When ON, qb-journal-expenses.csv emits Contract Labor rows for contractor payments (post-GP splits, GP wage-path work, and historical advances). When OFF, the entire Contract Labor section is dropped — appropriate once Gusto's QuickBooks integration is configured to post contractor payments to QB directly. Default ON.", updatedById: MICHAEL_ID },
    update: { description: "When ON, qb-journal-expenses.csv emits Contract Labor rows for contractor payments (post-GP splits, GP wage-path work, and historical advances). When OFF, the entire Contract Labor section is dropped — appropriate once Gusto's QuickBooks integration is configured to post contractor payments to QB directly. Default ON." },
  });
  await prisma.setting.upsert({
    where: { key: "EQUIPMENT_BILLING_ENABLED" },
    create: { key: "EQUIPMENT_BILLING_ENABLED", value: "false", description: "Master toggle for equipment billing. When ON, equipment checkouts charge contractors per the equipment's daily rate (employees + trainees always pay $0). When OFF, every checkout release records rentalCost = 0 regardless of equipment dailyRate or worker type — equipment chips still render but show $0. Use this when absorbing equipment cost into a higher CONTRACTOR_PLATFORM_FEE_PERCENT. Pending CPA review of the billing model.", updatedById: MICHAEL_ID },
    update: { description: "Master toggle for equipment billing. When ON, equipment checkouts charge contractors per the equipment's daily rate (employees + trainees always pay $0). When OFF, every checkout release records rentalCost = 0 regardless of equipment dailyRate or worker type — equipment chips still render but show $0. Use this when absorbing equipment cost into a higher CONTRACTOR_PLATFORM_FEE_PERCENT. Pending CPA review of the billing model." },
  });
  // Stale REQUEST_PAYMENT_FROM_CLIENT_ENABLED setting is best-effort
  // cleaned up so it doesn't linger in the Settings tab after the gate was
  // removed. deleteMany is safe — never throws if the row's already gone.
  await prisma.setting.deleteMany({
    where: { key: "REQUEST_PAYMENT_FROM_CLIENT_ENABLED" },
  });
  const paymentMethodsDefault = JSON.stringify([
    { key: "VENMO", label: "Venmo", feePercent: 1.9, feeFixed: 0.10, supportsClientRequest: true, supportsOnSite: true, deepLinkTemplate: "venmo://paycharge?txn=pay&recipients={VENMO_BUSINESS_HANDLE}&amount={{amount}}&note={{note}}", instructions: "Send {{amount}} to @{VENMO_BUSINESS_HANDLE} on Venmo", active: true },
    { key: "ZELLE", label: "Zelle", feePercent: 0, feeFixed: 0, supportsClientRequest: true, supportsOnSite: true, deepLinkTemplate: null, instructions: "Send {{amount}} to {ZELLE_ADDRESS} via Zelle in your bank app", active: true, preferred: true },
    { key: "CASH", label: "Cash", feePercent: 0, feeFixed: 0, supportsClientRequest: false, supportsOnSite: true, deepLinkTemplate: null, instructions: null, active: true },
    { key: "CHECK", label: "Check", feePercent: 0, feeFixed: 0, supportsClientRequest: true, supportsOnSite: true, deepLinkTemplate: null, instructions: "Make check payable to Seedlings Lawn Care LLC", active: true },
  ]);
  await prisma.setting.upsert({
    where: { key: "PAYMENT_METHODS" },
    create: { key: "PAYMENT_METHODS", value: paymentMethodsDefault, description: "Configurable taxonomy of accepted payment methods. Each entry controls fee, where it's shown, deep link, and client instructions. Adding a method here changes the UI without code changes.", updatedById: MICHAEL_ID },
    update: { description: "Configurable taxonomy of accepted payment methods. Each entry controls fee, where it's shown, deep link, and client instructions. Adding a method here changes the UI without code changes." },
  });
  // Equipment-rental income routing for the QB Income export — see
  // memory/project_equipment_rental_income.md. Seeded here so the
  // payments-clean / payments-active templates carry the row through to
  // dev; production needs the same row inserted via the Settings UI or
  // a one-time upsert (see the response to the operator).
  const equipmentRentalIncomeDefault = JSON.stringify({
    qbAccount: "Equipment Rental Income",
    scheduleCLine: "1",
  });
  await prisma.setting.upsert({
    where: { key: "EQUIPMENT_RENTAL_INCOME_CONFIG" },
    create: { key: "EQUIPMENT_RENTAL_INCOME_CONFIG", value: equipmentRentalIncomeDefault, description: "Routing for equipment rental income in the QB Income export. `qbAccount` must match the QB chart-of-accounts entry exactly (capitalization + spacing). `scheduleCLine` is the Schedule C tax line — default '1' (Gross receipts, alongside service revenue); change to '6' (Other gross receipts) if your CPA prefers separate visibility.", updatedById: MICHAEL_ID },
    update: { description: "Routing for equipment rental income in the QB Income export. `qbAccount` must match the QB chart-of-accounts entry exactly (capitalization + spacing). `scheduleCLine` is the Schedule C tax line — default '1' (Gross receipts, alongside service revenue); change to '6' (Other gross receipts) if your CPA prefers separate visibility." },
  });
  console.log("    Clients + contacts...");
  const adams = await prisma.client.create({ data: { type: "PERSON", displayName: "Adams (normal)" } });
  const banks = await prisma.client.create({ data: { type: "PERSON", displayName: "Banks (overpay)" } });
  const cohen = await prisma.client.create({ data: { type: "PERSON", displayName: "Cohen (underpay-mixed)" } });
  const davis = await prisma.client.create({ data: { type: "PERSON", displayName: "Davis (underpay-employees)" } });
  const evans = await prisma.client.create({ data: { type: "PERSON", displayName: "Evans (write-off)" } });

  const adamsContact = await prisma.clientContact.create({
    data: { clientId: adams.id, firstName: "Alice", lastName: "Adams", role: "OWNER", isPrimary: true, email: "alice@example.com", phone: "(555) 111-0001", normalizedPhone: "+15551110001" },
  });
  const banksContact = await prisma.clientContact.create({
    data: { clientId: banks.id, firstName: "Ben", lastName: "Banks", role: "OWNER", isPrimary: true, email: "ben@example.com", phone: "(555) 222-0001", normalizedPhone: "+15552220001" },
  });
  const cohenContact = await prisma.clientContact.create({
    data: { clientId: cohen.id, firstName: "Cara", lastName: "Cohen", role: "OWNER", isPrimary: true, email: "cara@example.com", phone: "(555) 333-0001", normalizedPhone: "+15553330001" },
  });
  const davisContact = await prisma.clientContact.create({
    data: { clientId: davis.id, firstName: "Dan", lastName: "Davis", role: "OWNER", isPrimary: true, email: "dan@example.com", phone: "(555) 444-0001", normalizedPhone: "+15554440001" },
  });
  const evansContact = await prisma.clientContact.create({
    data: { clientId: evans.id, firstName: "Erin", lastName: "Evans", role: "OWNER", isPrimary: true, email: "erin@example.com", phone: "(555) 555-0001", normalizedPhone: "+15555550001" },
  });

  console.log("    Properties...");
  const adamsProp = await prisma.property.create({
    data: { clientId: adams.id, displayName: "Home", street1: "100 Adams Lane", city: "Test City", state: "TX", postalCode: "00001", country: "US", kind: "SINGLE", pointOfContactId: adamsContact.id },
  });
  const banksProp = await prisma.property.create({
    data: { clientId: banks.id, displayName: "Home", street1: "200 Banks Way", city: "Test City", state: "TX", postalCode: "00002", country: "US", kind: "SINGLE", pointOfContactId: banksContact.id },
  });
  const cohenProp = await prisma.property.create({
    data: { clientId: cohen.id, displayName: "Home", street1: "300 Cohen Rd", city: "Test City", state: "TX", postalCode: "00003", country: "US", kind: "SINGLE", pointOfContactId: cohenContact.id },
  });
  const davisProp = await prisma.property.create({
    data: { clientId: davis.id, displayName: "Home", street1: "400 Davis Blvd", city: "Test City", state: "TX", postalCode: "00004", country: "US", kind: "SINGLE", pointOfContactId: davisContact.id },
  });
  const evansProp = await prisma.property.create({
    data: { clientId: evans.id, displayName: "Home", street1: "500 Evans St", city: "Test City", state: "TX", postalCode: "00005", country: "US", kind: "SINGLE", pointOfContactId: evansContact.id },
  });

  console.log("    Jobs...");
  const adamsJob = await prisma.job.create({
    data: { propertyId: adamsProp.id, kind: "SINGLE_ADDRESS", status: "ACCEPTED", frequencyDays: 7, defaultPrice: 100.0, estimatedMinutes: 45, notes: "$100 mow — normal payment scenario" },
  });
  const banksJob = await prisma.job.create({
    data: { propertyId: banksProp.id, kind: "SINGLE_ADDRESS", status: "ACCEPTED", frequencyDays: 7, defaultPrice: 100.0, estimatedMinutes: 45, notes: "$100 mow — overpayment scenario" },
  });
  const cohenJob = await prisma.job.create({
    data: { propertyId: cohenProp.id, kind: "SINGLE_ADDRESS", status: "ACCEPTED", frequencyDays: 7, defaultPrice: 100.0, estimatedMinutes: 45, notes: "$100 mow — underpayment (mixed crew) scenario" },
  });
  const davisJob = await prisma.job.create({
    data: { propertyId: davisProp.id, kind: "SINGLE_ADDRESS", status: "ACCEPTED", frequencyDays: 7, defaultPrice: 100.0, estimatedMinutes: 45, notes: "$100 mow — underpayment (all-employee) scenario" },
  });
  const evansJob = await prisma.job.create({
    data: { propertyId: evansProp.id, kind: "SINGLE_ADDRESS", status: "ACCEPTED", frequencyDays: 7, defaultPrice: 100.0, estimatedMinutes: 45, notes: "$100 mow — write-off scenario" },
  });

  for (const job of [adamsJob, banksJob, cohenJob, davisJob, evansJob]) {
    await prisma.jobClient.create({
      data: {
        jobId: job.id,
        clientId: (await prisma.property.findUniqueOrThrow({ where: { id: job.propertyId } })).clientId,
        role: "owner",
      },
    });
  }

  // Default assignees — same set used by both templates so workers see a
  // consistent crew on each job's card.
  await prisma.jobAssigneeDefault.create({ data: { jobId: adamsJob.id, userId: CONTRACTOR_ID, role: "primary" } });
  await prisma.jobAssigneeDefault.create({ data: { jobId: banksJob.id, userId: CONTRACTOR_ID, role: "primary" } });
  await prisma.jobAssigneeDefault.create({ data: { jobId: cohenJob.id, userId: CONTRACTOR_ID, role: "primary" } });
  await prisma.jobAssigneeDefault.create({ data: { jobId: davisJob.id, userId: EMPLOYEE_ID, role: "primary" } });
  await prisma.jobAssigneeDefault.create({ data: { jobId: evansJob.id, userId: CONTRACTOR_ID, role: "primary" } });

  // ─── Context: scheduled jobs spread across today + next 2 weeks ──────────
  // FIVE jobs SCHEDULED for today, all assigned to CONTRACTOR_ID — gives a
  // ready-made path for testing the contractor Initiate-Payment flow on
  // five separate occurrences (e.g. normal, overpay, underpay, severe
  // underpay, write-off) without setting them up by hand. The remaining
  // context jobs span the next 2 weeks with a mix of workers so the
  // JobsTab / month view doesn't look empty.
  console.log("    Scheduled context jobs (5 today for Contractor + next 2 weeks)...");
  const contextSchedule: Array<{ jobId: string; daysOut: number; hour: number; assigneeUserId: string; price?: number }> = [
    { jobId: adamsJob.id, daysOut: 0, hour: 8,  assigneeUserId: CONTRACTOR_ID },
    { jobId: banksJob.id, daysOut: 0, hour: 10, assigneeUserId: CONTRACTOR_ID },
    { jobId: cohenJob.id, daysOut: 0, hour: 12, assigneeUserId: CONTRACTOR_ID },
    { jobId: davisJob.id, daysOut: 0, hour: 14, assigneeUserId: CONTRACTOR_ID },
    { jobId: evansJob.id, daysOut: 0, hour: 16, assigneeUserId: CONTRACTOR_ID },
    { jobId: adamsJob.id, daysOut: 2, hour: 10, assigneeUserId: EMPLOYEE_ID },
    { jobId: banksJob.id, daysOut: 3, hour: 8,  assigneeUserId: ADMIN_WORKER_ID },
    { jobId: cohenJob.id, daysOut: 4, hour: 13, assigneeUserId: EMPLOYEE_ID },
    { jobId: davisJob.id, daysOut: 5, hour: 9,  assigneeUserId: CONTRACTOR_ID },
    { jobId: evansJob.id, daysOut: 8, hour: 9,  assigneeUserId: CONTRACTOR_ID },
    { jobId: adamsJob.id, daysOut: 9, hour: 10, assigneeUserId: EMPLOYEE_ID },
    { jobId: banksJob.id, daysOut: 11, hour: 8, assigneeUserId: ADMIN_WORKER_ID },
    { jobId: cohenJob.id, daysOut: 12, hour: 13, assigneeUserId: EMPLOYEE_ID },
    { jobId: davisJob.id, daysOut: 14, hour: 9, assigneeUserId: CONTRACTOR_ID },
  ];
  for (let i = 0; i < contextSchedule.length; i++) {
    const c = contextSchedule[i];
    const occ = await prisma.jobOccurrence.create({
      data: {
        jobId: c.jobId,
        kind: "SINGLE_ADDRESS",
        startAt: daysFromNow(c.daysOut, c.hour),
        endAt: daysFromNow(c.daysOut, c.hour + 1),
        status: "SCHEDULED",
        workflow: "STANDARD",
        jobTags: '["MOW"]',
        price: c.price ?? 100.0,
        estimatedMinutes: 45,
        isClientConfirmed: true,
      },
    });
    await prisma.jobOccurrenceAssignee.create({
      data: {
        occurrenceId: occ.id,
        userId: c.assigneeUserId,
        role: "primary",
        assignedById: c.assigneeUserId,
      },
    });
  }

  // ─── Mixed-crew scenarios scheduled for today ────────────────────────────
  // Two occurrences with both an EMPLOYEE and a CONTRACTOR on the same job
  // so the mixed-class payment math can be tested end-to-end. Each one
  // alternates which worker type is the claimer:
  //   • 6 PM Cohen: EMPLOYEE claims, CONTRACTOR helps
  //   • 7 PM Davis: CONTRACTOR claims, EMPLOYEE helps
  //
  // assignedById = the claimer's own userId on the claimer's row, and =
  // the claimer's userId on the helper's row (the system convention).
  console.log("    Mixed-crew scenarios (today, 2 jobs)...");
  const mixedScenarios = [
    { jobId: cohenJob.id, hour: 18, claimerUserId: EMPLOYEE_ID, helperUserId: CONTRACTOR_ID, note: "Employee claims, contractor helps" },
    { jobId: davisJob.id, hour: 19, claimerUserId: CONTRACTOR_ID, helperUserId: EMPLOYEE_ID, note: "Contractor claims, employee helps" },
  ];
  for (const m of mixedScenarios) {
    const occ = await prisma.jobOccurrence.create({
      data: {
        jobId: m.jobId,
        kind: "SINGLE_ADDRESS",
        startAt: daysFromNow(0, m.hour),
        endAt: daysFromNow(0, m.hour + 1),
        status: "SCHEDULED",
        workflow: "STANDARD",
        jobTags: '["MOW"]',
        price: 100.0,
        estimatedMinutes: 45,
        isClientConfirmed: true,
        notes: m.note,
      },
    });
    // Claimer (primary role, assignedById = self).
    await prisma.jobOccurrenceAssignee.create({
      data: {
        occurrenceId: occ.id,
        userId: m.claimerUserId,
        role: "primary",
        assignedById: m.claimerUserId,
      },
    });
    // Helper (role null = standard worker, NOT observer so they earn a
    // share; assignedById = the claimer).
    await prisma.jobOccurrenceAssignee.create({
      data: {
        occurrenceId: occ.id,
        userId: m.helperUserId,
        role: null,
        assignedById: m.claimerUserId,
      },
    });
  }

  // Minimal supplies catalog so the "From inventory" picker has stock to
  // pull from when testing the on-job expense flow under payments-clean /
  // payments-active. Mirrors the default seed shape (Supply + paired
  // BusinessExpense + SupplyPurchase + onHand increment).
  console.log("    Supplies (minimal catalog)...");
  const paymentsSupplyCatalog: Array<{
    name: string; unit: string; category: string;
    businessCost: number; jobPayoutCost: number;
    description?: string; quantity: number;
  }> = [
    { name: "Mulch — hardwood",        unit: "bag",   category: "Supplies",                businessCost: 4.00,  jobPayoutCost: 5.00,  description: "2 cu ft bagged hardwood mulch.", quantity: 30 },
    { name: "Trimmer line 0.095",      unit: "spool", category: "Supplies",                businessCost: 18.00, jobPayoutCost: 18.00, description: "3 lb spool, 0.095\" gauge.",       quantity: 8 },
    { name: "Heavy-duty trash bags",   unit: "bag",   category: "Supplies",                businessCost: 0.60,  jobPayoutCost: 0.75,  description: "55-gal contractor bags, 3 mil.", quantity: 50 },
    { name: "Premixed 2-cycle fuel",   unit: "can",   category: "Fuel",                    businessCost: 24.00, jobPayoutCost: 24.00, description: "TruFuel 50:1 quart cans.",        quantity: 12 },
  ];
  for (const s of paymentsSupplyCatalog) {
    const totalCost = Math.round(s.quantity * s.businessCost * 100) / 100;
    const created = await prisma.supply.create({
      data: {
        createdById: ADMIN_WORKER_ID,
        name: s.name,
        unit: s.unit,
        category: s.category,
        businessCost: s.businessCost,
        jobPayoutCost: s.jobPayoutCost,
        description: s.description ?? null,
        onHand: 0,
      },
    });
    const be = await prisma.businessExpense.create({
      data: {
        createdById: ADMIN_WORKER_ID,
        date: daysAgo(7, 10),
        cost: totalCost,
        description: `${s.name} × ${s.quantity} ${s.unit}`,
        category: s.category,
        vendor: "Pro Lawn Supply",
      },
    });
    await prisma.supplyPurchase.create({
      data: {
        supplyId: created.id,
        quantity: s.quantity,
        unitCost: s.businessCost,
        totalCost,
        date: daysAgo(7, 10),
        vendor: "Pro Lawn Supply",
        businessExpenseId: be.id,
        createdById: ADMIN_WORKER_ID,
      },
    });
    await prisma.supply.update({
      where: { id: created.id },
      data: { onHand: { increment: s.quantity } },
    });
  }

  // ── Equipment + contractor rentals ─────────────────────────────────────
  // Without this block, the Payments tab's "Equipment Charges" section
  // is empty for the payments-active template because clearDatabase()
  // wipes equipment and seedPaymentsBase doesn't recreate it. Only
  // contractors are charged for equipment (see computeRentalCost in
  // services/equipment.ts — non-contractor checkouts return null cost),
  // so the seeded charges target CONTRACTOR_ID specifically.
  console.log("    Equipment + contractor rentals for the Payments tab...");
  const seedMower = await prisma.equipment.create({
    data: {
      type: "MOWER",
      brand: "Honda",
      model: "HRX217VLA",
      shortDesc: "21\" self-propelled mower",
      status: "AVAILABLE",
      dailyRate: 4.0,
    },
  });
  const seedTrimmer = await prisma.equipment.create({
    data: {
      type: "TRIMMER",
      brand: "Stihl",
      model: "FS 91 R",
      shortDesc: "Pro string trimmer",
      status: "AVAILABLE",
      dailyRate: 2.0,
    },
  });
  const seedBlower = await prisma.equipment.create({
    data: {
      type: "BLOWER",
      brand: "Echo",
      model: "PB-580T",
      shortDesc: "Backpack blower",
      status: "AVAILABLE",
      dailyRate: 2.0,
    },
  });
  const seedChainsaw = await prisma.equipment.create({
    data: {
      type: "CUTTER",
      brand: "Stihl",
      model: "MS 271",
      shortDesc: "20\" chainsaw",
      status: "AVAILABLE",
      dailyRate: 5.0,
    },
  });
  const seedAerator = await prisma.equipment.create({
    data: {
      type: "AERATOR",
      brand: "Bluebird",
      model: "PR22",
      shortDesc: "Walk-behind aerator",
      status: "AVAILABLE",
      dailyRate: 12.0,
    },
  });
  // 5 released contractor rentals spread across the last ~3 weeks. Each
  // has rentalCost set so they appear on the Payments tab's Equipment
  // Charges section.
  const rentals = [
    { equipmentId: seedMower.id,    daysAgoStart: 22, daysAgoEnd: 20, rentalDays: 2, rentalCost: 8.0  },
    { equipmentId: seedTrimmer.id,  daysAgoStart: 16, daysAgoEnd: 16, rentalDays: 1, rentalCost: 2.0  },
    { equipmentId: seedBlower.id,   daysAgoStart: 12, daysAgoEnd: 10, rentalDays: 2, rentalCost: 4.0  },
    { equipmentId: seedChainsaw.id, daysAgoStart: 7,  daysAgoEnd: 5,  rentalDays: 3, rentalCost: 15.0 },
    { equipmentId: seedAerator.id,  daysAgoStart: 3,  daysAgoEnd: 1,  rentalDays: 2, rentalCost: 24.0 },
  ];
  for (const r of rentals) {
    await prisma.checkout.create({
      data: {
        equipmentId: r.equipmentId,
        userId: CONTRACTOR_ID,
        reservedAt: daysAgo(r.daysAgoStart + 1, 7),
        checkedOutAt: daysAgo(r.daysAgoStart, 8),
        releasedAt: daysAgo(r.daysAgoEnd, 17),
        rentalDays: r.rentalDays,
        rentalCost: r.rentalCost,
      },
    });
  }

  await applySettingSections();

  return { adamsJob, banksJob, cohenJob, davisJob, evansJob };
}

// Clean variant — no pending payments, no payment history. Drops you at
// a state that looks like the company is set up but hasn't yet collected
// any payments. Workers can complete one of the TODAY SCHEDULED jobs (set
// up in base) and walk the full Initiate Payment → approval flow from
// scratch.
async function seedPaymentsClean() {
  console.log("  Creating CLEAN payment-flow dataset (no pending payments)...");
  await seedPaymentsBase();
  console.log("  Clean payments seed complete!");
  console.log("");
  console.log("  No pending approvals, no payment history. JobsTab has 16");
  console.log("  SCHEDULED occurrences:");
  console.log("    • 5 today, all assigned to CONTRACTOR_ID (Adams 8am, Banks 10am,");
  console.log("      Cohen 12pm, Davis 2pm, Evans 4pm) — single-worker contractor");
  console.log("      scenarios.");
  console.log("    • 2 mixed-crew today (Cohen 6pm: employee claims + contractor helps;");
  console.log("      Davis 7pm: contractor claims + employee helps) — for testing the");
  console.log("      mixed-class payment math.");
  console.log("    • 9 across the next 14 days with mixed workers for context.");
}

// Active variant — clean base + 5 PENDING_PAYMENT scenarios already
// queued in Pending Approvals. Use for testing the admin approval /
// adjust / reject / write-off paths and the per-worker reconciliation math.
async function seedPaymentsActive() {
  console.log("  Creating ACTIVE payment-flow dataset (5 pending approvals)...");
  const { adamsJob, banksJob, cohenJob, davisJob, evansJob } = await seedPaymentsBase();

  // Helper to create a PENDING_PAYMENT occurrence + self-reported Payment.
  async function makeOcc(
    jobId: string,
    completionSplits: { userId: string; percent: number }[],
    extras: { paymentRequestToken: string; selfReportedAmount: number; note?: string },
  ) {
    const price = 100.0;
    const promisedPayouts = await computePromisedPayoutsForSeed(price, 0, completionSplits);
    const occ = await prisma.jobOccurrence.create({
      data: {
        jobId,
        kind: "SINGLE_ADDRESS",
        startAt: daysFromNow(0, 8),
        endAt: daysFromNow(0, 9),
        status: "PENDING_PAYMENT",
        workflow: "STANDARD",
        jobTags: '["MOW"]',
        price,
        estimatedMinutes: 45,
        startedAt: daysFromNow(0, 8),
        completedAt: daysFromNow(0, 9),
        isClientConfirmed: true,
        paymentRequestToken: extras.paymentRequestToken,
        paymentRequestTokenCreatedAt: daysFromNow(0, 9),
        completionSplits: completionSplits as any,
        promisedPayouts: promisedPayouts as any,
      },
    });
    const claimerId = completionSplits[0].userId;
    for (let i = 0; i < completionSplits.length; i++) {
      await prisma.jobOccurrenceAssignee.create({
        data: {
          occurrenceId: occ.id,
          userId: completionSplits[i].userId,
          role: i === 0 ? "primary" : "helper",
          assignedById: i === 0 ? completionSplits[i].userId : claimerId,
        },
      });
    }
    await prisma.payment.create({
      data: {
        occurrenceId: occ.id,
        amountPaid: extras.selfReportedAmount,
        method: "ZELLE",
        note: extras.note ?? null,
        confirmed: false,
        selfReported: true,
        collectedById: null,
        createdAt: daysAgo(0, 10),
      },
    });
    return occ;
  }

  console.log("    Pending-approval scenarios...");

  // 1. NORMAL — client paid exactly the invoice. → Approve
  await makeOcc(
    adamsJob.id,
    [{ userId: CONTRACTOR_ID, percent: 40 }, { userId: EMPLOYEE_ID, percent: 60 }],
    { paymentRequestToken: "seed-pay-normal", selfReportedAmount: 100.0, note: "Paid in full via Zelle" },
  );

  // 2. OVERPAY — client paid more than invoice. → Approve
  await makeOcc(
    banksJob.id,
    [{ userId: CONTRACTOR_ID, percent: 40 }, { userId: EMPLOYEE_ID, percent: 60 }],
    { paymentRequestToken: "seed-pay-overpay", selfReportedAmount: 120.0, note: "Client added a tip" },
  );

  // 3. UNDERPAY (mixed crew) — client paid less. → Approve (or Adjust)
  await makeOcc(
    cohenJob.id,
    [{ userId: CONTRACTOR_ID, percent: 40 }, { userId: EMPLOYEE_ID, percent: 60 }],
    { paymentRequestToken: "seed-pay-underpay-mixed", selfReportedAmount: 80.0, note: "Client says check was short" },
  );

  // 4. UNDERPAY (all employees) — partial payment.
  await makeOcc(
    davisJob.id,
    [{ userId: EMPLOYEE_ID, percent: 50 }, { userId: TRAINEE_ID, percent: 50 }],
    { paymentRequestToken: "seed-pay-underpay-employees", selfReportedAmount: 40.0, note: "Partial payment only" },
  );

  // 5. WRITE-OFF — client never paid. → Write off
  await makeOcc(
    evansJob.id,
    [{ userId: CONTRACTOR_ID, percent: 40 }, { userId: EMPLOYEE_ID, percent: 60 }],
    { paymentRequestToken: "seed-pay-writeoff", selfReportedAmount: 0.0, note: "Client refused to pay — write off" },
  );

  // ── Business Start Date — backdated test fixtures ────────────────────────
  // Seeds pre-cutoff AND post-cutoff data across every filtered table so the
  // operator can flip the BUSINESS_START_DATE_ENABLED toggle and watch the
  // dashboards transition without data destruction. See
  // apps/api/src/lib/businessStartCutoff.ts.
  //
  // Cutoff in the seeded setting is 2026-06-01. We synthesize rows BOTH
  // before (~2026-04 / 2026-05) and after (~2026-06) so each surface has
  // observable filter behavior:
  //   • Payment (confirmed, written-off, pending) on each side
  //   • PaymentSplit — derived from Payment timing
  //   • BusinessExpense — EXPENSE + OWNER_DRAW + CAPITAL_CONTRIBUTION
  //   • Checkout — one released pre-cutoff, one released post-cutoff
  //   • AuditEvent — a few hand-stamped pre-cutoff events
  //   • SupplyPurchase pairs with one pre-cutoff BE.
  await seedBusinessStartCutoffFixtures();

  console.log("  Active payments seed complete!");
  console.log("");
  console.log("  5 scenarios are PENDING admin approval. Walk them through");
  console.log("  the Payments tab → Pending Approvals queue:");
  console.log("");
  console.log("    1. Adams  ($100/$100, contractor+employee 40/60)  → Approve");
  console.log("       Expected: contractor=$36, employee=$48, fee=$4, margin=$12, no shortfall");
  console.log("");
  console.log("    2. Banks  ($120/$100, contractor+employee 40/60)  → Approve");
  console.log("       Expected: contractor=$36, employee=$48, overage=$20");
  console.log("");
  console.log("    3. Cohen  ($80/$100, contractor+employee 40/60)   → Approve");
  console.log("       Expected: contractor=$28.80, employee=$48 (top-up $9.60), shortfall=$12.80");
  console.log("");
  console.log("    4. Davis  ($40/$100, employee+trainee 50/50)      → Approve");
  console.log("       Expected: both workers $40 (made whole), shortfall=$60");
  console.log("");
  console.log("    5. Evans  ($0/$100, contractor+employee 40/60)    → Write off");
  console.log("       Expected: contractor=$0, employee=$48, shortfall=$64, writtenOff=true");
}

// ─────────────────────────────────────────────────────────────────────────────
// Business Start Date — backdated fixtures.
//
// Adds rows on BOTH sides of the seeded BUSINESS_START_DATE so the operator
// can flip the toggle and watch dashboards transition. Idempotent within a
// single seed run (we always clear the DB first); pre-cutoff rows use
// explicit `createdAt` / `date` / `releasedAt` so Prisma writes the dates
// directly. See apps/api/src/lib/businessStartCutoff.ts.
//
// SAFETY: this function intentionally inserts FIXTURE data only. Real
// production data is never touched by the cutoff feature — the filter is a
// read-time WHERE-clause, not a destructive operation. If you find yourself
// tempted to use this pattern outside seeds, stop and re-read the helper.
// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// Guaranteed Payout (Slice 2) fixtures
//
// Wires CONTRACTOR_ID into an active GP period and produces three
// occurrences spanning the three states Slice 2 has to handle:
//
//   1. UNADVANCED + UNPAID  → work-anchored part of the next contractor
//      payroll export will INCLUDE this; advance row will be CREATED at
//      export time. After downloading the CSV the operator should see
//      Carla on the Gusto Contractors output and a GuaranteedPayoutAdvance
//      row materializes in the DB.
//
//   2. ALREADY-ADVANCED + UNPAID → simulates "operator ran a prior export
//      and advanced this job last week." The GuaranteedPayoutAdvance row
//      pre-exists; the work-anchored part should SKIP it (idempotency
//      check). Carla should still see this advance in her money tab
//      (bucketed at exportedAt).
//
//   3. ALREADY-ADVANCED + CLIENT-PAID → simulates "client eventually paid
//      after we advanced." Both a GuaranteedPayoutAdvance row AND a
//      confirmed Payment with reconciled PaymentSplit exist. The
//      PaymentSplit carries `guaranteedPayoutPaidAt` so the payment-
//      anchored part SKIPS it (otherwise we'd double-pay). The QB
//      Expenses CSV emits one Contract Labor row per advance, NOT per
//      flagged split — verifies the reconciliation flag works end to end.
// ─────────────────────────────────────────────────────────────────────────────
async function seedPaymentsGuaranteedPayout() {
  console.log("  Creating GUARANTEED PAYOUT validation dataset...");
  const { adamsJob, banksJob, cohenJob } = await seedPaymentsBase();

  // Put CONTRACTOR_ID on an active guaranteed-payout period (60 days out).
  // Also stamp a `startedAt` ~ 2 weeks ago so any occurrence completed in
  // the recent past falls inside the active period boundaries.
  const gpStartedAt = daysAgo(14);
  const gpUntil = daysFromNow(60, 23); // ~end-of-day-ish today+60
  await prisma.user.update({
    where: { id: CONTRACTOR_ID },
    data: {
      guaranteedPayoutStartedAt: gpStartedAt,
      guaranteedPayoutUntil: gpUntil,
      guaranteedPayoutHistory: [] as any,
    },
  });
  console.log(`    CONTRACTOR_ID on active GP through ${etFormatDate(gpUntil)}`);

  // Helper that creates a PENDING_PAYMENT occurrence with Carla as sole
  // active assignee. Returns the occurrence + the per-worker promised
  // payouts snapshot.
  async function makeGpOcc(jobId: string, completedDaysAgo: number, opts: { skipSplits?: boolean } = {}) {
    const price = 80.0;
    const completionSplits = [{ userId: CONTRACTOR_ID, percent: 100 }];
    const promised = opts.skipSplits
      ? null
      : await computePromisedPayoutsForSeed(price, 0, completionSplits);
    const occ = await prisma.jobOccurrence.create({
      data: {
        jobId,
        kind: "SINGLE_ADDRESS",
        startAt: daysAgo(completedDaysAgo, 8),
        endAt: daysAgo(completedDaysAgo, 9),
        status: "PENDING_PAYMENT",
        workflow: "STANDARD",
        jobTags: '["MOW"]',
        price,
        estimatedMinutes: 45,
        startedAt: daysAgo(completedDaysAgo, 8),
        completedAt: daysAgo(completedDaysAgo, 9),
        isClientConfirmed: true,
        completionSplits: opts.skipSplits ? undefined : (completionSplits as any),
        promisedPayouts: opts.skipSplits ? undefined : (promised as any),
        hoursApprovedAt: daysAgo(completedDaysAgo, 10), // pre-approved so it's eligible
      },
    });
    await prisma.jobOccurrenceAssignee.create({
      data: {
        occurrenceId: occ.id,
        userId: CONTRACTOR_ID,
        role: "primary",
        assignedById: CONTRACTOR_ID,
      },
    });
    return { occ, promisedNet: opts.skipSplits ? 0 : (promised?.[0]?.net ?? 0) };
  }

  console.log("    Scenario 1: unadvanced + unpaid (next export will create the advance)");
  await makeGpOcc(adamsJob.id, 3);

  console.log("    Scenario 2: already-advanced + unpaid (prior export, advance row pre-exists)");
  const { occ: occ2, promisedNet: net2 } = await makeGpOcc(banksJob.id, 7);
  await prisma.guaranteedPayoutAdvance.create({
    data: {
      userId: CONTRACTOR_ID,
      occurrenceId: occ2.id,
      amount: net2,
      exportedAt: daysAgo(6), // simulates "operator ran payroll 6 days ago"
      exportedByUserId: MICHAEL_ID,
    },
  });

  console.log("    Scenario 3: already-advanced + client-paid (flagged split shows in PaymentsTab)");
  const { occ: occ3, promisedNet: net3 } = await makeGpOcc(cohenJob.id, 10);
  await prisma.guaranteedPayoutAdvance.create({
    data: {
      userId: CONTRACTOR_ID,
      occurrenceId: occ3.id,
      amount: net3,
      exportedAt: daysAgo(9),
      exportedByUserId: MICHAEL_ID,
    },
  });
  const payment3 = await prisma.payment.create({
    data: {
      occurrenceId: occ3.id,
      amountPaid: 80.0,
      method: "ZELLE",
      collectedById: MICHAEL_ID,
      confirmed: true,
      confirmedAt: daysAgo(2),
      confirmedById: MICHAEL_ID,
      createdAt: daysAgo(2),
      grossCharged: 80.0,
      netReceived: 80.0,
    },
  });
  await prisma.paymentSplit.create({
    data: {
      paymentId: payment3.id,
      userId: CONTRACTOR_ID,
      amount: net3,
      grossAmount: 80.0,
      ratePercent: 20,
      feeAmount: 16.0,
      netAmount: net3,
      // Reconciliation flag — Slice 2 split-creation hooks set this when
      // an advance exists for (userId, occurrenceId). The seed pre-flags
      // it so the PaymentsTab badge + export exclusions can be validated
      // without re-running the actual confirmation flow.
      guaranteedPayoutPaidAt: daysAgo(9),
    },
  });

  console.log("  Done. Try: Super → Money → Exports → Gusto Contractors CSV.");
  console.log("    Expected: 2 jobs for Carla (scenarios 1 + 2 visible).");
  console.log("    Scenario 1 will create a new advance row on download.");
  console.log("    Scenario 3 should NOT appear (flagged split + existing advance).");
}

async function seedBusinessStartCutoffFixtures() {
  console.log("    Business Start Date backdated fixtures...");
  const round2 = (n: number) => Math.round(n * 100) / 100;

  // Anchor dates RELATIVE TO TODAY so the fixtures stay visible in common
  // date-range presets ("Last Month", "Last 30 Days", "This Month") instead
  // of drifting to wherever a hardcoded calendar date lands. The seeded
  // BUSINESS_START_DATE is 2026-06-01; we assume the operator runs the seed
  // around that time. If they don't, dates shift with NOW which is fine —
  // the filter logic still demonstrates correctly.
  //
  // PRE rows land in the previous ~6 weeks (split across "Last Month" and
  // "older" so both windows have data).
  // POST rows land at "today" — the post-cutoff side is intentionally small
  // since the cutoff IS today.
  const PRE = (daysBeforeToday: number): Date => daysAgo(daysBeforeToday, 13);
  const POST = (daysAfterToday: number): Date =>
    daysFromNow(daysAfterToday, 13);

  // ── BusinessExpense rows (EXPENSE, OWNER_DRAW, CAPITAL_CONTRIBUTION) ────
  // One of each on each side of the cutoff so the Accounting tab shows
  // visible filter behavior across all three EntryType buckets.
  console.log("      BusinessExpense: 3 pre-cutoff + 3 post-cutoff...");
  await prisma.businessExpense.create({
    data: {
      createdById: MICHAEL_ID,
      type: "EXPENSE",
      // ~2 weeks back — lands in "Last Month" or "Last 30 days" presets.
      date: PRE(15),
      cost: 87.43,
      description: "Pre-cutoff: lawn fertilizer (test fixture)",
      category: "Supplies",
      vendor: "Home Depot",
    },
  });
  await prisma.businessExpense.create({
    data: {
      createdById: MICHAEL_ID,
      type: "OWNER_DRAW",
      // ~3 weeks back.
      date: PRE(22),
      cost: 500.0,
      description: "Pre-cutoff: monthly owner draw (test fixture)",
    },
  });
  await prisma.businessExpense.create({
    data: {
      createdById: MICHAEL_ID,
      type: "CAPITAL_CONTRIBUTION",
      // ~6 weeks back — older history that some presets won't include.
      date: PRE(42),
      cost: 1500.0,
      description: "Pre-cutoff: initial capital contribution (test fixture)",
    },
  });
  await prisma.businessExpense.create({
    data: {
      createdById: MICHAEL_ID,
      type: "EXPENSE",
      date: POST(0),
      cost: 64.20,
      description: "Post-cutoff: gas refill (test fixture)",
      category: "Vehicle expenses",
      vendor: "Shell",
    },
  });
  await prisma.businessExpense.create({
    data: {
      createdById: MICHAEL_ID,
      type: "OWNER_DRAW",
      // Today + 1 day so the row is post-cutoff but still in "This Month".
      date: POST(1),
      cost: 600.0,
      description: "Post-cutoff: monthly owner draw (test fixture)",
    },
  });
  await prisma.businessExpense.create({
    data: {
      createdById: MICHAEL_ID,
      type: "CAPITAL_CONTRIBUTION",
      date: POST(2),
      cost: 250.0,
      description: "Post-cutoff: working-capital top-up (test fixture)",
    },
  });

  // ── Checkout rows (one released pre, one released post) ────────────────
  // Pick an existing equipment row from the base payments seed so the FK
  // resolves. Both rentals are SOLO (no group) so the charge view exercise
  // is simple.
  console.log("      Checkout: 1 released pre-cutoff + 1 released post-cutoff...");
  const someEquipment = await prisma.equipment.findFirst({
    where: { retiredAt: null },
    orderBy: { createdAt: "asc" },
  });
  if (someEquipment) {
    await prisma.checkout.create({
      data: {
        equipmentId: someEquipment.id,
        userId: CONTRACTOR_ID,
        // reserved → checkedOut → released, all pre-cutoff (~2 weeks back).
        reservedAt: PRE(17),
        checkedOutAt: PRE(16),
        releasedAt: PRE(15),
        rentalDays: 1,
        rentalCost: 4.0,
      },
    });
    await prisma.checkout.create({
      data: {
        equipmentId: someEquipment.id,
        userId: CONTRACTOR_ID,
        // reserved → checkedOut → released, all today — releasedAt is the
        // cutoff anchor so the charge lands on the post-cutoff side.
        reservedAt: daysAgo(0, 8),
        checkedOutAt: daysAgo(0, 9),
        releasedAt: daysAgo(0, 17),
        rentalDays: 1,
        rentalCost: 4.0,
      },
    });
  }

  // ── AuditEvent rows ────────────────────────────────────────────────────
  // Hand-stamped createdAt so they land on either side of the cutoff. These
  // are pure observability rows — no FK side-effects.
  console.log("      AuditEvent: 2 pre-cutoff + 2 post-cutoff...");
  await prisma.auditEvent.create({
    data: {
      scope: "SETTING",
      verb: "UPDATED",
      action: "seed.fixture.preCutoff",
      actorUserId: MICHAEL_ID,
      metadata: { note: "Pre-cutoff audit fixture A" },
      createdAt: PRE(15),
    },
  });
  await prisma.auditEvent.create({
    data: {
      scope: "SETTING",
      verb: "UPDATED",
      action: "seed.fixture.preCutoff",
      actorUserId: MICHAEL_ID,
      metadata: { note: "Pre-cutoff audit fixture B" },
      createdAt: PRE(35),
    },
  });
  await prisma.auditEvent.create({
    data: {
      scope: "SETTING",
      verb: "UPDATED",
      action: "seed.fixture.postCutoff",
      actorUserId: MICHAEL_ID,
      metadata: { note: "Post-cutoff audit fixture A" },
      createdAt: POST(0),
    },
  });
  await prisma.auditEvent.create({
    data: {
      scope: "SETTING",
      verb: "UPDATED",
      action: "seed.fixture.postCutoff",
      actorUserId: MICHAEL_ID,
      metadata: { note: "Post-cutoff audit fixture B" },
      createdAt: POST(1),
    },
  });

  // ── Payment + PaymentSplit pre-cutoff fixture ──────────────────────────
  // Synthesize a confirmed, non-pending Payment on a brand-new fixture
  // occurrence so flipping the cutoff toggles the row in/out of the
  // Payments tab + earnings tiles. We rely on an existing Job from the
  // payments-base seed to host the occurrence.
  console.log("      Payment: 1 confirmed pre-cutoff + 1 confirmed post-cutoff...");
  const someJob = await prisma.job.findFirst({
    where: { status: { not: "ARCHIVED" } },
    orderBy: { createdAt: "asc" },
    include: { property: true },
  });
  if (someJob) {
    // Mirror what the production approval flow writes: per-worker breakdown
    // columns on PaymentSplit (grossAmount / ratePercent / feeAmount /
    // netAmount), and Payment-level totals for platformFeeAmount +
    // businessMarginAmount. Without these the Admin Money summary aggregates
    // to 0 and the Commission/Margin rows hide themselves — making dev look
    // visually different from prod even though the data is "valid".
    //
    // Rates are the seeded defaults (Contractor 20%, Employee/Trainee 30%);
    // recompute here so a future tweak to those defaults still produces
    // consistent fixtures on reseed.
    const contractorFeePct = 20;
    const employeeMarginPct = 30;

    type SeedSplit = {
      userId: string;
      workerType: "EMPLOYEE" | "TRAINEE" | "CONTRACTOR";
      role: "primary" | "helper";
    };

    async function createConfirmedPayment(
      label: string,
      when: Date,
      splits: SeedSplit[],
      collectedAmount: number = 100.0,
    ) {
      const splitPercent = 100 / splits.length;
      const completionSplits = splits.map((s) => ({ userId: s.userId, percent: splitPercent }));
      const promisedPayouts = await computePromisedPayoutsForSeed(collectedAmount, 0, completionSplits);
      const occ = await prisma.jobOccurrence.create({
        data: {
          jobId: someJob.id,
          kind: "SINGLE_ADDRESS",
          startAt: when,
          endAt: addMinutes(when, 60),
          status: "CLOSED",
          workflow: "STANDARD",
          price: collectedAmount,
          estimatedMinutes: 60,
          startedAt: when,
          completedAt: when,
          isClientConfirmed: true,
          completionSplits: completionSplits as any,
          promisedPayouts: promisedPayouts as any,
        },
      });
      const primaryId = splits.find((s) => s.role === "primary")?.userId ?? splits[0].userId;
      for (const sp of splits) {
        await prisma.jobOccurrenceAssignee.create({
          data: {
            occurrenceId: occ.id,
            userId: sp.userId,
            role: sp.role,
            assignedById: sp.role === "primary" ? sp.userId : primaryId,
          },
        });
      }
      // Compute per-worker breakdown the same shape the approval flow
      // produces. Each worker takes their splitPercent share of the gross,
      // then their own rate is applied to that share (per-worker fee model
      // documented in memory/project_payment_math.md).
      const grossPer = (collectedAmount * splitPercent) / 100;
      const computed = splits.map((sp) => {
        const isEmployeeClass = sp.workerType === "EMPLOYEE" || sp.workerType === "TRAINEE";
        const ratePercent = isEmployeeClass ? employeeMarginPct : contractorFeePct;
        const feeAmount = round2((grossPer * ratePercent) / 100);
        const netAmount = round2(grossPer - feeAmount);
        return {
          ...sp,
          grossAmount: round2(grossPer),
          ratePercent,
          feeAmount,
          netAmount,
          amount: netAmount, // no top-up in the happy-path fixtures
        };
      });
      const totalContractorFee = computed
        .filter((c) => c.workerType === "CONTRACTOR")
        .reduce((s, c) => s + c.feeAmount, 0);
      const totalEmployeeMargin = computed
        .filter((c) => c.workerType === "EMPLOYEE" || c.workerType === "TRAINEE")
        .reduce((s, c) => s + c.feeAmount, 0);
      const payment = await prisma.payment.create({
        data: {
          occurrenceId: occ.id,
          amountPaid: collectedAmount,
          method: "ZELLE",
          note: `${label} confirmed payment (test fixture)`,
          confirmed: true,
          confirmedAt: when,
          confirmedById: MICHAEL_ID,
          collectedById: MICHAEL_ID,
          createdAt: when,
          // Snapshot the rates that were in effect at "approval" time so
          // a later rate tweak doesn't rewrite this row's math.
          platformFeePercent: contractorFeePct,
          platformFeeAmount: round2(totalContractorFee),
          businessMarginPercent: employeeMarginPct,
          businessMarginAmount: round2(totalEmployeeMargin),
        },
      });
      for (const sp of computed) {
        await prisma.paymentSplit.create({
          data: {
            paymentId: payment.id,
            userId: sp.userId,
            amount: sp.amount,
            grossAmount: sp.grossAmount,
            ratePercent: sp.ratePercent,
            feeAmount: sp.feeAmount,
            netAmount: sp.netAmount,
            topUpAmount: 0,
            createdAt: when,
          },
        });
      }
    }
    // PRE-cutoff history (visible only when filter is OFF). Lands in
    // "Last Month" / "Last 30 days" presets so worker dashboards have
    // something to display.
    //
    //   • PRE_RECENT (~2 weeks back) — Employee + Contractor
    //   • PRE_OLDER  (~5 weeks back) — Admin Worker + Employee
    //
    // Plus a POST-cutoff payment at "today" so the post-cutoff side also
    // has data for each worker class. With Contractor fee 20% +
    // Employee margin 30%, a $100 payment split 50/50 lands as:
    //   • Contractor net = $50 − $10 fee = $40
    //   • Employee  net = $50 − $15 margin = $35
    //   • Business kept = $25 ($10 fee + $15 margin)
    await createConfirmedPayment("PRE-recent", PRE(14), [
      { userId: EMPLOYEE_ID,   workerType: "EMPLOYEE",   role: "primary" },
      { userId: CONTRACTOR_ID, workerType: "CONTRACTOR", role: "helper"  },
    ]);
    await createConfirmedPayment("PRE-older", PRE(35), [
      { userId: ADMIN_WORKER_ID, workerType: "EMPLOYEE", role: "primary" },
      { userId: EMPLOYEE_ID,     workerType: "EMPLOYEE", role: "helper"  },
    ]);
    await createConfirmedPayment("POST-today", POST(0), [
      { userId: EMPLOYEE_ID,   workerType: "EMPLOYEE",   role: "primary" },
      { userId: CONTRACTOR_ID, workerType: "CONTRACTOR", role: "helper"  },
    ]);
    await createConfirmedPayment("POST-today-admin", POST(0), [
      { userId: ADMIN_WORKER_ID, workerType: "EMPLOYEE", role: "primary" },
      { userId: EMPLOYEE_ID,     workerType: "EMPLOYEE", role: "helper"  },
    ]);
  }

  console.log("    Business Start Date fixtures complete.");
  console.log("");
  console.log("    Flip BUSINESS_START_DATE_ENABLED to 'true' in Settings to engage the filter.");
  console.log("    Expected post-cutoff counts (visible when filter is ON):");
  console.log("      BusinessExpense: 3 (1 EXPENSE, 1 OWNER_DRAW, 1 CAPITAL_CONTRIBUTION)");
  console.log("      Checkout (charges): 1");
  console.log("      AuditEvent: 2 (plus everything seeded post-cutoff today)");
  console.log("      Payment: 2 confirmed today + the 5 active pending approvals");
  console.log("    Pre-cutoff payments (visible when filter is OFF):");
  console.log("      • ~2 weeks ago — Employee + Contractor split");
  console.log("      • ~5 weeks ago — Admin Worker + Employee split");
  console.log("    Flip the Super reveal toggle (Settings tab) to see ALL rows again.");
}

/**
 * Primary-contact invariant assertion. Every Client with at least one ACTIVE
 * contact must have exactly one ACTIVE primary. Invoice routing (both SERVER
 * and CLAIMER paths) depends on this — a seed that produces orphan clients
 * would mask real bugs in dev. Run at the end of every seed variant.
 */
async function assertPrimaryContactInvariant() {
  const clients = await prisma.client.findMany({
    select: {
      id: true,
      displayName: true,
      contacts: {
        where: { status: "ACTIVE" },
        select: { id: true, isPrimary: true },
      },
    },
  });
  const violations: string[] = [];
  for (const c of clients) {
    if (c.contacts.length === 0) continue;
    const primaries = c.contacts.filter((ct) => ct.isPrimary).length;
    if (primaries === 0) violations.push(`Client "${c.displayName}" (${c.id}) has ${c.contacts.length} active contact(s) but no primary.`);
    else if (primaries > 1) violations.push(`Client "${c.displayName}" (${c.id}) has ${primaries} active primary contacts (expected exactly 1).`);
  }
  if (violations.length > 0) {
    console.error("Primary-contact invariant violations:");
    for (const v of violations) console.error("  -", v);
    throw new Error(`Seed produced ${violations.length} primary-contact invariant violation(s).`);
  }
  console.log(`✓ Primary-contact invariant holds across ${clients.length} client(s).`);
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const resetOnly = process.argv.includes("--reset-only");
  const templateArg = process.argv.find((a) => a.startsWith("--template="));
  const template = templateArg ? templateArg.slice("--template=".length) : "default";

  console.log("Clearing database (preserving User, UserRole, Setting)...");
  await clearDatabase();

  if (resetOnly) {
    console.log("--reset-only flag set. Skipping seed.");
    return;
  }

  switch (template) {
    case "default":
      console.log("Seeding (default template — full sample data)...");
      await seedDatabase();
      break;
    case "payments-clean":
      console.log("Seeding (payments-clean — fresh start, no pending payments)...");
      await seedPaymentsClean();
      break;
    case "payments-active":
    case "payments": // backward-compat alias for muscle memory
      console.log("Seeding (payments-active — 5 pending approvals queued)...");
      await seedPaymentsActive();
      break;
    case "payments-guaranteed-payout":
    case "payments-gp":
      console.log("Seeding (payments-guaranteed-payout — GP advance + reconciliation fixtures)...");
      await seedPaymentsGuaranteedPayout();
      break;
    default:
      console.error(
        `Unknown template: ${template}. Available: default, payments-clean, payments-active, payments-guaranteed-payout`,
      );
      process.exit(1);
  }

  await assertPrimaryContactInvariant();
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
