import { PrismaClient } from "@prisma/client";
import { PARCEL_SETTINGS } from "../src/services/parcels";
import { ALERT_SETTINGS } from "../src/services/weatherAlerts";
import { PrismaNeon } from "@prisma/adapter-neon";
import { neonConfig } from "@neondatabase/serverless";
import ws from "ws";
import { etAddDays, etFormatDate, etInstantFromParts, etMidnight, etToday } from "../src/lib/dates";
import { legacyReceiptNumberFor } from "../src/lib/receiptNumber";
import { createHash } from "crypto";

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
  // Payroll (docs/features/payroll.md). Imported Gusto data is dev-only
  // scratch — without this, rows from an import survive every reseed and the
  // Payroll tab shows stale periods that no seed fixture explains.
  // Entries cascade from periods, but deleting them explicitly keeps the
  // intent readable. PayrollIdentity is independent of both.
  // Education guides — assets reference guides, versions cascade.
  await prisma.guideAsset.deleteMany();
  await prisma.guide.updateMany({ data: { currentVersionId: null } });
  await prisma.guideVersion.deleteMany();
  await prisma.guide.deleteMany();
  await prisma.payrollEntry.deleteMany();
  await prisma.payrollPeriod.deleteMany();
  await prisma.payrollIdentity.deleteMany();
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

  console.log("  Clearing occurrences...");
  await prisma.jobOccurrence.deleteMany();

  console.log("  Clearing job relations...");
  await prisma.jobAssigneeDefault.deleteMany();
  await prisma.jobContact.deleteMany();
  await prisma.jobClient.deleteMany();

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

  console.log("  Clearing vehicles + mileage...");
  // Mileage FKs restrict on Vehicle + User deletes, so wipe entries
  // before assignments before vehicles.
  await prisma.mileageEntry.deleteMany();
  await prisma.vehicleAssignment.deleteMany();
  await prisma.vehicle.deleteMany();

  console.log("  Clearing compliance policies...");
  // PolicyDocument.currentVersionId → PolicyDocumentVersion (SetNull-ish via
  // updateMany) so version deletes don't hit an FK constraint.
  await prisma.policyDocument.updateMany({ data: { currentVersionId: null } });
  await prisma.policyReadingProgress.deleteMany();
  await prisma.policySignature.deleteMany();
  await prisma.policyException.deleteMany();
  await prisma.policyDocumentVersion.deleteMany();
  await prisma.policyDocument.deleteMany();

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
  WORKERS_COMP_PERCENT_OF_WAGES: "payments",
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
  PAYROLL_TAX_ESTIMATES: "payments",
  // Client Payment Requests
  BUSINESS_NAME: "client_requests",
  BUSINESS_ADDRESS: "client_requests",
  BUSINESS_PHONE: "client_requests",
  BUSINESS_EMAIL: "client_requests",
  BUSINESS_EIN: "client_requests",
  DEFAULT_PAYMENT_COMMUNICATIONS_MODE: "client_requests",
  PAYMENT_REQUEST_BASE_URL: "client_requests",
  PAYMENT_REQUEST_TOKEN_EXPIRY_HOURS: "client_requests",
  PAYMENT_REQUEST_STALE_DAYS: "client_requests",
  // Not seeded as a normal row — written by the stale-toggle path near the
  // bottom of this file — but it IS operator-facing, so it needs a section.
  REQUEST_PAYMENT_FROM_CLIENT_ENABLED: "client_requests",
  NOTIFY_PAYMENT_APPROVAL_VIA_SMS_EMAIL: "client_requests",
  NOTIFY_CHANGE_REQUEST_VIA_SMS_EMAIL: "client_requests",
  OUTGOING_COMMS_CC: "client_requests",
  VENMO_BUSINESS_HANDLE: "client_requests",
  ZELLE_ADDRESS: "client_requests",
  SOCIAL_LINKS: "client_requests",
  // Catalogs & Taxonomies
  SERVICE_TYPES: "catalogs",
  EQUIPMENT_KINDS: "catalogs",
  DOCUMENT_TYPES: "catalogs",
  TIMELINE_CATEGORIES: "catalogs",
  EXPENSE_CATEGORIES: "catalogs",
  EXPENSE_COST_BEHAVIOR: "catalogs",
  EQUIPMENT_RENTAL_INCOME_CONFIG: "catalogs",
  GUIDE_CATEGORIES: "catalogs",
  // Property Records — public county parcel lookup. Every endpoint is a
  // setting so covering another state is a config change, not a deploy.
  PARCEL_ENABLED: "parcel",
  PARCEL_GEOCODER_URL: "parcel",
  PARCEL_GEOCODER_QUERY: "parcel",
  PARCEL_SERVICE_URL: "parcel",
  PARCEL_IMAGE_SERVICE_URL: "parcel",
  PARCEL_CACHE_DAYS: "parcel",
  PARCEL_SEARCH_RADIUS_FT: "parcel",
  PARCEL_IMAGE_MAX_PX: "parcel",
  PARCEL_IMAGE_MARGIN_FT: "parcel",
  PARCEL_IMAGE_FORMAT: "parcel",
  PARCEL_IMAGE_TIMEOUT_SECONDS: "parcel",
  PARCEL_IMAGE_ATTEMPTS: "parcel",
  PARCEL_STATES: "parcel",
  PARCEL_QUERY_TIMEOUT_SECONDS: "parcel",
  PARCEL_QUERY_ATTEMPTS: "parcel",
  PARCEL_FAILURE_RETRY_HOURS: "parcel",
  PARCEL_USE_WORKER_GPS: "parcel",
  // Photos & Documents
  MAX_PHOTOS_PER_JOB: "media",
  PHOTO_JPEG_QUALITY: "media",
  PHOTO_MAX_EDGE_PX: "media",
  DOCUMENT_MAX_SIZE_MB: "media",
  // Education-guide media. See docs/features/education.md.
  GUIDE_MAX_IMAGE_MB: "media",
  GUIDE_MAX_VIDEO_MB: "media",
  GUIDE_VIDEO_HARD_CEILING_MB: "media",
  GUIDE_MEDIA_ALLOWED_TYPES: "media",
  GUIDE_ALLOWED_EMBED_DOMAINS: "media",
  // Compliance
  POLICY_STRICT_TWO_EYES: "compliance",
  POLICY_DEFAULT_GRACE_HOURS: "compliance",
  // Promotions — CAN-SPAM/TCPA footer copy + the HMAC click-tracking
  // secret. Footers are freely editable; PROMOTION_HMAC_SECRET is in
  // PROTECTED_SETTING_KEYS (services/settings.ts) so it renders as a
  // read-only card with a dedicated "Rotate" button instead of a
  // free-text input.
  PROMOTION_OPT_OUT_FOOTER_EMAIL: "promotions",
  PROMOTION_OPT_OUT_FOOTER_SMS: "promotions",
  PROMOTION_HMAC_SECRET: "promotions",
  ALLOWED_DOMAINS: "promotions",
  PROMOTION_LANDING_BASE_URL: "promotions",
  VANITY_STARTUP_ANIMATION_SHOW_HISTORY: "vanity",
  VANITY_STARTUP_ANIMATION_ENABLED: "vanity",
  // Integrations
  WEATHER_API_KEY: "integrations",
  NWS_ALERTS_ENABLED: "integrations",
  NWS_ALERTS_URL: "integrations",
  NWS_ALERTS_USER_AGENT: "integrations",
  NWS_ALERTS_CACHE_MINUTES: "integrations",
  NWS_ALERTS_MIN_SEVERITY: "integrations",
  NWS_ALERTS_EVENT_KEYWORDS: "integrations",
  DOCUMENT_SYNC_ENABLED: "integrations",
  CLIENT_BACKUP_ENABLED: "integrations",
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
  // Note: former Client.status = "PAUSED" was removed in the
  // pause-simplification migration. These fixtures now stay ACTIVE;
  // the "pause services" workflow lives at the Job level (Job.PAUSED
  // via bulkPauseServices). Free-text note retained for context.
  const kimResidence = await prisma.client.create({
    data: { type: "PERSON", displayName: "Kim Residence", notesInternal: "Traveling abroad, resume in June" },
  });
  const garciaFamily = await prisma.client.create({
    data: { type: "PERSON", displayName: "Garcia Family", notesInternal: "Paused for winter, resume March" },
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
    data: { clientId: vipClient.id, displayName: "Main Residence", street1: "225 Stony Branch Trl", city: "Chapel Hill", state: "NC", postalCode: "27516", country: "US", kind: "SINGLE", pointOfContactId: harringtonPrimary.id, lotSize: 12000, lotSizeUnit: "sqft", accessNotes: "Enter through side gate" },
  });
  const harringtonLake = await prisma.property.create({
    data: { clientId: vipClient.id, displayName: "Lake House", street1: "200 Plaza Dr", city: "Chapel Hill", state: "NC", postalCode: "27517", country: "US", kind: "SINGLE", pointOfContactId: harringtonSpouse.id, lotSize: 8000, lotSizeUnit: "sqft", accessNotes: "Key under mat for backyard access" },
  });
  const martinezHome = await prisma.property.create({
    data: { clientId: martinezFamily.id, displayName: "Home", street1: "301 Watts St", city: "Durham", state: "NC", postalCode: "27701", country: "US", kind: "SINGLE", pointOfContactId: martinezPrimary.id, lotSize: 5500, lotSizeUnit: "sqft" },
  });
  // Two extra Martinez properties dedicated to the "awaiting payment"
  // placeholder card on the client My Properties tab (see /client/upcoming
  // → awaitingPayment). Kept OFF the main Home pipeline so existing
  // Martinez-based tests continue to work.
  const martinezRental = await prisma.property.create({
    data: { clientId: martinezFamily.id, displayName: "Rental House", street1: "311 Watts St", city: "Durham", state: "NC", postalCode: "27701", country: "US", kind: "SINGLE", pointOfContactId: martinezPrimary.id, lotSize: 4200, lotSizeUnit: "sqft" },
  });
  const martinezCabin = await prisma.property.create({
    data: { clientId: martinezFamily.id, displayName: "Weekend Cabin", street1: "129 Sanford Rd", city: "Pittsboro", state: "NC", postalCode: "27312", country: "US", kind: "SINGLE", pointOfContactId: martinezPrimary.id, lotSize: 12000, lotSizeUnit: "sqft" },
  });
  const willowbrookCommon = await prisma.property.create({
    data: { clientId: willowbrookHoa.id, displayName: "Common Areas", street1: "101 City Hall Plaza", city: "Durham", state: "NC", postalCode: "27701", country: "US", kind: "AGGREGATE_SITE", pointOfContactId: willowbrookManager.id, lotSize: 5, lotSizeUnit: "acres", accessNotes: "HOA maintenance shed has supplies" },
  });
  const willowbrookPool = await prisma.property.create({
    data: { clientId: willowbrookHoa.id, displayName: "Pool Area Grounds", street1: "315 Holland St", city: "Durham", state: "NC", postalCode: "27701", country: "US", kind: "SINGLE", pointOfContactId: willowbrookManager.id, lotSize: 15000, lotSizeUnit: "sqft" },
  });
  const willowbrookEntrance = await prisma.property.create({
    data: { clientId: willowbrookHoa.id, displayName: "Entrance Median", street1: "1107 Minerva Ave", city: "Durham", state: "NC", postalCode: "27701", country: "US", kind: "SINGLE", pointOfContactId: willowbrookOps.id, lotSize: 3000, lotSizeUnit: "sqft", accessNotes: "High visibility area" },
  });
  const chenHome = await prisma.property.create({
    data: { clientId: chenResidence.id, displayName: "Home", street1: "307 Watts St", city: "Durham", state: "NC", postalCode: "27701", country: "US", kind: "SINGLE", pointOfContactId: chenPrimary.id, lotSize: 4000, lotSizeUnit: "sqft" },
  });
  const thompsonMain = await prisma.property.create({
    data: { clientId: vipThompson.id, displayName: "Main Estate", street1: "100 Library Dr", city: "Chapel Hill", state: "NC", postalCode: "27514", country: "US", kind: "SINGLE", pointOfContactId: thompsonPrimary.id, lotSize: 18000, lotSizeUnit: "sqft", accessNotes: "Ring bell at front gate, code 7739" },
  });
  const thompsonGuest = await prisma.property.create({
    data: { clientId: vipThompson.id, displayName: "Guest House", street1: "250 E Franklin St", city: "Chapel Hill", state: "NC", postalCode: "27514", country: "US", kind: "SINGLE", pointOfContactId: thompsonSpouse.id, lotSize: 6000, lotSizeUnit: "sqft" },
  });
  const obrienHome = await prisma.property.create({
    data: { clientId: obrienFamily.id, displayName: "Home", street1: "208 N Buchanan Blvd", city: "Durham", state: "NC", postalCode: "27701", country: "US", kind: "SINGLE", pointOfContactId: obrienPrimary.id, lotSize: 7000, lotSizeUnit: "sqft", accessNotes: "Large dog in backyard - latch gate first" },
  });
  const sunriseCommon = await prisma.property.create({
    data: { clientId: sunriseHoa.id, displayName: "Common Grounds", street1: "137 W Margaret Ln", city: "Hillsborough", state: "NC", postalCode: "27278", country: "US", kind: "AGGREGATE_SITE", pointOfContactId: sunriseManager.id, lotSize: 8, lotSizeUnit: "acres", accessNotes: "Storage unit behind clubhouse" },
  });
  const sunrisePlayground = await prisma.property.create({
    data: { clientId: sunriseHoa.id, displayName: "Playground Park", street1: "49 W Salisbury St", city: "Pittsboro", state: "NC", postalCode: "27312", country: "US", kind: "SINGLE", pointOfContactId: sunriseManager.id, lotSize: 10000, lotSizeUnit: "sqft" },
  });
  const patelHome = await prisma.property.create({
    data: { clientId: patelResidence.id, displayName: "Home", street1: "20 Sanford Rd", city: "Pittsboro", state: "NC", postalCode: "27312", country: "US", kind: "SINGLE", pointOfContactId: patelPrimary.id, lotSize: 3500, lotSizeUnit: "sqft" },
  });
  const riverBendCampus = await prisma.property.create({
    data: { clientId: riverBend.id, displayName: "Office Campus", street1: "405 Martin Luther King Jr Blvd", city: "Chapel Hill", state: "NC", postalCode: "27514", country: "US", kind: "AGGREGATE_SITE", pointOfContactId: riverBendManager.id, lotSize: 3, lotSizeUnit: "acres", accessNotes: "After-hours access via loading dock" },
  });
  const riverBendFront = await prisma.property.create({
    data: { clientId: riverBend.id, displayName: "Front Entrance & Signage", street1: "116 N Buchanan Blvd", city: "Durham", state: "NC", postalCode: "27701", country: "US", kind: "SINGLE", pointOfContactId: riverBendManager.id, lotSize: 5000, lotSizeUnit: "sqft", accessNotes: "Keep flower beds tidy - client-facing" },
  });
  const kimHome = await prisma.property.create({
    data: { clientId: kimResidence.id, displayName: "Home", street1: "301 W Main St", city: "Carrboro", state: "NC", postalCode: "27510", country: "US", kind: "SINGLE", pointOfContactId: kimPrimary.id, lotSize: 4500, lotSizeUnit: "sqft" },
  });
  const garciaHome = await prisma.property.create({
    data: { clientId: garciaFamily.id, displayName: "Home", street1: "12 East St", city: "Pittsboro", state: "NC", postalCode: "27312", country: "US", kind: "SINGLE", pointOfContactId: garciaPrimary.id, lotSize: 6000, lotSizeUnit: "sqft" },
  });
  const churchGrounds = await prisma.property.create({
    data: { clientId: lakesideChurch.id, displayName: "Church Grounds", street1: "12 East St", city: "Pittsboro", state: "NC", postalCode: "27312", country: "US", kind: "AGGREGATE_SITE", pointOfContactId: churchPrimary.id, lotSize: 2, lotSizeUnit: "acres", accessNotes: "Avoid mowing during Sunday services (8am-1pm)" },
  });

  // ── Equipment (18) ────────────────────────────────────────────────────────
  console.log("  Creating equipment...");

  // Mowers
  const mower1 = await prisma.equipment.create({
    data: { type: "MOWER", brand: "Scag", model: "V-Ride II 52\"", shortDesc: "Commercial stand-on mower", longDesc: "52\" deck, 25hp Kawasaki FX730V engine. Best for large open properties (HOAs, office parks). Velke platform for stand-on operation. Oil change every 100 hours. Blades in trailer toolbox.", status: "CHECKED_OUT", energy: "Gas", dailyRate: 8.0, qrSlug: "scag-vride-001" },
  });
  const mower2 = await prisma.equipment.create({
    data: { type: "MOWER", brand: "Scag", model: "V-Ride II 48\"", shortDesc: "Commercial stand-on mower (compact)", longDesc: "48\" deck, 22hp Kawasaki FX691V. Same as the 52\" but fits through standard 48\" gates. Use this one for fenced residential backyards. Spare belt in under-seat compartment.", status: "AVAILABLE", energy: "Gas", dailyRate: 8.0, qrSlug: "scag-vride-002" },
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
    data: { type: "CUTTER", brand: "Stihl", model: "MS 271", shortDesc: "20\" farm & ranch chainsaw", longDesc: "50.2cc, 20\" bar. Use for limb removal, storm cleanup, and tree work up to 18\" diameter. Pre-separation air filter — clean weekly. Chain tension: finger-tight with slight pull. Chaps required when operating.", status: "AVAILABLE", energy: "Gas", dailyRate: 5.0, equivalentJobs: 2, qrSlug: "stihl-ms271-001" },
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
      // Wheelbarrow is intentionally included even though it's RETIRED
      // — populates the Super Collections Insights "Kits with issues"
      // panel with a real actionable row for the reviewer.
      equipmentIds: [blower1.id, blower2.id, chainsawEquip.id, wheelbarrow.id],
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

  // Today activity — checked out this morning + released this afternoon.
  // Populates the Super Work Home dashboard "today" view (windowCheckouts,
  // windowIncome, distinctUsed) so the operator sees real numbers on
  // landing. Times are anchored to NOW so we don't depend on a specific
  // wall-clock hour for the seed run.
  const todayCheckoutStart = new Date(NOW.getTime() - 5 * 3_600_000); // 5h ago
  const todayCheckoutReturn = new Date(NOW.getTime() - 2 * 3_600_000); // 2h ago
  await prisma.checkout.create({ data: { equipmentId: mower2.id, userId: ADMIN_WORKER_ID, reservedAt: todayCheckoutStart, checkedOutAt: todayCheckoutStart } });
  await prisma.checkout.create({ data: { equipmentId: trimmer1.id, userId: CONTRACTOR_ID, reservedAt: todayCheckoutStart, checkedOutAt: todayCheckoutStart, releasedAt: todayCheckoutReturn, rentalDays: 1, rentalCost: 5.0 } });

  // ── Equipment enrichment for the blended Inventory / Collections /
  //     Vehicles views. Adds:
  //       • Historical released checkouts (last 60d) — populates the
  //         Usage breakdown, Super Insights leaderboard, and
  //         "Pieces Used" counters.
  //       • PinnedEquipment / LikedEquipment rows for each seed
  //         worker so the pin/like affordances have visible state.
  //     Additional MAINTENANCE / RETIRED equipment and a retired
  //     member in a collection lands in the enrichment near the
  //     collection seed (further above). Vehicle mileage enrichment
  //     is in seedVehicleFixtures.
  console.log("  Equipment enrichment (pins, likes, history)...");

  const equipmentPool = [
    mower1, mower2, mower3, mower4, trimmer1, trimmer2, trimmer3,
    blower1, blower2, blower3, edger1, edger2, chainsawEquip,
    aerator, spreader, pressureWasher, trailer,
  ];
  const workerPool = [MICHAEL_ID, ADMIN_WORKER_ID, EMPLOYEE_ID, CONTRACTOR_ID, TRAINEE_ID];

  // Deterministic pseudo-random so re-runs produce the same layout —
  // helps testing (screenshot stability, e2e determinism).
  let __rngState = 42;
  const rng = () => {
    __rngState = (__rngState * 1103515245 + 12345) & 0x7fffffff;
    return __rngState / 0x7fffffff;
  };
  const pick = <T>(arr: T[]): T => arr[Math.floor(rng() * arr.length)]!;

  // 25 released historical checkouts spread across the last 60 days.
  // Each spans 1-4 days. Contractors get a small rentalCost so the
  // Super Insights income leaderboard has non-zero numbers.
  for (let i = 0; i < 25; i++) {
    const daysBack = 2 + Math.floor(rng() * 58); // 2-60 days ago
    const rentalDays = 1 + Math.floor(rng() * 4); // 1-4 days
    const start = daysAgo(daysBack, 8);
    const end = daysAgo(daysBack - rentalDays, 16);
    // Skip if the calculated end is in the future (edge case near
    // today) — clamp to today.
    const releasedAt = end.getTime() > NOW.getTime() ? NOW : end;
    const eq = pick(equipmentPool);
    const userId = pick(workerPool);
    const isContractor = userId === CONTRACTOR_ID;
    await prisma.checkout.create({
      data: {
        equipmentId: eq.id,
        userId,
        reservedAt: start,
        checkedOutAt: start,
        releasedAt,
        rentalDays,
        rentalCost: isContractor && eq.dailyRate ? +(eq.dailyRate * rentalDays).toFixed(2) : 0,
      },
    });
  }

  // Pinned equipment — 2 per worker with a stable, useful selection.
  const pinSeeds: Array<{ userId: string; equipmentIds: string[] }> = [
    { userId: MICHAEL_ID,      equipmentIds: [mower1.id, trailer.id] },
    { userId: ADMIN_WORKER_ID, equipmentIds: [mower2.id, blower2.id] },
    { userId: EMPLOYEE_ID,     equipmentIds: [mower1.id, trimmer2.id, blower1.id] },
    { userId: CONTRACTOR_ID,   equipmentIds: [trimmer1.id, edger1.id] },
    { userId: TRAINEE_ID,      equipmentIds: [blower3.id] },
  ];
  for (const p of pinSeeds) {
    for (const equipmentId of p.equipmentIds) {
      await prisma.pinnedEquipment.upsert({
        where: { userId_equipmentId: { userId: p.userId, equipmentId } },
        create: { userId: p.userId, equipmentId },
        update: {},
      });
    }
  }

  // Liked equipment — 3-4 per worker, biased toward the pieces they
  // actually use. Contractors like the cheaper/free pieces; the
  // employee likes the daily workhorses.
  const likeSeeds: Array<{ userId: string; equipmentIds: string[] }> = [
    { userId: MICHAEL_ID,      equipmentIds: [mower1.id, mower2.id, trailer.id, chainsawEquip.id] },
    { userId: ADMIN_WORKER_ID, equipmentIds: [mower2.id, blower2.id, trimmer2.id] },
    { userId: EMPLOYEE_ID,     equipmentIds: [mower1.id, trimmer2.id, blower1.id, edger1.id] },
    { userId: CONTRACTOR_ID,   equipmentIds: [trimmer1.id, edger1.id, blower2.id] },
    { userId: TRAINEE_ID,      equipmentIds: [blower3.id, wheelbarrow.id] },
  ];
  for (const l of likeSeeds) {
    for (const equipmentId of l.equipmentIds) {
      await prisma.likedEquipment.upsert({
        where: { userId_equipmentId: { userId: l.userId, equipmentId } },
        create: { userId: l.userId, equipmentId },
        update: {},
      });
    }
  }

  console.log("    +25 historical checkouts, +12 pins, +18 likes.");

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
  // Two "awaiting payment demo" jobs on Sofia's extra properties. Kept
  // separate from the Home biweekly so completed occurrences here can
  // sit in the awaiting/pending-confirmation state without knocking the
  // main pipeline out of shape. See occurrences created below.
  const martinezRentalBiweekly = await prisma.job.create({
    data: { propertyId: martinezRental.id, kind: "SINGLE_ADDRESS", status: "ACCEPTED", frequencyDays: 14, defaultPrice: 65.0, estimatedMinutes: 45, notes: "Rental — biweekly mow, trim, blow" },
  });
  const martinezCabinMonthly = await prisma.job.create({
    data: { propertyId: martinezCabin.id, kind: "SINGLE_ADDRESS", status: "ACCEPTED", frequencyDays: 30, defaultPrice: 120.0, estimatedMinutes: 90, notes: "Cabin — monthly full service" },
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
      // Identify the claimer = the first NON-OBSERVER assignee.
      // The claimer's row gets assignedById === userId (the
      // canonical "self-assigned = claimer" predicate the rest
      // of the app uses to identify claim ownership). Everyone
      // else's row gets assignedById === claimer.userId (assigned
      // by the claimer). This matches the real claim flow in
      // production. Without this, seed jobs where the team doesn't
      // happen to include the admin worker ended up with NO
      // self-assigned assignee — i.e., no claimer at all — which
      // breaks the strict `assignedById === userId` check that the
      // job-card UI uses to surface the Claimer badge. If the team
      // is observers-only (no first non-observer), we fall back to
      // ADMIN_WORKER_ID so assignedById is never null — but that
      // path means the job effectively stays unclaimable until the
      // admin reassigns.
      const claimer = assignees.find((a) => a.role !== "observer");
      const claimerUserId = claimer?.userId ?? null;
      for (const a of assignees) {
        const isClaimer = !!claimerUserId && a.userId === claimerUserId;
        await prisma.jobOccurrenceAssignee.create({
          data: {
            occurrenceId: o.id,
            userId: a.userId,
            role: a.role ?? null,
            assignedById: isClaimer ? a.userId : (claimerUserId ?? ADMIN_WORKER_ID),
          },
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

  // ── Awaiting-payment demo occurrences for Sofia Martinez ───────────
  //
  // Two completed-but-unpaid occurrences on the two extra Martinez
  // properties. These drive the "Awaiting payment" and "Confirming
  // payment" placeholder cards on the client My Properties tab (see
  // /client/upcoming → awaitingPayment).
  //
  // Neither of these properties has any SCHEDULED / IN_PROGRESS
  // occurrence, so the client's Upcoming section only shows the
  // placeholders for them (Home continues to show the normal pipeline).
  //
  // Rental: status COMPLETED, NO Payment row → "Awaiting payment"
  // variant. The Pay-invoice button on the card links to the seeded
  // paymentRequestToken.
  // paymentRequestTokenCreatedAt is stamped as "today" — the default
  // PAYMENT_REQUEST_TOKEN_EXPIRY_HOURS is 72, so an old token would
  // just 404 on the /pay/[token] page. In production the token is
  // refreshed each time the invoice is re-sent, so a recent token on an
  // older service is a realistic state. paymentRequestFirstSentAt
  // still points to the ORIGINAL send (matches real re-send behavior).
  const cMartinezRental = await occ(
    { jobId: martinezRentalBiweekly.id, kind: "SINGLE_ADDRESS", startAt: daysAgo(10, 9), endAt: addMinutes(daysAgo(10, 9), 45), status: "COMPLETED", workflow: "STANDARD", jobTags: '["MOW","TRIM","EDGE","BLOW"]', price: 65.0, estimatedMinutes: 45, startedAt: daysAgo(10, 9), completedAt: addMinutes(daysAgo(10, 9), 42), paymentRequestToken: "demo-token-martinez-rental-awaiting", paymentRequestTokenCreatedAt: daysAgo(0, 9), paymentRequestSentAt: daysAgo(0, 9), paymentRequestFirstSentAt: daysAgo(10, 9) },
    [{ userId: EMPLOYEE_ID, role: "primary" }],
  );
  // Cabin: self-reported unconfirmed Payment → "Confirming payment"
  // variant (client already tapped Pay via /pay/[token]; admin hasn't
  // approved yet).
  //
  // Status MUST be PENDING_PAYMENT, not COMPLETED. approvePayment() rejects
  // anything else with "Occurrence is not pending payment", so a COMPLETED
  // occurrence with an unconfirmed payment renders in the admin's PENDING
  // APPROVAL queue but can never actually be approved — a dead row that
  // looks real. The client-side "Confirming payment" label is driven by
  // `!!payment && !payment.confirmed` (routes/client.ts), not by status, so
  // this keeps the fixture's original purpose intact.
  const cMartinezCabin = await occ(
    { jobId: martinezCabinMonthly.id, kind: "SINGLE_ADDRESS", startAt: daysAgo(20, 8), endAt: addMinutes(daysAgo(20, 8), 90), status: "PENDING_PAYMENT", workflow: "STANDARD", jobTags: '["MOW","TRIM","EDGE","BLOW"]', price: 120.0, estimatedMinutes: 90, startedAt: daysAgo(20, 8), completedAt: addMinutes(daysAgo(20, 8), 85), paymentRequestToken: "demo-token-martinez-cabin-pending", paymentRequestTokenCreatedAt: daysAgo(0, 8), paymentRequestSentAt: daysAgo(0, 8), paymentRequestFirstSentAt: daysAgo(20, 8) },
    [{ userId: EMPLOYEE_ID, role: "primary" }],
  );
  await prisma.payment.create({
    data: {
      occurrenceId: cMartinezCabin.id,
      amountPaid: 120.0,
      method: "zelle",
      confirmed: false,
      selfReported: true,
      receiptNumber: "SL-DEMOCBN1",
    },
  });
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

  // ─── COMPLETED TODAY ─────────────────────────────────────────────────────
  // Fixtures for the Super Work Home dashboard "today" landing view.
  // Anchors the completedAt / startedAt to NOW-minus-hours so these rows
  // are always in the past regardless of when the seed script runs
  // (avoids the "seed ran at 3am so 8am today is in the future" edge
  // case that the daysFromNow helper hits). Payments for these get
  // appended to the paymentData list below.
  const todayHoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
  const cTodayHarrington = await occ(
    {
      jobId: harringtonMow.id, kind: "SINGLE_ADDRESS",
      startAt: todayHoursAgo(6), endAt: todayHoursAgo(5),
      status: "CLOSED", workflow: "STANDARD",
      jobTags: '["MOW","TRIM","BLOW"]',
      price: 85.0, estimatedMinutes: 45,
      startedAt: todayHoursAgo(6),
      completedAt: todayHoursAgo(5),
    },
    // Owner is deliberately an assignee here. `ownerEarnings` is the only
    // split filter left after the guaranteed-payout removal, and it gates
    // Gusto W-2, Gusto Contractors, the workdays CSV, the P&L wage/contract
    // -labor buckets and the min-wage check. Without an owner-assigned,
    // owner-PAID job in the seed, none of those filters are exercised in dev.
    [{ userId: ADMIN_WORKER_ID, role: "primary" }, { userId: EMPLOYEE_ID, role: "helper" }, { userId: MICHAEL_ID, role: "helper" }],
  );
  const cTodayThompson = await occ(
    {
      jobId: thompsonMow.id, kind: "SINGLE_ADDRESS",
      startAt: todayHoursAgo(5), endAt: todayHoursAgo(4),
      status: "CLOSED", workflow: "STANDARD",
      jobTags: '["MOW","TRIM","EDGE","BLOW"]',
      price: 125.0, estimatedMinutes: 60,
      startedAt: todayHoursAgo(5),
      completedAt: todayHoursAgo(4),
    },
    [{ userId: CONTRACTOR_ID, role: "primary" }, { userId: TRAINEE_ID, role: "helper" }],
  );
  const cTodaySunrise = await occ(
    {
      jobId: sunriseWeekly.id, kind: "ENTIRE_SITE",
      startAt: todayHoursAgo(8), endAt: todayHoursAgo(5),
      status: "CLOSED", workflow: "STANDARD",
      jobTags: '["MOW","TRIM","EDGE","BLOW"]',
      price: 350.0, estimatedMinutes: 180,
      startedAt: todayHoursAgo(8),
      completedAt: todayHoursAgo(5),
    },
    [{ userId: ADMIN_WORKER_ID, role: "primary" }, { userId: EMPLOYEE_ID, role: "helper" }, { userId: CONTRACTOR_ID, role: "helper" }],
  );
  // Awaiting client payment today — a completed job whose invoice was
  // sent this morning but the client hasn't paid yet. Feeds the
  // "awaiting client payment" pipeline + the "Requested Xh ago" chip.
  const cTodayPatelPending = await occ(
    {
      jobId: patelMow.id, kind: "SINGLE_ADDRESS",
      startAt: todayHoursAgo(3), endAt: todayHoursAgo(2),
      status: "PENDING_PAYMENT", workflow: "STANDARD",
      jobTags: '["MOW"]',
      price: 45.0, estimatedMinutes: 25,
      startedAt: todayHoursAgo(3),
      completedAt: todayHoursAgo(2),
      paymentRequestToken: "seed-today-patel-" + Math.random().toString(36).slice(2, 10),
      paymentRequestTokenCreatedAt: todayHoursAgo(2),
      paymentRequestSentAt: todayHoursAgo(2),
      paymentRequestFirstSentAt: todayHoursAgo(2),
      paymentRequestResendCount: 0,
    },
    [{ userId: EMPLOYEE_ID, role: "primary" }],
  );

  // ── End-of-day nudge fixture ────────────────────────────────────────
  // Michael is the ONLY non-observer assignee on this today occurrence
  // so completing it drops his `remaining` count from 1 → 0 and fires
  // the "all jobs done for today — end your workday?" prompt in
  // JobsTab (see WorkdayStrip pulse condition & JobsTab CompleteJob
  // callback for the check logic). Small, quick to complete (25 min at
  // Harrington Lake) and starts late enough (2 PM ET) that it's still
  // in the future for most of the workday — easy to find on the
  // Worker Jobs timeline. Test flow: sign in as Michael → Start
  // workday → open this occurrence → Start → Complete → dismiss photo
  // prompt → the nudge dialog fires.
  await occ(
    {
      jobId: harringtonLakeMow.id,
      kind: "SINGLE_ADDRESS",
      startAt: daysFromNow(0, 14),
      endAt: addMinutes(daysFromNow(0, 14), 25),
      status: "SCHEDULED",
      workflow: "STANDARD",
      jobTags: '["MOW"]',
      price: 65.0,
      estimatedMinutes: 25,
      isClientConfirmed: true,
      pinnedNote: "END-OF-DAY NUDGE TEST — complete this to trigger the 'end workday?' prompt",
    },
    [{ userId: MICHAEL_ID, role: "primary" }],
  );

  // ── Michael: a job TOMORROW ──────────────────────────────────────────
  // Guarantees the operator account has real work on both today and
  // tomorrow, so the Jobs timeline and the "next up" surfaces have
  // something to show past the end of today.
  //
  // Deliberately TOMORROW and not today: the nudge fixture above depends
  // on Michael having exactly ONE non-observer assignment today, so that
  // completing it takes his remaining count 1 → 0 and fires the "end your
  // workday?" prompt. A second job today would silently break that.
  await occ(
    {
      jobId: kimMow.id,
      kind: "SINGLE_ADDRESS",
      startAt: daysFromNow(1, 9),
      endAt: addMinutes(daysFromNow(1, 9), 30),
      status: "SCHEDULED",
      workflow: "STANDARD",
      jobTags: '["MOW","TRIM"]',
      price: 70.0,
      estimatedMinutes: 30,
      isClientConfirmed: true,
    },
    [{ userId: MICHAEL_ID, role: "primary" }],
  );

  // ── Team workday gate fixture ────────────────────────────────────────
  // A job scheduled for today on a property/job that isn't used
  // anywhere else today, with a claimer who's clocked in and a helper
  // who has NOT started their workday today. Exercises the new
  // TEAM_WORKDAY_NOT_ACTIVE gate end to end: when the claimer presses
  // Start, the server rejects with a 409 and the frontend opens the
  // TeamWorkdayRequiredDialog naming the helper.
  //   • Property: thompsonGuestMow → "Guest House" — unique today-card
  //     label so the operator can find this fixture unambiguously.
  //   • Claimer: EMPLOYEE_ID — first non-observer in the assignees
  //     list, so the occ() helper makes them the self-assigned
  //     claimer. They have IN_PROGRESS workday today, so their OWN
  //     workday gate passes and the call reaches the team check.
  //   • Helper: ADMIN_WORKER_ID — assigned by the claimer (Employee).
  //     Has NO workday row for today (only yesterday's dangling row),
  //     so the team gate trips on them.
  // Verify by: log in (or View-as) as Employee Worker → Worker Jobs →
  // find the "Guest House" card with the "TEST: Team workday gate"
  // pinned note → tap Start → dialog should list "Admin Worker."
  await occ(
    {
      jobId: thompsonGuestMow.id,
      kind: "SINGLE_ADDRESS",
      startAt: daysFromNow(0, 17),
      endAt: addMinutes(daysFromNow(0, 17), 30),
      status: "SCHEDULED",
      workflow: "STANDARD",
      jobTags: '["MOW","TRIM"]',
      price: 55.0,
      estimatedMinutes: 30,
      isClientConfirmed: true,
      pinnedNote: "TEST: Team workday gate — try to Start to see the dialog",
      pinnedNoteRepeats: false,
    },
    [
      { userId: EMPLOYEE_ID, role: "primary" },
      { userId: ADMIN_WORKER_ID, role: "helper" },
    ],
  );

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

  // ─── GHOST TEST FIXTURES ──────────────────────────────────────────────
  // Repeating jobs whose MOST RECENT occurrence is still PENDING_PAYMENT
  // (or otherwise pre-CLOSED). Because the auto-renewer only fires on
  // payment acceptance, no next occurrence has been scheduled — so
  // JobsTab should render a "ghost" card at the would-be next date.
  //
  //   Ghost 1 — assigned to Michael only        → visible on Worker Jobs (Michael) + Admin Jobs
  //   Ghost 2 — assigned to a worker only       → NOT on Michael's Worker Jobs; visible on Admin Jobs
  //   Ghost 3 — assigned to Michael + a worker  → visible on both, and both see it on Admin Jobs
  //
  // Each uses a fresh Job on an existing property so the property's
  // OTHER jobs (with normal future occurrences) aren't disturbed.
  console.log("  Creating ghost test fixtures...");

  const ghostJob1 = await prisma.job.create({
    data: { propertyId: harringtonMain.id, kind: "SINGLE_ADDRESS", status: "ACCEPTED", frequencyDays: 7, defaultPrice: 85.0, estimatedMinutes: 45, notes: "GHOST TEST — weekly mow; last occurrence pending payment (Michael assigned)" },
  });
  await occ(
    { jobId: ghostJob1.id, kind: "SINGLE_ADDRESS", startAt: daysAgo(5, 9), endAt: addMinutes(daysAgo(5, 9), 45), status: "PENDING_PAYMENT", workflow: "STANDARD", jobTags: '["MOW","TRIM","BLOW"]', price: 85.0, estimatedMinutes: 45, startedAt: daysAgo(5, 9), completedAt: addMinutes(daysAgo(5, 9), 40) },
    [{ userId: MICHAEL_ID, role: "primary" }],
  );

  const ghostJob2 = await prisma.job.create({
    data: { propertyId: martinezHome.id, kind: "SINGLE_ADDRESS", status: "ACCEPTED", frequencyDays: 14, defaultPrice: 55.0, estimatedMinutes: 40, notes: "GHOST TEST — biweekly, assigned to worker only (no Michael)" },
  });
  await occ(
    { jobId: ghostJob2.id, kind: "SINGLE_ADDRESS", startAt: daysAgo(12, 9), endAt: addMinutes(daysAgo(12, 9), 40), status: "PENDING_PAYMENT", workflow: "STANDARD", jobTags: '["MOW"]', price: 55.0, estimatedMinutes: 40, startedAt: daysAgo(12, 9), completedAt: addMinutes(daysAgo(12, 9), 38) },
    [{ userId: EMPLOYEE_ID, role: "primary" }],
  );

  const ghostJob3 = await prisma.job.create({
    data: { propertyId: thompsonMain.id, kind: "SINGLE_ADDRESS", status: "ACCEPTED", frequencyDays: 7, defaultPrice: 125.0, estimatedMinutes: 60, notes: "GHOST TEST — weekly, team of two (Michael + Employee)" },
  });
  await occ(
    { jobId: ghostJob3.id, kind: "SINGLE_ADDRESS", startAt: daysAgo(4, 9), endAt: addMinutes(daysAgo(4, 9), 60), status: "PENDING_PAYMENT", workflow: "STANDARD", jobTags: '["MOW","TRIM","EDGE","BLOW"]', price: 125.0, estimatedMinutes: 60, startedAt: daysAgo(4, 9), completedAt: addMinutes(daysAgo(4, 9), 55) },
    [{ userId: MICHAEL_ID, role: "primary" }, { userId: EMPLOYEE_ID, role: "helper" }],
  );

  // ─── EXPIRED GHOST FIXTURES ───────────────────────────────────────────
  // Same shape as the ghosts above, but the last visit is far enough back
  // that `lastVisit + frequencyDays` already PASSED. That's what makes a
  // ghost "expired": the visit it was holding a place for never happened.
  //
  // Spread deliberately across the boundary the UI cares about:
  //   -1d / -4d / -6d  → inside the one-week grace, so they still render
  //                      (dark "Expired Nd ago" chip) and are counted by
  //                      the "Expired N" chip on the Today group header.
  //   -11d             → PAST the grace, so it must NOT render and must
  //                      NOT be counted — proves the silent fade-away.
  //                      It reappears only via the "Expired next visits"
  //                      status filter with a wider date range.
  console.log("  Creating expired-ghost test fixtures...");

  const expiredGhostSpecs: {
    propertyId: string;
    lastVisitDaysAgo: number;
    frequencyDays: number;
    price: number;
    status: "PENDING_PAYMENT" | "COMPLETED" | "CLOSED";
    note: string;
    assignees: { userId: string; role: string }[];
  }[] = [
    // 8 ago + 7 = expired yesterday
    { propertyId: harringtonMain.id, lastVisitDaysAgo: 8, frequencyDays: 7, price: 85.0, status: "PENDING_PAYMENT",
      note: "EXPIRED GHOST TEST — expired 1 day ago", assignees: [{ userId: MICHAEL_ID, role: "primary" }] },
    // 18 ago + 14 = expired 4 days ago
    { propertyId: martinezHome.id, lastVisitDaysAgo: 18, frequencyDays: 14, price: 55.0, status: "PENDING_PAYMENT",
      note: "EXPIRED GHOST TEST — expired 4 days ago", assignees: [{ userId: EMPLOYEE_ID, role: "primary" }] },
    // 13 ago + 7 = expired 6 days ago (last day inside the grace)
    { propertyId: thompsonMain.id, lastVisitDaysAgo: 13, frequencyDays: 7, price: 125.0, status: "COMPLETED",
      note: "EXPIRED GHOST TEST — expired 6 days ago, edge of the 7d grace",
      assignees: [{ userId: MICHAEL_ID, role: "primary" }, { userId: EMPLOYEE_ID, role: "helper" }] },
    // 18 ago + 7 = expired 11 days ago → dropped from the feed entirely
    { propertyId: obrienHome.id, lastVisitDaysAgo: 18, frequencyDays: 7, price: 70.0, status: "CLOSED",
      note: "EXPIRED GHOST TEST — expired 11 days ago, PAST the grace (must not render)",
      assignees: [{ userId: EMPLOYEE_ID, role: "primary" }] },
  ];

  for (const spec of expiredGhostSpecs) {
    const j = await prisma.job.create({
      data: {
        propertyId: spec.propertyId,
        kind: "SINGLE_ADDRESS",
        status: "ACCEPTED",
        frequencyDays: spec.frequencyDays,
        defaultPrice: spec.price,
        estimatedMinutes: 45,
        notes: spec.note,
      },
    });
    const start = daysAgo(spec.lastVisitDaysAgo, 9);
    await occ(
      {
        jobId: j.id, kind: "SINGLE_ADDRESS", startAt: start, endAt: addMinutes(start, 45),
        status: spec.status, workflow: "STANDARD", jobTags: '["MOW","TRIM","BLOW"]',
        price: spec.price, estimatedMinutes: 45,
        startedAt: start, completedAt: addMinutes(start, 40),
      },
      spec.assignees,
    );
  }

  // ── Payments (for completed occurrences) ──────────────────────────────────
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
  const paymentData: { occId: string; amount: number; method: "CASH" | "CHECK" | "VENMO" | "ZELLE"; collector: string; splits: { userId: string; amount: number }[]; createdAt: Date; overage?: number }[] = [
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
    // Today's completed jobs — populate the SuperWorkHomeTab "today"
    // view with real revenue + team pay data. createdAt is NOW-minus-a-
    // few-hours (guaranteed in the past regardless of when seed runs).
    // TIP FIXTURE. $85 job, client paid $105, and the $20 overpayment was
    // designated a tip: 25% business / 75% crew. Split amounts must sum to
    // the INVOICE ($85), not the payment — the tip is separate money. Gives dev a payment
    // exercising the Tip badge, the tip line on the payment card, and the
    // payroll Tips column. Note the crew shares are NOT proportional to the
    // job splits here — the operator can override the defaults.
    // Includes the LLC owner's share — see the assignee note on
    // cTodayHarrington. His split is stamped ownerEarnings below.
    { occId: cTodayHarrington.id, amount: 105, method: "VENMO", collector: ADMIN_WORKER_ID, splits: [{ userId: ADMIN_WORKER_ID, amount: 40 }, { userId: EMPLOYEE_ID, amount: 30 }, { userId: MICHAEL_ID, amount: 15 }], createdAt: new Date(NOW.getTime() - 4 * 3_600_000), tip: { total: 20, toBusiness: 5, perWorker: { [ADMIN_WORKER_ID]: 9, [EMPLOYEE_ID]: 6 } } },
    // OVERPAID fixture — a $125 job the client paid $140 cash for (rounded
    // up). Worker splits are unchanged, so the $15 is retained by the
    // business and stamped as `overageAmount`. Without a row like this the
    // "Overpaid" badge on the Payments tab has nothing to render, and an
    // overpayment is otherwise indistinguishable from a normal payment.
    { occId: cTodayThompson.id, amount: 140, overage: 15, method: "CASH", collector: CONTRACTOR_ID, splits: [{ userId: CONTRACTOR_ID, amount: 85 }, { userId: TRAINEE_ID, amount: 40 }], createdAt: new Date(NOW.getTime() - 3 * 3_600_000) },
    { occId: cTodaySunrise.id, amount: 350, method: "CHECK", collector: ADMIN_WORKER_ID, splits: [{ userId: ADMIN_WORKER_ID, amount: 150 }, { userId: EMPLOYEE_ID, amount: 100 }, { userId: CONTRACTOR_ID, amount: 100 }], createdAt: new Date(NOW.getTime() - 3 * 3_600_000) },
  ];

  for (const p of paymentData) {
    // Calculate platform fee (contractor splits) and business margin (employee/trainee splits)
    // ── Per-worker GROSS → FEE → NET, exactly as the app does it ─────
    //
    // `p.splits[].amount` in the fixture table is each worker's GROSS share
    // of the job portion. Production stores the NET (gross − fee) on
    // PaymentSplit.amount and keeps the fee in platformFee/businessMargin.
    //
    // The seed used to store the GROSS in `amount` while ALSO recording the
    // fee — so a card rendered "TOTAL TO WORKERS $350" next to "business
    // kept $95" on a $350 payment, which is $445 and obviously wrong. The
    // UI was fine; the data contradicted itself. Compute it properly here
    // and populate grossAmount/ratePercent/feeAmount/netAmount too, so the
    // card can render the real "$X share − $Y margin (Z%) = $N" breakdown
    // instead of falling back to a bare "Net payout".
    const rateFor = (userId: string) =>
      contractorIds.has(userId) ? PLATFORM_FEE_PCT : BUSINESS_MARGIN_PCT;
    // Expenses are REIMBURSED off the top before anyone is paid — same as
    // computeBreakdown(collected, expenses, ...) in services/payments.ts,
    // which splits (collected − expenses). The fixture's split amounts are
    // treated as proportions of the job portion so this stays exact
    // whatever the expense total is.
    const occExpenses = expenseData
      .filter((e) => e.occId === p.occId)
      .reduce((sum, e) => sum + e.cost, 0);
    const grossPool = p.splits.reduce((sum, sp) => sum + sp.amount, 0);
    const payoutPool = Math.max(0, Math.round((grossPool - occExpenses) * 100) / 100);
    const computedSplits = p.splits.map((sp) => {
      const share = grossPool > 0 ? sp.amount / grossPool : 0;
      const gross = Math.round(payoutPool * share * 100) / 100;
      const ratePercent = rateFor(sp.userId);
      const feeAmount = Math.round(gross * ratePercent) / 100;
      const netAmount = Math.round((gross - feeAmount) * 100) / 100;
      return { userId: sp.userId, gross, ratePercent, feeAmount, netAmount };
    });
    // Penny residual from rounding each share independently — hand it to
    // the first worker so gross always sums to the pool exactly. Without
    // this the conservation invariant trips on odd totals.
    const grossSum = computedSplits.reduce((sum, c) => sum + c.gross, 0);
    const residual = Math.round((payoutPool - grossSum) * 100) / 100;
    if (residual !== 0 && computedSplits.length > 0) {
      const first = computedSplits[0];
      first.gross = Math.round((first.gross + residual) * 100) / 100;
      first.feeAmount = Math.round(first.gross * first.ratePercent) / 100;
      first.netAmount = Math.round((first.gross - first.feeAmount) * 100) / 100;
    }
    const platformFeeTotal = computedSplits
      .filter((c) => contractorIds.has(c.userId))
      .reduce((sum, c) => sum + c.feeAmount, 0);
    const employeeFeeTotal = computedSplits
      .filter((c) => !contractorIds.has(c.userId))
      .reduce((sum, c) => sum + c.feeAmount, 0);
    const platformFeeAmount = platformFeeTotal > 0 ? Math.round(platformFeeTotal * 100) / 100 : null;
    const businessMarginAmount = employeeFeeTotal > 0 ? Math.round(employeeFeeTotal * 100) / 100 : null;

    // Processor fee: snapshot from METHOD_FEES (mirrors the taxonomy). Stored
    // on every payment — zero for Cash/Check/Zelle, ~1.9%+$0.10 for Venmo.
    const feeCfg = METHOD_FEES[p.method] ?? { feePercent: 0, feeFixed: 0 };
    const processorFeeAmount = Math.round((p.amount * feeCfg.feePercent / 100 + feeCfg.feeFixed) * 100) / 100;
    const netReceived = Math.round((p.amount - processorFeeAmount) * 100) / 100;

    await prisma.payment.create({
      data: {
        occurrenceId: p.occId,
        receiptNumber: legacyReceiptNumberFor(p.occId),
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
        overageAmount: p.overage ?? 0,
        tipAmount: p.tip?.total ?? 0,
        tipToBusinessAmount: p.tip?.toBusiness ?? 0,
        // These are CLOSED occurrences — historical, fully-settled payments.
        // Confirmed so they appear in the cash-basis tax exports (which
        // filter on confirmed=true + confirmedAt).
        confirmed: true,
        confirmedAt: p.createdAt,
        confirmedById: MICHAEL_ID,
        // ownerEarnings marks the business's own cut. Production stamps
        // this via loadOwnerSet at split-write time; the seed mirrors it so
        // every owner-exclusion filter has a row to exclude.
        splits: {
          create: computedSplits.map((c) => ({
            userId: c.userId,
            // NET, matching production. Gross/fee are carried alongside so
            // the card can show the full derivation. Fixtures flagged
            // `actualBasis` have these columns re-stamped onto the
            // actual-collected basis by a post-pass below, once the
            // expense reconciler has finished rewriting every split.
            amount: c.netAmount,
            grossAmount: c.gross,
            ratePercent: c.ratePercent,
            feeAmount: c.feeAmount,
            netAmount: c.netAmount,
            tipAmount: p.tip?.perWorker?.[c.userId] ?? 0,
            ownerEarnings: c.userId === MICHAEL_ID,
          })),
        },
      },
    });
  }

  // ── Expenses ──────────────────────────────────────────────────────────────
  console.log("  Creating expenses...");


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
    // Meals — exercises the 50%-deductible split rendering on the
    // P&L (parent + deductible/non-deductible children + footnote)
    // and the "Estimated taxable operating income" line below NOI.
    { ago: 1, cost: 28.45, desc: "Client meeting lunch (Springfield Diner)", category: "Meals", vendor: "Springfield Diner" },
    { ago: 5, cost: 18.62, desc: "Crew lunch — out-of-town job", category: "Meals", vendor: "Wendy's" },
    { ago: 12, cost: 42.10, desc: "Vendor meeting — coffee + lunch", category: "Meals", vendor: "Panera" },
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
    {
      // Forecasting ONLY (Money -> Forecast). Deliberately a separate setting
      // rather than a field on EXPENSE_CATEGORIES: that taxonomy is
      // load-bearing for expense recording, the QuickBooks export and the
      // P&L, its parser rejects unknown fields, and its loader swallows the
      // error and returns nothing — so adding a field to it took production's
      // Add Expense down on 2026-09-02. Nothing outside the forecast reads
      // this row, so a bad value here cannot reach the ledger.
      //
      // Categories absent from this map default to VARIABLE, which is the
      // conservative assumption: it denies a forecast any margin expansion
      // from scale rather than inventing some.
      key: "EXPENSE_COST_BEHAVIOR",
      value: JSON.stringify({"Advertising": "DISCRETIONARY", "Fuel": "VARIABLE", "Vehicle Maintenance": "VARIABLE", "Contract labor": "VARIABLE", "Depreciation": "ONE_TIME", "Insurance": "FIXED", "Legal and professional services": "FIXED", "Office expense": "FIXED", "Rent or lease — vehicles/equipment": "FIXED", "Rent or lease — other business property": "FIXED", "Repairs and maintenance": "VARIABLE", "Supplies": "PER_JOB", "Taxes and licenses": "FIXED", "Travel": "DISCRETIONARY", "Meals": "DISCRETIONARY", "Utilities": "FIXED", "Payment Processing Fees": "VARIABLE", "Other": "FIXED"}),
      description: "How each expense category responds to business volume, used only by the Super forecasting tool (Money -> Forecast). FIXED = does not grow with volume (insurance, software) — this is what makes scale improve margin. VARIABLE = scales with revenue (fuel, vehicle upkeep). PER_JOB = scales with job count rather than dollars (mulch, trimmer line), so a price increase does not move it. ONE_TIME = startup/non-recurring, excluded from a forward projection. DISCRETIONARY = you pick the amount each period (advertising, meals), held flat unless you opt into scaling it. Categories missing from this map default to VARIABLE. Has no effect on the P&L, the QuickBooks export, or expense recording.",
    },
    { key: "WORKERS_COMP_PERCENT_OF_WAGES", value: "12", description: "Workers compensation premium as a percent of W-2 wages. Used ONLY as the starting position for the Super forecasting tool (Money -> Forecast), where it is a tunable slider — it does not affect the P&L, payroll, or any export. Landscaping class codes run high and first-year minimum premiums distort the effective rate, so treat this as a placeholder until you can read the real percentage off a renewal quote." },
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
        // IRS limits ordinary business meal deductions to 50% — the
        // P&L renders the deductible/non-deductible split inline AND
        // derives "Estimated taxable operating income" from the
        // non-deductible portion. Cash NOI still deducts 100% (cash
        // truth). Operator can configure other partial cases (e.g.
        // 0% for Entertainment) by adding the category here.
        { label: "Meals", scheduleCLine: "24b", qbAccount: "Meals", selectable: true, plSection: "OPERATING_EXPENSE", taxDeductiblePercent: 50 },
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
  // Property-record settings, generated from PARCEL_SETTINGS in
  // services/parcels.ts — the same map the service reads its defaults from,
  // so a new tunable cannot exist in code without a row to change it.
  // Severe-weather alerts, generated from ALERT_SETTINGS in
  // services/weatherAlerts.ts — same map the service reads its defaults
  // from, so a new tunable cannot exist in code without a row to change it.
  for (const [key, [value, description]] of Object.entries(ALERT_SETTINGS)) {
    await prisma.setting.upsert({
      where: { key },
      create: { key, value, description, updatedById: MICHAEL_ID },
      update: { description, updatedById: MICHAEL_ID },
    });
  }

  for (const [key, [value, description]] of Object.entries(PARCEL_SETTINGS)) {
    await prisma.setting.upsert({
      where: { key },
      create: { key, value, description, updatedById: MICHAEL_ID },
      update: { description, updatedById: MICHAEL_ID },
    });
  }

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

  // ── Education guide fixtures ──────────────────────────────────────────────
  // Three guides covering the states an operator needs to SEE working:
  // published (what a worker reads), pending (what sits in the Super
  // review queue and drives the alert), and a bare draft.
  await seedGuides();

  // ── Education guides ──────────────────────────────────────────────────────
  // Categories are a SETTING, not a DB enum — adding "Irrigation" should
  // not need a migration. See docs/features/education.md.
  await prisma.setting.upsert({
    where: { key: "GUIDE_CATEGORIES" },
    create: { key: "GUIDE_CATEGORIES", value: "[{\"key\": \"lawn-care\", \"label\": \"Lawn care\"}, {\"key\": \"equipment\", \"label\": \"Equipment\"}, {\"key\": \"safety\", \"label\": \"Safety\"}, {\"key\": \"customer-service\", \"label\": \"Customer service\"}, {\"key\": \"admin\", \"label\": \"Admin & process\"}]", description: "Education guide categories. Array of {key, label}.", updatedById: MICHAEL_ID },
    update: { description: "Education guide categories. Array of {key, label}.", updatedById: MICHAEL_ID },
  });
  await prisma.setting.upsert({
    where: { key: "GUIDE_MAX_IMAGE_MB" },
    create: { key: "GUIDE_MAX_IMAGE_MB", value: "10", description: "HARD limit (MB) for a guide image upload. Admins are many; this is a real ceiling and an over-size upload is rejected.", updatedById: MICHAEL_ID },
    update: { description: "HARD limit (MB) for a guide image upload. Admins are many; this is a real ceiling and an over-size upload is rejected.", updatedById: MICHAEL_ID },
  });
  await prisma.setting.upsert({
    where: { key: "GUIDE_MAX_VIDEO_MB" },
    create: { key: "GUIDE_MAX_VIDEO_MB", value: "200", description: "SOFT limit (MB) for a guide video. Video is Super-only, so this catches accidents rather than abuse — a Super may override with an audited confirmation.", updatedById: MICHAEL_ID },
    update: { description: "SOFT limit (MB) for a guide video. Video is Super-only, so this catches accidents rather than abuse — a Super may override with an audited confirmation.", updatedById: MICHAEL_ID },
  });
  await prisma.setting.upsert({
    where: { key: "GUIDE_VIDEO_HARD_CEILING_MB" },
    create: { key: "GUIDE_VIDEO_HARD_CEILING_MB", value: "2048", description: "Absolute cap (MB) for a guide video — NOT overridable. Catches selecting the wrong file, which an override prompt would not.", updatedById: MICHAEL_ID },
    update: { description: "Absolute cap (MB) for a guide video — NOT overridable. Catches selecting the wrong file, which an override prompt would not.", updatedById: MICHAEL_ID },
  });
  await prisma.setting.upsert({
    where: { key: "GUIDE_MEDIA_ALLOWED_TYPES" },
    create: { key: "GUIDE_MEDIA_ALLOWED_TYPES", value: "[\"image/jpeg\", \"image/png\", \"image/webp\", \"video/mp4\", \"video/webm\"]", description: "Allowlisted content types for guide media. Allowlist, not blocklist.", updatedById: MICHAEL_ID },
    update: { description: "Allowlisted content types for guide media. Allowlist, not blocklist.", updatedById: MICHAEL_ID },
  });
  await prisma.setting.upsert({
    where: { key: "GUIDE_ALLOWED_EMBED_DOMAINS" },
    create: { key: "GUIDE_ALLOWED_EMBED_DOMAINS", value: "[\"youtube.com\", \"www.youtube.com\", \"youtu.be\", \"player.vimeo.com\", \"vimeo.com\"]", description: "Domains a guide may embed external video from. Anything else renders as a plain link.", updatedById: MICHAEL_ID },
    update: { description: "Domains a guide may embed external video from. Anything else renders as a plain link.", updatedById: MICHAEL_ID },
  });

  // ── Payment request settings ──────────────────────────────────────────────
  const paymentSettings = [
    { key: "BUSINESS_NAME", value: "Seedlings Lawn Care, LLC", description: "Display name of the business — appears on receipts, the public payment page, and other client-facing surfaces." },
    { key: "BUSINESS_EIN", value: "", description: "Employer Identification Number (EIN) — appears on client-facing statements so a client's accountant has the vendor's tax ID for their records. Leave blank to omit from the statement header." },
    { key: "BUSINESS_ADDRESS", value: "", description: "Full business mailing address (street, city, state, zip). Appears in the header of client-facing statements. Leave blank to omit." },
    { key: "BUSINESS_PHONE", value: "", description: "Business phone number shown on client-facing statements. Leave blank to omit." },
    { key: "BUSINESS_EMAIL", value: "admin@seedlingslawncare.com", description: "Business email address shown on client-facing statements. Distinct from OUTGOING_COMMS_CC — this one is a public contact address." },
    { key: "CLIENT_BACKUP_ENABLED", value: "false", description: "Nightly full-database snapshot to Google Drive at CompanyClients/YYYY-MM-DD.json. Off in dev; flip to 'true' in prod. Distinct from DOCUMENT_SYNC_ENABLED (which controls the per-document CompanyDocuments backup) so you can run one without the other. See services/clientBackup.ts." },
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
    // Promotion opt-out footers — appended to promo piggyback content on
    // outbound email/SMS. Email footer MUST include {{businessAddress}}
    // (or a literal address) per CAN-SPAM. {{unsubscribeLink}} is
    // interpolated with the /opt-out page URL at send time (static, no
    // per-recipient token). SMS is exempt from the postal-address rule
    // so the SMS footer just needs the opt-out link. Both footers are
    // only appended when the outbound message actually includes a promo
    // — plain transactional messages stay unadorned.
    //
    // Defaults below are legally-compliant starting copy. Operator can
    // edit either in the Settings tab under "Promotions".
    { key: "PROMOTION_OPT_OUT_FOOTER_EMAIL", value: "You're receiving this because you're a customer of Seedlings Lawn Care.\n{{businessAddress}}\nTo stop promotional emails: {{unsubscribeLink}}", description: "Footer appended to promotional emails. Must include {{businessAddress}} (or a literal address) for CAN-SPAM compliance. {{unsubscribeLink}} resolves to the static /opt-out page — clients enter their email/phone there to unsubscribe (no per-recipient token in the URL)." },
    { key: "PROMOTION_OPT_OUT_FOOTER_SMS", value: "Reply STOP or opt out: {{unsubscribeLink}}", description: "Footer appended to promotional SMS messages. {{unsubscribeLink}} resolves to the static /opt-out page. Keep short — every character counts against the 160-char SMS segment." },
    // Shared secret for HMAC-signing click-tracking URLs. Auto-generated
    // on first use if missing — see loadPromotionSettings(). Seeded here
    // with a deterministic dev value so tests are reproducible; the
    // service-side generator only fires when the row is missing OR
    // empty, so the seed still wins on reseeds. Prod never touches this
    // — first call to loadPromotionSettings() persists a random 32-byte
    // secret automatically.
    { key: "PROMOTION_HMAC_SECRET", value: "dev-only-promo-hmac-secret-please-rotate-in-production-64chars-min", description: "HMAC secret used to sign promotion click-tracking URLs (server-only — never leaves this DB). Auto-generated on first use in production if this row is missing or empty; you should NOT need to set it manually. Rotate here if you have specific reason to (leak suspicion, key-hygiene rotation) — a rotation invalidates every in-flight promo link." },
    // Full list of domains this Vercel project serves. Two roles:
    //   1. Feeds the Promotion editor's per-campaign domain dropdown
    //      so operators pick from a known-good list instead of typing
    //      free-text (which could get out of sync with Vercel).
    //   2. Feeds the Host-header allowlist on public endpoints so an
    //      attacker sending a spoofed Host can't trick the server into
    //      generating redirects pointing at their domain.
    //
    // JSON array of https origins (no trailing slash). PAYMENT_REQUEST_BASE_URL
    // must be a member of this list — enforced at the settings edit
    // layer. To add a new satellite domain: add it here + also add it
    // in Vercel Domains + add it to Clerk Satellites (see the
    // multi-domain doc for the checklist).
    { key: "PROMOTION_LANDING_BASE_URL", value: "", description: "Optional. Host used for promotion LANDING PAGE links only, e.g. https://seedlings.pro — on that domain the address reads as a word (seedlings.pro/motion/<slug> = \"pro-motion\"). Leave EMPTY to keep visitors on whichever domain they arrived from (the original behavior). Safe to cross domains here because landing pages are fully public: no login, no saved browser data. Do NOT point invoice or app links at another domain — those DO depend on login and per-domain browser storage." },
    { key: "ALLOWED_DOMAINS", value: '["https://seedlings.team","https://seedlings.pro"]', description: "JSON array of all domains this app serves. Used by the Promotion editor's domain picker and by public-route Host-header validation. Primary (PAYMENT_REQUEST_BASE_URL) must be one of these." },
    { key: "VANITY_STARTUP_ANIMATION_SHOW_HISTORY", value: "false", description: "When true, the app's startup typing animation stacks previously-shown vanity slugs as a muted history below the current line. When false, the history is hidden and only the current line renders." },
    { key: "VANITY_STARTUP_ANIMATION_ENABLED", value: "true", description: "Master kill switch for the app's startup typing animation. When false the splash renders just the logo and fades (no fetch, no typing). Toggle here or from the Vanity tab; the DB is authoritative so you can flip this via the Neon SQL Editor if the app itself is broken." },
  ];
  for (const s of paymentSettings) {
    await prisma.setting.upsert({
      where: { key: s.key },
      create: { key: s.key, value: s.value, description: s.description, updatedById: MICHAEL_ID },
      update: { description: s.description, updatedById: MICHAEL_ID },
    });
  }

  // ── Payroll tax estimates ────────────────────────────────────────────────
  // Operator-tunable employer-side payroll-tax rates used to estimate
  // company burden on the Reconcile P&L's synthetic "Employer payroll
  // taxes (est.)" line. Defaults are reasonable NC small-employer
  // values; operator should replace SUTA with their NCDES Tax Rate
  // Notice rate when they have it.
  //
  // Workers' Comp is intentionally NOT here — it's an insurance
  // premium tracked as a BusinessExpense (Insurance category) when the
  // bill arrives. Adding it would double-count.
  const payrollTaxEstimatesValue = JSON.stringify({
    socialSecurityEmployerPct: 6.2,
    medicareEmployerPct: 1.45,
    futaEmployerPct: 0.6,
    sutaEmployerPct: 1.5,
  });
  await prisma.setting.upsert({
    where: { key: "PAYROLL_TAX_ESTIMATES" },
    create: {
      key: "PAYROLL_TAX_ESTIMATES",
      value: payrollTaxEstimatesValue,
      description:
        "Operator-tunable employer-side payroll tax rates (Social Security, Medicare, FUTA, SUTA) used on the Reconcile P&L's 'Employer payroll taxes (est.)' line. Defaults are NC small-employer estimates; replace SUTA with your NCDES rate notice value.",
      updatedById: MICHAEL_ID,
    },
    update: {
      description:
        "Operator-tunable employer-side payroll tax rates (Social Security, Medicare, FUTA, SUTA) used on the Reconcile P&L's 'Employer payroll taxes (est.)' line. Defaults are NC small-employer estimates; replace SUTA with your NCDES rate notice value.",
      updatedById: MICHAEL_ID,
    },
  });

  // ── Social media links ───────────────────────────────────────────────────
  // Operator-tunable list of social media links shown as a row of
  // clickable brand-icon tiles under the property photos on the public
  // /pay/[token] invoice page. Empty by default; operator adds entries
  // via the SettingsTab editor (label + URL + uploaded icon). Each icon
  // is a data URL — no asset upload pipeline needed.
  const socialLinksDescription =
    "List of social media links shown as a row of clickable brand-icon tiles under the property photos on the public invoice/pay page. Each entry stores a display label, the destination URL, and a brand icon uploaded as a data URL.";
  await prisma.setting.upsert({
    where: { key: "SOCIAL_LINKS" },
    create: {
      key: "SOCIAL_LINKS",
      value: JSON.stringify({ links: [] }),
      description: socialLinksDescription,
      updatedById: MICHAEL_ID,
    },
    update: {
      description: socialLinksDescription,
      updatedById: MICHAEL_ID,
    },
  });

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
      description: "When ON, qb-journal-expenses.csv emits Contract Labor rows for contractor payment splits. When OFF, the entire Contract Labor section is dropped — appropriate once Gusto's QuickBooks integration is configured to post contractor payments to QB directly. Default ON.",
      updatedById: MICHAEL_ID,
    },
    update: { description: "When ON, qb-journal-expenses.csv emits Contract Labor rows for contractor payment splits. When OFF, the entire Contract Labor section is dropped — appropriate once Gusto's QuickBooks integration is configured to post contractor payments to QB directly. Default ON.", updatedById: MICHAEL_ID },
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

  // Compliance-system tunables. Description + section reinforced on every
  // reseed so drift can't reintroduce the empty-fields state we shipped
  // in the initial compliance migration. See docs/features/compliance.md.
  const policyStrictTwoEyesDesc = "Enforce 2-eyes on policy version Approve + Publish. When false (default), a single super-admin can approve and publish their own drafts — appropriate for solo-owner orgs. When true, Approve and Publish each require a different actor than the previous step, and Draft → Submit still allows same-actor. Flip on once a second super-admin joins the team.";
  await prisma.setting.upsert({
    where: { key: "POLICY_STRICT_TWO_EYES" },
    create: { key: "POLICY_STRICT_TWO_EYES", value: "false", description: policyStrictTwoEyesDesc, updatedById: MICHAEL_ID },
    update: { description: policyStrictTwoEyesDesc, updatedById: MICHAEL_ID },
  });
  const policyDefaultGraceHoursDesc = "Default hours between a new policy version being published and its BLOCK-level enforcement kicking in for workers who signed a prior version. Gives workers time to sign before mid-workday disruption. Per-policy override lives on PolicyDocument.gracePeriodHours (null → this default). Zero-grace publish (immediate enforcement) requires the publisher to type APPROVE at publish time.";
  await prisma.setting.upsert({
    where: { key: "POLICY_DEFAULT_GRACE_HOURS" },
    create: { key: "POLICY_DEFAULT_GRACE_HOURS", value: "24", description: policyDefaultGraceHoursDesc, updatedById: MICHAEL_ID },
    update: { description: policyDefaultGraceHoursDesc, updatedById: MICHAEL_ID },
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
    /** Explicit next-due override — otherwise anchorDate is used. */
    nextDueDate?: Date;
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
    // ── Regression fixture: admin-hidden AND due today ────────────────
    // This is the exact shape that broke on 2026-08-31. Two bugs met here:
    //  1. The header badge scoped by the operator's ROLE while the Timeline
    //     tab scoped by the ROLE CHIP, so a super on the Admin chip got a
    //     count including this adminHidden row and a list that couldn't
    //     show it — badge said 2, tab showed 1.
    //  2. Server-side urgency compared raw timestamps, so a row due TODAY
    //     read as "past" by mid-morning while the tab filed it under Today.
    // Keep this fixture: without an adminHidden row that is also due today,
    // dev cannot reproduce either one.
    {
      title: "Weekly Payroll",
      description: "Run payroll in Gusto. Super-only — not visible to admins.",
      category: "FINANCE",
      rrule: "FREQ=WEEKLY;BYDAY=MO",
      anchorDate: daysFromNow(0, 9),
      nextDueDate: daysFromNow(0, 9),
      adminHidden: true,
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
          // listUpcoming filters on `nextDueDate: { not: null }`. The seed
          // never set it, so on a database without the 2026-05 backfill
          // migration every seeded event was invisible.
          nextDueDate: e.nextDueDate ?? e.anchorDate,
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
          nextDueDate: e.nextDueDate ?? e.anchorDate,
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
    data: { clientId: obrienFamily.id, displayName: "O'Brien Backyard", street1: "208 N Buchanan Blvd", city: "Durham", state: "NC", postalCode: "27701", country: "US", kind: "SINGLE" },
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

  // ── Alert-dropdown fixtures ────────────────────────────────────────────
  // Each block produces at least one row visible in the title-bar alerts
  // dropdown so the Tasks page renders with examples of every category.
  // Anchored on existing fixtures (CONTRACTOR_ID, a real Job, a real
  // BusinessExpense) where possible to avoid drifting from the rest of
  // the seed. Self-contained — anything that fails here only affects
  // the alert it was meant to surface.
  console.log("  Creating alert-dropdown fixtures...");

  const alertAnchorJob = await prisma.job.findFirst({
    // "Repeating" is Job.frequencyDays — the JobSchedule table was dropped
    // (it had zero rows in production, which is why next-visit ghost cards
    // never appeared there).
    where: { status: "ACCEPTED", frequencyDays: { not: null } },
    orderBy: { createdAt: "asc" },
    include: { property: { include: { client: true } } },
  });
  const alertAnchorExpense = await prisma.businessExpense.findFirst({ orderBy: { createdAt: "asc" } });

  // 2. Pending payment approvals + outstanding client invoices.
  //    Two PENDING_PAYMENT occurrences anchored on the same job:
  //      (a) Has an unconfirmed Payment row → admin approval queue.
  //      (b) Has paymentRequestSentAt + no Payment → outstanding invoices.
  if (alertAnchorJob) {
    const alertPendingPayApprovalOcc = await prisma.jobOccurrence.create({
      data: {
        jobId: alertAnchorJob.id,
        kind: alertAnchorJob.kind,
        startAt: daysAgo(2, 9),
        endAt: daysAgo(2, 11),
        status: "PENDING_PAYMENT",
        source: "MANUAL",
        workflow: "STANDARD",
        completedAt: daysAgo(2, 11),
        startedAt: daysAgo(2, 9),
        notes: "Alert fixture — pending admin approval",
        price: 150,
        estimatedMinutes: 120,
      } as any,
    });
    await prisma.jobOccurrenceAssignee.create({
      data: { occurrenceId: alertPendingPayApprovalOcc.id, userId: ADMIN_WORKER_ID, assignedById: ADMIN_WORKER_ID },
    });
    await prisma.payment.create({
      data: {
        ledgerId: `seed-alert-pending-${Date.now()}`,
        occurrenceId: alertPendingPayApprovalOcc.id,
        receiptNumber: legacyReceiptNumberFor(alertPendingPayApprovalOcc.id),
        amountPaid: 150,
        method: "CASH",
        note: "Alert fixture — waiting on admin approval",
        collectedById: ADMIN_WORKER_ID,
        confirmed: false,
        selfReported: false,
        grossCharged: 150,
        netReceived: 150,
      } as any,
    });

    // TIP FIXTURE (pending) — a $200 job the client paid $240 for. The
    // overpayment is what makes the approve dialog offer the tip editor, so
    // e2e can drive the real designation flow instead of asserting on
    // already-tipped data. Two assignees with an uneven completionSplits so
    // the editor's defaults (60/40, business 0%) are visibly non-trivial.
    const tipPendingOcc = await prisma.jobOccurrence.create({
      data: {
        jobId: alertAnchorJob.id,
        kind: alertAnchorJob.kind,
        startAt: daysAgo(1, 9),
        endAt: daysAgo(1, 11),
        status: "PENDING_PAYMENT",
        source: "MANUAL",
        workflow: "STANDARD",
        completedAt: daysAgo(1, 11),
        startedAt: daysAgo(1, 9),
        notes: "TIP FIXTURE — client overpaid; approve dialog offers the tip editor",
        price: 200,
        estimatedMinutes: 120,
        completionSplits: [
          { userId: ADMIN_WORKER_ID, percent: 60 },
          { userId: EMPLOYEE_ID, percent: 40 },
        ] as any,
      } as any,
    });
    for (const uid of [ADMIN_WORKER_ID, EMPLOYEE_ID]) {
      await prisma.jobOccurrenceAssignee.create({
        data: { occurrenceId: tipPendingOcc.id, userId: uid, assignedById: ADMIN_WORKER_ID },
      });
    }
    await prisma.payment.create({
      data: {
        ledgerId: `seed-tip-pending-${Date.now()}`,
        occurrenceId: tipPendingOcc.id,
        receiptNumber: legacyReceiptNumberFor(tipPendingOcc.id),
        amountPaid: 240,
        method: "CASH",
        note: "TIP FIXTURE — $200 job, client paid $240",
        collectedById: ADMIN_WORKER_ID,
        confirmed: false,
        selfReported: false,
        grossCharged: 240,
        netReceived: 240,
      } as any,
    });

    const alertOutstandingInvoiceOcc = await prisma.jobOccurrence.create({
      data: {
        jobId: alertAnchorJob.id,
        kind: alertAnchorJob.kind,
        startAt: daysAgo(5, 9),
        endAt: daysAgo(5, 11),
        status: "PENDING_PAYMENT",
        source: "MANUAL",
        workflow: "STANDARD",
        completedAt: daysAgo(5, 11),
        startedAt: daysAgo(5, 9),
        notes: "Alert fixture — outstanding client invoice",
        price: 200,
        estimatedMinutes: 120,
        paymentRequestSentAt: daysAgo(5, 12),
        paymentRequestToken: `seed-alert-outstanding-${Date.now()}`,
        paymentRequestTokenCreatedAt: daysAgo(5, 12),
      } as any,
    });
    await prisma.jobOccurrenceAssignee.create({
      data: { occurrenceId: alertOutstandingInvoiceOcc.id, userId: ADMIN_WORKER_ID, assignedById: ADMIN_WORKER_ID },
    });

    // 3. Change request — a client asked to reschedule the upcoming
    //    occurrence of this job. Status PENDING + resolvedAt null
    //    surfaces in the admin Client requests counter.
    const alertChangeReqOcc = await prisma.jobOccurrence.create({
      data: {
        jobId: alertAnchorJob.id,
        kind: alertAnchorJob.kind,
        startAt: daysFromNow(7, 9),
        endAt: daysFromNow(7, 11),
        status: "SCHEDULED",
        source: "GENERATED",
        workflow: "STANDARD",
        notes: "Alert fixture — has open change request",
        price: 150,
        estimatedMinutes: 120,
      } as any,
    });
    await prisma.jobOccurrenceAssignee.create({
      data: { occurrenceId: alertChangeReqOcc.id, userId: ADMIN_WORKER_ID, assignedById: ADMIN_WORKER_ID },
    });
    await prisma.occurrenceChangeRequest.create({
      data: {
        occurrenceId: alertChangeReqOcc.id,
        requestedById: CLIENT_USER_ID,
        kind: "RESCHEDULE",
        status: "PENDING",
        proposedStartAt: daysFromNow(10, 9),
        comment: "Alert fixture — would like to push this visit to the following week.",
      } as any,
    });
  }

  // 4. Stale estimate followup — an ESTIMATE-workflow occurrence with
  //    status PROPOSAL_SUBMITTED dated 14 days ago lands in the
  //    7–28-day stale-followup window the title-bar counter uses
  //    (admin.ts:/admin/estimates/stale-followup-count).
  if (alertAnchorJob) {
    const alertStaleEstimateOcc = await prisma.jobOccurrence.create({
      data: {
        jobId: alertAnchorJob.id,
        kind: "SINGLE_ADDRESS",
        startAt: daysAgo(14, 10),
        endAt: daysAgo(14, 11),
        status: "PROPOSAL_SUBMITTED",
        source: "MANUAL",
        workflow: "ESTIMATE",
        isEstimate: true,
        isAdminOnly: true,
        proposalAmount: 600,
        proposalNotes: "Alert fixture — stale estimate awaiting client follow-up.",
      } as any,
    });
    await prisma.jobOccurrenceAssignee.create({
      data: { occurrenceId: alertStaleEstimateOcc.id, userId: MICHAEL_ID, assignedById: MICHAEL_ID },
    });
  }

  // 5. Ledger followup — flag the first BusinessExpense as needing
  //    follow-up (e.g. "ACH didn't post / verify next month"). Drives
  //    the Super → Ledger followups counter + Tasks shortcut.
  if (alertAnchorExpense) {
    await prisma.ledgerFollowup.create({
      data: {
        entityType: "businessExpense",
        entityId: alertAnchorExpense.id,
        note: "Alert fixture — verify ACH posted next month.",
        createdById: MICHAEL_ID,
      },
    });
  }

  await seedWorkdayFixtures();

  await seedVehicleFixtures();

  await seedPolicyFixtures();

  await seedStreamPauseFixtures();

  await seedPromotionFixtures();

  await seedVanityPageFixtures();
  await seedPayrollFixtures();

  await applySettingSections();

  console.log("  Seed complete!");
}

// Vanity URL fixtures — landing pages + the "PRO-" alias set that
// drives the startup typing animation (seedlings.pro/crastinating,
// /blematic, /totype, /bono, /fanity). Idempotent via upsert on slug.
// Operator edits copy in the Vanity URLs tab; seed exists so a fresh
// dev DB matches the live dev configuration.
//
// NOTE ON IMAGES: crastinating carries an imageR2Key in the live dev
// DB. We intentionally DO NOT seed that value here — the R2 blob
// isn't reseedable, so on a fresh DB the reference would point to a
// missing file. Existing DBs keep their image (upsert doesn't touch
// fields on match via `update: {}`).
/**
 * Payroll history (docs/features/payroll.md).
 *
 * GENERATES REAL GUSTO-FORMAT CSVs AND IMPORTS THEM THROUGH THE REAL
 * PARSER. Writing rows directly with Prisma would be shorter, but it would
 * skip `parseGustoPayrollJournal` and `checkConservation` — so a parser
 * regression could ship with a green seed. This way a broken importer
 * fails the seed loudly, and the seeded data is byte-identical to what a
 * genuine upload produces.
 *
 * The generated files are also written to `prisma/fixtures/payroll/` so the
 * operator can hand-test the upload dialog: re-uploading one exercises the
 * REPLACE path, and editing a number in one exercises the conservation
 * check's rejection.
 *
 * W-2 EMPLOYEES ONLY. Gusto's payroll journal doesn't include 1099
 * contractors, so CONTRACTOR_ID is deliberately absent — which also leaves
 * a live example of the contractor empty state.
 */
async function seedPayrollFixtures() {
  console.log("  Seeding Payroll fixtures...");

  const { importPayrollCsv } = await import("../src/services/payroll");
  const { writeFileSync, mkdirSync } = await import("fs");
  const { join } = await import("path");

  // MICHAEL_ID is deliberately ABSENT. The LLC owner takes draws, not
  // wages, so he never appears in a Gusto payroll journal — see the wage
  // table earlier in this file ("LLC owner — takes draws, not wages").
  // Seeding him a W-2 line made the operator's own dev Home look nothing
  // like production, which is exactly the surface they'd check first.
  // He still UPLOADS payroll and CONFIRMS identities below; he just isn't
  // paid through it.
  const people = [
    { userId: ADMIN_WORKER_ID, last: "Alvarez",   first: "Admin",   rate: 18.5, hours: 32 },
    // Names deliberately DIFFERENT from the real Gusto fixture
    // (__fixtures__/gusto-payroll-journal.csv uses Serrano/Torres/
    // Wanderski-Jacob). If they collided, importing that fixture would
    // auto-link against these seeded identities and stop exercising the
    // unmatched-name path it exists to demonstrate.
    { userId: EMPLOYEE_ID,     last: "Brooks",    first: "Jordan",  rate: 16.0, hours: 38 },
    { userId: TRAINEE_ID,      last: "Chen",      first: "Riley",   rate: 12.0, hours: 15 },
  ];

  // Confirmed name -> user mappings BEFORE importing, so rows attribute on
  // the way in and workers can see their pay immediately.
  for (const p of people) {
    await prisma.payrollIdentity.upsert({
      where: { lastName_firstName: { lastName: p.last, firstName: p.first } },
      create: { lastName: p.last, firstName: p.first, userId: p.userId, confirmedById: MICHAEL_ID },
      update: { userId: p.userId },
    });
  }

  const money = (n: number) => (Math.round(n * 100) / 100).toFixed(2);
  const q = (v: string | number) => `"${v}"`;
  /** MM/DD/YYYY — the format Gusto writes, and what the importer expects. */
  const us = (key: string) => {
    const [y, m, d] = key.split("-");
    return `${m}/${d}/${y}`;
  };

  const HEADERS = [
    "Last Name", "First Name", "Work Address", "Employee Type", "Payment",
    "Regular (Hours)", "Regular (Rate)", "Regular (Amount)", "Additional Earnings",
    "Gross Earnings", "Employee Taxes", "Federal Income Tax (Employee)",
    "Social Security (Employee)", "Medicare (Employee)", "Additional Medicare (Employee)",
    "NC State Tax (Employee)", "Employer Taxes", "Social Security (Employer)",
    "Medicare (Employer)", "FUTA (Employer)", "NC Unemployment Tax (Employer)",
    "Net Pay", "Reimbursements", "Donations", "Check Amount", "Employer Cost",
  ];

  const ADDRESS = "225 Stony Branch Trl, Chapel Hill, NC 27516";
  // Five weeks, and the NEWEST one is deliberately still PENDING — its pay
  // day is in the future. Payroll is run days before the deposit lands, so
  // that state is normal, and without an example of it in the seed the
  // "Pays <date> · Pending" treatment has nothing to render against.
  const WEEKS = 5;
  const outDir = join(__dirname, "fixtures", "payroll");
  mkdirSync(outDir, { recursive: true });

  let imported = 0;
  const written: string[] = [];

  // Oldest first, so the "replace" path is never exercised by the seed
  // itself and each import is a clean create.
  for (let i = WEEKS - 1; i >= 0; i--) {
    // Period ends (i*7 + 1) days ago, paid 5 days after it ends. That puts
    // the newest week's pay day in the FUTURE (ends yesterday, pays in four
    // days) and every earlier one in the past. Canonical ET helpers; a raw
    // Date would drift a pay day across a boundary.
    const periodEnd = etAddDays(etToday(), -(i * 7 + 1));
    const periodStart = etAddDays(periodEnd, -6);
    const payDay = etAddDays(periodEnd, 5);

    // Deterministic wobble so the weeks aren't identical — a flat history
    // makes the timeframe filter look broken.
    const wobble = 1 + ((i % 3) - 1) * 0.08;

    const rows = people.map((p) => {
      const hours = Math.round(p.hours * wobble * 100) / 100;
      const regular = Math.round(hours * p.rate * 100) / 100;
      // A little variable overtime/bonus, so "Additional Earnings" isn't
      // always zero and the gross isn't just hours x rate.
      const additional = i === 0 && p.userId === EMPLOYEE_ID ? 75 : 0;
      const gross = Math.round((regular + additional) * 100) / 100;
      const fed = Math.round(gross * 0.08 * 100) / 100;
      const state = Math.round(gross * 0.045 * 100) / 100;
      const ss = Math.round(gross * 0.062 * 100) / 100;
      const med = Math.round(gross * 0.0145 * 100) / 100;
      const addlMed = 0;
      const empTaxes = Math.round((fed + state + ss + med + addlMed) * 100) / 100;
      const futa = Math.round(gross * 0.006 * 100) / 100;
      const suta = Math.round(gross * 0.015 * 100) / 100;
      const erTaxes = Math.round((ss + med + futa + suta) * 100) / 100;
      const net = Math.round((gross - empTaxes) * 100) / 100;
      const erCost = Math.round((gross + erTaxes) * 100) / 100;
      return { p, hours, regular, additional, gross, fed, state, ss, med, addlMed,
               empTaxes, futa, suta, erTaxes, net, erCost };
    });

    const sum = (f: (r: (typeof rows)[number]) => number) =>
      Math.round(rows.reduce((a, r) => a + f(r), 0) * 100) / 100;

    const dataLine = (r: (typeof rows)[number]) =>
      [
        q(r.p.last), q(r.p.first), q(ADDRESS), q("Paid by the hour"), q("Direct Deposit"),
        q(money(r.hours)), q(money(r.p.rate)), q(money(r.regular)), q(money(r.additional)),
        q(money(r.gross)), q(money(r.empTaxes)), q(money(r.fed)),
        q(money(r.ss)), q(money(r.med)), q(money(r.addlMed)), q(money(r.state)),
        q(money(r.erTaxes)), q(money(r.ss)), q(money(r.med)), q(money(r.futa)), q(money(r.suta)),
        q(money(r.net)), q("0.00"), q("0.00"), q(money(r.net)), q(money(r.erCost)),
      ].join(",");

    // "Payroll Totals" must sum every ADDITIVE column exactly — the
    // importer rejects the file otherwise. The RATE column is left blank
    // on purpose: it is not additive (two workers at $18.50 total $18.50 in
    // Gusto's own report, not $37.00), and these workers are on different
    // rates so no single value is meaningful.
    const totalsLine = [
      q("Payroll Totals"), q(""), q(""), q(""), q(""),
      q(money(sum((r) => r.hours))), q(""), q(money(sum((r) => r.regular))),
      q(money(sum((r) => r.additional))), q(money(sum((r) => r.gross))),
      q(money(sum((r) => r.empTaxes))), q(money(sum((r) => r.fed))),
      q(money(sum((r) => r.ss))), q(money(sum((r) => r.med))), q(money(sum((r) => r.addlMed))),
      q(money(sum((r) => r.state))), q(money(sum((r) => r.erTaxes))),
      q(money(sum((r) => r.ss))), q(money(sum((r) => r.med))),
      q(money(sum((r) => r.futa))), q(money(sum((r) => r.suta))),
      q(money(sum((r) => r.net))), q("0.00"), q("0.00"),
      q(money(sum((r) => r.net))), q(money(sum((r) => r.erCost))),
    ].join(",");

    const csv = [
      q("Payroll Journal Report"),
      "",
      q("Seedlings Lawn Care, LLC"),
      q("225 Stony Branch Trl"),
      [q("Chapel Hill"), q("NC"), q("27516")].join(","),
      "",
      q("Employee Earnings"),
      [q("Weekly Payroll payroll period"), q(` ${us(periodStart)} - ${us(periodEnd)}`)].join(","),
      [q("Pay day"), q(` ${us(payDay)}`)].join(","),
      HEADERS.map(q).join(","),
      ...rows.map(dataLine),
      totalsLine,
      "",
    ].join("\n");

    const filename = `payroll-${payDay}.csv`;
    writeFileSync(join(outDir, filename), csv, "utf8");
    written.push(filename);

    // Through the REAL importer: parse -> conservation check -> persist.
    // Throws if the generated CSV doesn't balance, which is the point.
    await importPayrollCsv({
      csvText: csv,
      sourceR2Key: `seed/payroll/${filename}`,
      actorUserId: MICHAEL_ID,
    });
    imported++;
  }

  // One unmatched name on the most recent period, so the Super
  // identity-review queue has something realistic to work.
  const newest = await prisma.payrollPeriod.findFirst({ orderBy: { payDay: "desc" } });
  if (newest) {
    await prisma.payrollEntry.create({
      data: {
        payrollPeriodId: newest.id,
        userId: null,
        rawLastName: "Nguyen",
        rawFirstName: "Bao",
        employeeType: "Paid by the hour",
        paymentMethod: "Direct Deposit",
        regularHours: 22,
        regularRate: 15,
        grossEarnings: 330,
        netPay: 271.4,
        checkAmount: 271.4,
        raw: { "Last Name": "Nguyen", "First Name": "Bao" },
      },
    });
  }

  console.log(
    `  ✓ Seeded ${imported} payroll week(s) via real CSV import for ${people.length} employee(s) + 1 unmatched row (newest week is still pending)`,
  );
  console.log(`    CSVs written to prisma/fixtures/payroll/ (${written.join(", ")})`);
}

async function seedVanityPageFixtures() {
  console.log("  Seeding Vanity URL fixtures...");

  const marketingBody =
    "Hi, I'm Jacob — the middle of three brothers and the one who runs Seedlings Lawn Care. Together with my dad and brothers, we've been serving our local community with quality lawn care and landscaping.\n\n" +
    "Our goal is bigger than just mowing lawns. We want to give young people like us a chance to earn money, learn real-life skills, and understand the value of hard work. It's about building something from the ground up — literally and professionally.\n\n" +
    "My dad, a licensed general contractor in North Carolina, brings years of hands-on experience and guides us on every project. He's built two homes, and he makes sure every lawn care job is done right.\n\n" +
    "We're a growing team, and we care about every yard we touch. Choosing us means supporting a local family business that's here to work hard and earn your trust.";
  const marketingButtons = [
    { kind: "URL", label: "Get a free estimate", target: "https://seedlings.team", source: "literal" },
    { kind: "PHONE", label: "Call us", target: "", source: "business_phone" },
    { kind: "EMAIL", label: "Email us", target: "", source: "business_email" },
  ];

  // /crastinating — LANDING, isDefault=true, first in the startup
  // animation order (sortOrder 10). Alias targets below reference
  // this row's id via the returned upsert result.
  const crastinating = await prisma.vanityPage.upsert({
    where: { slug: "crastinating" },
    create: {
      slug: "crastinating",
      kind: "LANDING",
      isDefault: true,
      title: "Seedlings Lawn Care — Family-owned, trust-earned",
      headline: "Family-owned lawn care that earns your trust",
      body: marketingBody,
      buttons: marketingButtons,
      showInStartupAnimation: true,
      sortOrder: 10,
      enabled: true,
      createdById: MICHAEL_ID,
      updatedById: MICHAEL_ID,
    },
    update: {},
  });

  // /home — also LANDING, also isDefault=true (dev DB has both).
  // showInStartupAnimation is FALSE here so /home doesn't clutter the
  // typing animation alongside the "PRO-" alias set.
  await prisma.vanityPage.upsert({
    where: { slug: "home" },
    create: {
      slug: "home",
      kind: "LANDING",
      isDefault: true,
      title: "Seedlings Lawn Care — Family-owned, trust-earned",
      headline: "Family-owned lawn care that earns your trust",
      body: marketingBody,
      buttons: marketingButtons,
      showInStartupAnimation: false,
      sortOrder: 0,
      enabled: true,
      createdById: MICHAEL_ID,
      updatedById: MICHAEL_ID,
    },
    update: {},
  });

  // /perties — LANDING example. Kept as a distinct landing so the
  // operator has a reference for editing copy in the tab.
  await prisma.vanityPage.upsert({
    where: { slug: "perties" },
    create: {
      slug: "perties",
      kind: "LANDING",
      isDefault: false,
      title: "Properties in trusted hands",
      headline: "Properties in trusted hands",
      body: "We take care of residential and commercial properties throughout the Triangle. Whatever the job — one-time cleanup, ongoing mowing, seasonal work — we'll work around your schedule and treat your place like it's our own.\n\nWe also give local teens real work experience alongside our crew, so every visit helps train the next generation of neighborhood pros.\n\nEdit this copy in the Vanity URLs tab.",
      buttons: [
        { kind: "URL", label: "Get a free estimate", target: "https://seedlings.team" },
        { kind: "PHONE", label: "Call us", target: "919-928-4192" },
        { kind: "EMAIL", label: "Email us", target: "admin@seedlingslawncare.com" },
      ],
      showInStartupAnimation: true,
      sortOrder: 0,
      enabled: true,
      createdById: MICHAEL_ID,
      updatedById: MICHAEL_ID,
    },
    update: {},
  });

  // "PRO-" alias set — seedlings.pro/{slug} → crastinating. Together
  // they read: procrastinating, problematic, prototype, pro bono,
  // profanity. All show in the startup animation in the sortOrder
  // sequence baked in below.
  const aliases: Array<{ slug: string; sortOrder: number }> = [
    { slug: "blematic", sortOrder: 20 },
    { slug: "totype", sortOrder: 30 },
    { slug: "bono", sortOrder: 40 },
    { slug: "fanity", sortOrder: 50 },
  ];
  for (const a of aliases) {
    await prisma.vanityPage.upsert({
      where: { slug: a.slug },
      create: {
        slug: a.slug,
        kind: "ALIAS",
        isDefault: false,
        title: "",
        headline: "",
        body: "",
        buttons: [],
        aliasTargetId: crastinating.id,
        showInStartupAnimation: true,
        sortOrder: a.sortOrder,
        enabled: true,
        createdById: MICHAEL_ID,
        updatedById: MICHAEL_ID,
      },
      update: {},
    });
  }

  console.log("  ✓ Seeded 7 Vanity URL fixtures (crastinating + home + perties + 4 aliases)");
}

/**
 * Promotion fixtures — three campaigns to exercise every branch of the
 * pipeline in dev:
 *
 *   1. "Fall Offers 2026" — ACTIVE, on_invoice_sent, targets email +
 *      SMS + invoice_page. Piggybacks on the next invoice you send. Also
 *      visible on the /pay/[token] page.
 *
 *   2. "Referral Program" — DRAFT, manual_send, targets email + SMS.
 *      Start it to test the Send Now button.
 *
 *   3. "New Year Reminder 2025" — CLOSED, so the "Closed" collapsible
 *      section in the Promotions tab has an entry to render.
 *
 * All three use audienceSpec: { kind: "all" } and cooldownDays: 7. The
 * Setting rows (footer templates + HMAC secret) are seeded elsewhere in
 * the "Payment request settings" block near the top of the file — those
 * MUST be present or the piggyback dispatcher fail-closes with no
 * output.
 */
async function seedPromotionFixtures() {
  console.log("  Seeding Promotion fixtures...");

  // Clear any prior seed data so re-running is idempotent. Real ops-created
  // promotions would be preserved by title-based filtering below; the
  // seed IDs are stable so re-seed doesn't accumulate duplicates.
  await prisma.promotion.deleteMany({
    where: {
      id: { in: ["seed_promo_fall_2026", "seed_promo_referral", "seed_promo_ny_2025"] },
    },
  });
  // Also clear the seeded landing page + items so a re-seed lands with
  // fresh copies. Items cascade with the page.
  await prisma.promotionLandingPage.deleteMany({
    where: { id: "seed_landing_fall_2026" },
  });

  // Create the landing page FIRST — Promotion.landingPageId references
  // it via FK. Items seeded via nested create so the ordering is stable.
  await prisma.promotionLandingPage.create({
    data: {
      id: "seed_landing_fall_2026",
      slug: "fall-offers-2026",
      headline: "Fall & Winter Offers",
      intro:
        "We're offering a range of special services this fall and winter. Take a look at what's available below — and please share with anyone who might be interested!",
      createdById: MICHAEL_ID,
      updatedById: MICHAEL_ID,
      items: {
        create: [
          {
            title: "Gutter Cleaning",
            description:
              "Full seasonal gutter clear-out. Removes leaves, twigs, and debris. Includes downspout flushing to prevent winter ice dams.",
            ordinal: 0,
          },
          {
            title: "Garbage & Bulk Removal",
            description:
              "Yard waste, old furniture, construction debris — one-time haul-off. Priced by the load; we handle disposal.",
            ordinal: 1,
          },
          {
            title: "Outdoor Fireplace Installation",
            description:
              "Custom-built stone or brick outdoor fireplaces. Design consultation included. Fall install for cozy winter evenings.",
            ordinal: 2,
          },
          {
            title: "Mailbox Painting & Repair",
            description:
              "Sand, prime, and repaint any mailbox + post. Add house numbers or a custom finish. Great curb-appeal boost.",
            ordinal: 3,
          },
        ],
      },
    },
  });

  await prisma.promotion.createMany({
    data: [
      {
        id: "seed_promo_fall_2026",
        title: "Fall Offers 2026",
        description:
          "Piggyback fall/winter service promo. Points at the in-app landing page /promotion/fall-offers-2026 so you can exercise the click wrapper + landing-page render.",
        // Custom landing page destination — Promotion.link stays null;
        // the wrapper redirect resolves to /promotion/<slug> at click time.
        linkKind: "LANDING_PAGE",
        link: null,
        landingPageId: "seed_landing_fall_2026",
        audienceSpec: { kind: "all" },
        dispatchChannels: ["email", "sms"],
        displaySurfaces: ["invoice_page"],
        triggerKind: "on_invoice_sent",
        triggerConfig: {},
        cooldownDays: 7,
        // Long, forgiving window so the fixture is useful today AND for
        // reseeds a few weeks out — no absolute-date fragility.
        startAt: new Date("2026-08-01T00:00:00Z"),
        endAt: new Date("2027-01-31T23:59:59Z"),
        status: "ACTIVE",
        startedAt: new Date(),
        startedById: MICHAEL_ID,
        // Short URL slug so `/mo/fall-offer-2026` immediately works in
        // dev without the operator needing to open the editor first.
        // Anonymous URL: http://localhost:3000/mo/fall-offer-2026
        // Per-recipient: http://localhost:3000/mo/fall-offer-2026/<code>
        // (a code is generated on the next dispatch/send)
        shortSlug: "fall-offer-2026",
        content: {
          sms: {
            body: "Fall Offers! Special fall/winter services incl. gutter cleaning, garbage removal, painting, and more.",
            ctaText: "See offers",
          },
          email: {
            subject: "Fall & Winter Services Just for You",
            body: "We're offering special services for this fall and winter including gutter cleaning, garbage removal, outdoor fireplace installation, painting mailboxes, and more. Check out the offers below and please share with anyone who might be interested!",
            ctaText: "See fall & winter offers",
          },
          invoice_page: {
            headline: "Fall & Winter Offers Available!",
            body: "We're offering special services this fall and winter — gutter cleaning, garbage removal, outdoor fireplace installation, mailbox painting, and more.",
            ctaText: "See the offers →",
          },
        },
        createdById: MICHAEL_ID,
        updatedById: MICHAEL_ID,
      },
      {
        id: "seed_promo_referral",
        title: "Referral Program — $25 Off",
        description: "Manual blast promo. Draft state so you can start + Send Now to test the burst path.",
        link: "https://www.seedlings.team/promotions/referral",
        audienceSpec: { kind: "all" },
        dispatchChannels: ["email", "sms"],
        displaySurfaces: [],
        triggerKind: "manual_send",
        triggerConfig: {},
        cooldownDays: 30,
        startAt: null,
        endAt: null,
        status: "DRAFT",
        content: {
          sms: {
            body: "Refer a friend to Seedlings Lawn Care and you both get $25 off your next service.",
            ctaText: "Refer a friend",
          },
          email: {
            subject: "Refer a friend — $25 off for both of you",
            body: "Know someone who could use lawn care help? Refer them to us and you BOTH get $25 off your next service. No cap, no expiration.",
            ctaText: "Refer someone now",
          },
        },
        createdById: MICHAEL_ID,
        updatedById: MICHAEL_ID,
      },
      {
        id: "seed_promo_ny_2025",
        title: "New Year Reminder 2025",
        description: "Retired campaign from last year. Shows up under Closed in the Promotions tab so the collapsible section has content.",
        link: "https://www.seedlings.team/promotions/ny-2025",
        audienceSpec: { kind: "all" },
        dispatchChannels: ["email"],
        displaySurfaces: [],
        triggerKind: "manual_send",
        triggerConfig: {},
        cooldownDays: 30,
        startAt: new Date("2025-01-01T00:00:00Z"),
        endAt: new Date("2025-01-31T23:59:59Z"),
        status: "CLOSED",
        startedAt: new Date("2025-01-01T13:00:00Z"),
        startedById: MICHAEL_ID,
        closedAt: new Date("2025-02-01T14:00:00Z"),
        closedById: MICHAEL_ID,
        content: {
          email: {
            subject: "New Year, New Lawn — Book Your 2025 Schedule",
            body: "Happy new year! Book your 2025 schedule now to lock in current pricing.",
            ctaText: "Book my 2025 schedule",
          },
        },
        createdById: MICHAEL_ID,
        updatedById: MICHAEL_ID,
      },
    ],
  });

  // A handful of AuditEvent rows so the Promotions tab detail view has a
  // realistic-looking timeline the moment you open a campaign. Same
  // pattern the rest of the seed uses.
  await prisma.auditEvent.createMany({
    data: [
      {
        scope: "PROMOTION",
        verb: "CREATED",
        action: "PROMOTION_CREATED",
        actorUserId: MICHAEL_ID,
        metadata: { promotionId: "seed_promo_fall_2026" },
        createdAt: daysAgo(5),
      },
      {
        scope: "PROMOTION",
        verb: "PROMOTION_STARTED",
        action: "PROMOTION_PROMOTION_STARTED",
        actorUserId: MICHAEL_ID,
        metadata: { promotionId: "seed_promo_fall_2026", fromStatus: "DRAFT", toStatus: "ACTIVE" },
        createdAt: daysAgo(4),
      },
      {
        scope: "PROMOTION",
        verb: "CREATED",
        action: "PROMOTION_CREATED",
        actorUserId: MICHAEL_ID,
        metadata: { promotionId: "seed_promo_referral" },
        createdAt: daysAgo(2),
      },
      {
        scope: "PROMOTION",
        verb: "CREATED",
        action: "PROMOTION_CREATED",
        actorUserId: MICHAEL_ID,
        metadata: { promotionId: "seed_promo_ny_2025" },
        createdAt: new Date("2024-12-28T12:00:00Z"),
      },
      {
        scope: "PROMOTION",
        verb: "PROMOTION_STARTED",
        action: "PROMOTION_PROMOTION_STARTED",
        actorUserId: MICHAEL_ID,
        metadata: { promotionId: "seed_promo_ny_2025", fromStatus: "DRAFT", toStatus: "ACTIVE" },
        createdAt: new Date("2025-01-01T13:00:00Z"),
      },
      {
        scope: "PROMOTION",
        verb: "PROMOTION_RETIRED",
        action: "PROMOTION_PROMOTION_RETIRED",
        actorUserId: MICHAEL_ID,
        metadata: { promotionId: "seed_promo_ny_2025", fromStatus: "ACTIVE", toStatus: "CLOSED" },
        createdAt: new Date("2025-02-01T14:00:00Z"),
      },
    ],
  });

  console.log("  ✓ Seeded 3 Promotion fixtures + 1 landing page (4 items) + 6 AuditEvent rows");
}

/**
 * Dev-only example PolicyDocument rows. The three "prod" seed policies
 * (Contractor Agreement, IRS W-9, Contractor Liability Insurance) are
 * seeded via the migration file so every environment has them on Day 1.
 * These three additional rows only exist in dev so QA / manual testing
 * can exercise the full range of policy shapes without touching prod:
 *
 *   1. Safety SOP — markdown, universal (all worker types), BLOCK on
 *      WORKDAY_START + JOB_CLAIM. Tests the multi-type SIGN flow.
 *   2. Vehicle Policy — markdown, contractor + employee, BLOCK on
 *      RESERVE_EQUIPMENT. Tests the per-service gate.
 *   3. Photo Release — markdown, universal, INFO (no gate). Tests the
 *      INFO/WARN surface in the worker Compliance tab.
 */
async function seedPolicyFixtures() {
  // Find a seed admin — first SUPER, else first ADMIN, else first user.
  const supers = await prisma.userRole.findMany({
    where: { role: "SUPER" },
    include: { user: true },
    orderBy: { user: { createdAt: "asc" } },
    take: 1,
  });
  let seedAdmin = supers[0]?.user;
  if (!seedAdmin) {
    const admins = await prisma.userRole.findMany({
      where: { role: "ADMIN" },
      include: { user: true },
      orderBy: { user: { createdAt: "asc" } },
      take: 1,
    });
    seedAdmin = admins[0]?.user;
  }
  if (!seedAdmin) {
    seedAdmin = (await prisma.user.findFirst({ orderBy: { createdAt: "asc" } })) ?? undefined;
  }
  if (!seedAdmin) {
    console.log("  ⚠  No users found — skipping policy fixtures.");
    return;
  }

  async function seedPolicy(input: {
    key: string;
    title: string;
    description: string;
    targetWorkerTypes: ("EMPLOYEE" | "CONTRACTOR" | "TRAINEE")[];
    enforcement: "BLOCK" | "WARN" | "INFO";
    workerAction: "SIGN" | "ACKNOWLEDGE" | "NONE";
    adminCanUploadOnBehalf?: boolean;
    requiresWorkerUpload?: boolean;
    workerUploadLabel?: string;
    workerUploadRequiresExpiry?: boolean;
    workerUploadRequiresApproval?: boolean;
    resignTrigger: "ONE_TIME" | "DAYS_SINCE_SIGN" | "ANNIVERSARY" | "ANNUAL_ON_DATE";
    resignParamDays?: number;
    resignParamMonthDay?: string;
    gatesServices?: ("WORKDAY_START" | "JOB_CLAIM" | "RESERVE_EQUIPMENT")[];
    graceHoursOverride?: number;
    sortOrder: number;
    contentMarkdown: string;
  }) {
    // Idempotent: skip if the key exists.
    const existing = await prisma.policyDocument.findUnique({ where: { key: input.key } });
    if (existing) return;

    const contentDigest = createHash("sha256").update(input.contentMarkdown).digest("hex");
    const now = new Date();

    // Two-step create because PolicyDocument.currentVersionId ↔
    // PolicyDocumentVersion.policyDocumentId form a circular FK. Create the
    // policy first (with currentVersionId = null), then the version, then
    // UPDATE currentVersionId. Matches the pattern used in the migration.
    const createdPolicy = await prisma.policyDocument.create({
      data: {
        key: input.key,
        title: input.title,
        description: input.description,
        targetWorkerTypes: input.targetWorkerTypes,
        enforcement: input.enforcement,
        workerAction: input.workerAction,
        adminCanUploadOnBehalf: input.adminCanUploadOnBehalf ?? false,
        requiresWorkerUpload: input.requiresWorkerUpload ?? false,
        workerUploadLabel: input.workerUploadLabel ?? null,
        workerUploadRequiresExpiry: input.workerUploadRequiresExpiry ?? false,
        workerUploadRequiresApproval: input.workerUploadRequiresApproval ?? false,
        resignTrigger: input.resignTrigger,
        resignParamDays: input.resignParamDays ?? null,
        resignParamMonthDay: input.resignParamMonthDay ?? null,
        gatesServices: input.gatesServices ?? [],
        sortOrder: input.sortOrder,
        notifyOnPublish: "PUSH_ONLY",
        graceHoursOverride: input.graceHoursOverride ?? null,
        createdById: seedAdmin!.id,
      },
    });
    const version = await prisma.policyDocumentVersion.create({
      data: {
        policyDocumentId: createdPolicy.id,
        versionNumber: 1,
        contentFormat: "MARKDOWN",
        contentMarkdown: input.contentMarkdown,
        contentDigest,
        changeNote: "Initial dev-seed version.",
        forcesResign: false,
        status: "PUBLISHED",
        publishedAt: now,
        publishedById: seedAdmin!.id,
        createdById: seedAdmin!.id,
      },
    });
    await prisma.policyDocument.update({
      where: { id: createdPolicy.id },
      data: { currentVersionId: version.id },
    });
  }

  await seedPolicy({
    key: "SAFETY_SOP",
    title: "Safety Standard Operating Procedure",
    description: "Standard safety procedures every worker must acknowledge before starting a workday or claiming a job.",
    targetWorkerTypes: ["EMPLOYEE", "CONTRACTOR", "TRAINEE"],
    enforcement: "BLOCK",
    workerAction: "SIGN",
    resignTrigger: "ANNUAL_ON_DATE",
    resignParamMonthDay: "01-01",
    gatesServices: ["WORKDAY_START", "JOB_CLAIM"],
    sortOrder: 40,
    contentMarkdown: [
      "# Safety Standard Operating Procedure",
      "",
      "## PPE",
      "",
      "You must wear the following on every job:",
      "",
      "- Safety glasses",
      "- Steel-toed footwear",
      "- Hearing protection when operating powered equipment",
      "",
      "## Equipment operation",
      "",
      "1. Inspect equipment before use.",
      "2. Report any damaged / unsafe equipment immediately.",
      "3. Never operate under the influence of alcohol or drugs.",
      "",
      "## Emergencies",
      "",
      "Call 911 first, then notify the office at the number on file.",
      "",
      "By signing below I acknowledge I have read and agree to follow this SOP.",
    ].join("\n"),
  });

  await seedPolicy({
    key: "VEHICLE_POLICY",
    title: "Vehicle & Driving Policy",
    description: "Terms for operating company vehicles or driving personal vehicles on company business.",
    targetWorkerTypes: ["EMPLOYEE", "CONTRACTOR"],
    enforcement: "BLOCK",
    workerAction: "SIGN",
    resignTrigger: "DAYS_SINCE_SIGN",
    resignParamDays: 365,
    gatesServices: ["RESERVE_EQUIPMENT"],
    sortOrder: 50,
    contentMarkdown: [
      "# Vehicle & Driving Policy",
      "",
      "By signing this policy I agree:",
      "",
      "1. I hold a valid, unrestricted driver's license.",
      "2. I will maintain the company vehicle in a clean and operable condition.",
      "3. I will report any incidents (damage, tickets, close calls) within 24 hours.",
      "4. I will not use company vehicles for personal errands without prior approval.",
      "",
      "Renewal: re-sign annually.",
    ].join("\n"),
  });

  await seedPolicy({
    key: "PHOTO_RELEASE",
    title: "Photo & Media Release",
    description: "Grant company permission to use your image in marketing photos taken on job sites.",
    targetWorkerTypes: ["EMPLOYEE", "CONTRACTOR", "TRAINEE"],
    enforcement: "INFO",
    workerAction: "ACKNOWLEDGE",
    resignTrigger: "ONE_TIME",
    gatesServices: [],
    sortOrder: 90,
    contentMarkdown: [
      "# Photo & Media Release",
      "",
      "The company occasionally takes photos on job sites for marketing purposes",
      "(website, social media, printed brochures). By acknowledging this policy",
      "you consent to your image being used in that context.",
      "",
      "You may revoke this consent at any time by notifying the office.",
    ].join("\n"),
  });

  await seedPolicy({
    key: "SOCIAL_MEDIA",
    title: "Social Media Policy",
    description: "What you can and can't post from a Seedlings job — protecting yourself, your coworkers, and our clients.",
    targetWorkerTypes: ["EMPLOYEE", "CONTRACTOR", "TRAINEE"],
    enforcement: "INFO",
    workerAction: "ACKNOWLEDGE",
    resignTrigger: "DAYS_SINCE_SIGN",
    resignParamDays: 180,
    gatesServices: [],
    sortOrder: 95,
    contentMarkdown: [
      "# Social Media Policy",
      "",
      "Anything you post from a Seedlings job reflects on the company.",
      "",
      "**You consent to photos of yourself at work being shared freely** — post them on your own social media if you want, and Seedlings may share them too. If you'd rather your image not be shared, tell the office and we'll respect that.",
      "",
      "**Coworkers first.** Photos you take at work may include other people on the crew. Check with them before you post, and if anyone asks not to be shared, respect that — blur or crop them out before you share.",
      "",
      "**Never share a client's property or personal details.** That includes: street numbers, mailboxes, name signs, license plates, paperwork in view, the client's face, or a look into their windows.",
      "",
      "If a client-site photo captures any of that, use the app's built-in **redact editor** before sharing. Tap the photo on any upload screen, drag rectangles over the sensitive spots, then pick **Black out** (solid bar) or **Blur** per rectangle. Redactions bake into the file; the original un-redacted version never leaves your device.",
      "",
      "**When in doubt, don't post.** One leaked client address does more damage than a hundred posts you skipped.",
      "",
      "---",
      "",
      "By acknowledging this policy, I consent to photos of myself taken at work being shared freely — by me on my own social media and by Seedlings for its own use. I understand that photos I share may include coworkers, and I'll check with them and respect their preferences before posting.",
    ].join("\n"),
  });

  // NEW: contractor-only insurance certificate policy. Exercises the
  // requiresWorkerUpload + workerUploadRequiresExpiry + workerUploadRequiresApproval
  // + adminCanUploadOnBehalf combination. Only CONTRACTOR is targeted.
  await seedPolicy({
    key: "INSURANCE_CERT",
    title: "Contractor Liability Insurance",
    description: "Upload a current certificate of insurance. Coverage must remain valid at all times.",
    targetWorkerTypes: ["CONTRACTOR"],
    enforcement: "BLOCK",
    workerAction: "SIGN",
    adminCanUploadOnBehalf: true,
    requiresWorkerUpload: true,
    workerUploadLabel: "Certificate of Insurance (PDF)",
    workerUploadRequiresExpiry: true,
    workerUploadRequiresApproval: true,
    resignTrigger: "ANNUAL_ON_DATE",
    resignParamMonthDay: "12-31",
    gatesServices: ["JOB_CLAIM", "RESERVE_EQUIPMENT"],
    graceHoursOverride: 0,
    sortOrder: 20,
    contentMarkdown: [
      "# Contractor Liability Insurance",
      "",
      "As an independent contractor you must maintain your own general",
      "liability insurance with limits of at least **$1,000,000 per occurrence**",
      "and **$2,000,000 aggregate**.",
      "",
      "1. Upload a current certificate of insurance below.",
      "2. Enter the expiration date shown on the certificate.",
      "3. The office will review and approve within one business day.",
      "",
      "You will be prompted to upload a new certificate 30 days before this",
      "one expires.",
    ].join("\n"),
  });

  // NEW: employee/trainee-only handbook. WARN enforcement — not a hard
  // block, but shows on the compliance tab as pending. Used for the
  // auto-dormancy grace test (v2 published with grace already expired).
  await seedPolicy({
    key: "HANDBOOK",
    title: "Employee Handbook",
    description: "Review and sign the current employee handbook.",
    targetWorkerTypes: ["EMPLOYEE", "TRAINEE"],
    enforcement: "WARN",
    workerAction: "SIGN",
    resignTrigger: "ONE_TIME",
    gatesServices: [],
    sortOrder: 60,
    contentMarkdown: [
      "# Employee Handbook — v1",
      "",
      "Welcome to Seedlings. This handbook covers PTO policy, expense",
      "reimbursement, and the code of conduct.",
      "",
      "## PTO",
      "",
      "Two weeks accrued per year, prorated by hours worked.",
      "",
      "## Expenses",
      "",
      "Submit receipts weekly.",
      "",
      "## Conduct",
      "",
      "Treat clients, coworkers, and property with respect.",
    ].join("\n"),
  });

  // ─── Additional versions for testing preview / bulk publish / auto-grace ───
  await seedTestScenarios();

  console.log("  ✓ Policy fixtures + test scenarios wired");
}

/**
 * Fixtures for the "Paused repeating to review" task/alert. Grabs the
 * two earliest SCHEDULED STANDARD occurrences on distinct repeating
 * jobs and transitions them to STREAM_PAUSED with a past reminder date
 * so they immediately show up on the tasks page + alert chip after a
 * reseed. Lets the operator verify the deep-link + filter + expand
 * flow (goToStreamPauseReminders) without manually pausing a stream.
 */
async function seedStreamPauseFixtures() {
  const candidates = await prisma.jobOccurrence.findMany({
    where: {
      status: "SCHEDULED",
      workflow: "STANDARD",
      // Repeating jobs only. Was `schedule: { isNot: null }` before the
      // JobSchedule table was dropped; Job.frequencyDays is the real
      // repeating signal now.
      job: { frequencyDays: { not: null } },
    },
    orderBy: { startAt: "asc" },
    select: { id: true, jobId: true },
  });
  // De-dupe by jobId so the two paused rows come from different jobs
  // — makes the "expand only this job" per-row Review click distinct
  // from the "expand every reminder-due job" section-arrow click.
  const seenJobs = new Set<string>();
  const targets: string[] = [];
  for (const c of candidates) {
    if (seenJobs.has(c.jobId)) continue;
    seenJobs.add(c.jobId);
    targets.push(c.id);
    if (targets.length >= 2) break;
  }
  if (targets.length === 0) {
    console.log("  (skipping stream-pause fixture — no SCHEDULED repeating occurrences)");
    return;
  }
  const nowMinus1Day = daysAgo(1, 12);
  const nowMinus7Days = daysAgo(7, 12);
  const reasons = [
    "Client traveling — resume when they get back",
    "Sprinkler repair pending — hold until fixed",
  ];
  for (let i = 0; i < targets.length; i++) {
    await prisma.jobOccurrence.update({
      where: { id: targets[i] },
      data: {
        status: "STREAM_PAUSED",
        streamPausedAt: i === 0 ? nowMinus7Days : nowMinus1Day,
        streamPausedById: MICHAEL_ID,
        streamPauseReason: reasons[i],
        // Reminder in the past → immediately shows in the "to review"
        // list on load.
        streamResumeReminderAt: i === 0 ? nowMinus1Day : new Date(),
      },
    });
  }
  console.log(`  seeded ${targets.length} paused-repeating occurrence(s) with due reminders`);
}

/**
 * Sets up the multi-worker × multi-policy scenarios exercised by the
 * end-to-end walk-through. Assumes seedPolicy() has already created the
 * five base policies (SAFETY_SOP, VEHICLE_POLICY, PHOTO_RELEASE,
 * INSURANCE_CERT, HANDBOOK) at version 1 (PUBLISHED).
 */
async function seedTestScenarios() {
  // Find the seed admin the same way seedPolicyFixtures does — first SUPER,
  // then first ADMIN, then first user. Any of these can appear as the
  // grantedById on synthetic exceptions and the publishedById on new versions.
  const supers = await prisma.userRole.findMany({
    where: { role: "SUPER" },
    include: { user: true },
    orderBy: { user: { createdAt: "asc" } },
    take: 1,
  });
  let seedAdmin = supers[0]?.user;
  if (!seedAdmin) {
    const admins = await prisma.userRole.findMany({
      where: { role: "ADMIN" },
      include: { user: true },
      orderBy: { user: { createdAt: "asc" } },
      take: 1,
    });
    seedAdmin = admins[0]?.user;
  }
  if (!seedAdmin) {
    console.log("  ⚠  No admin found — skipping test scenarios.");
    return;
  }
  const adminId = seedAdmin.id;

  const now = new Date();
  const daysAgoDate = (n: number) => {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - n);
    return d;
  };
  const daysFromNowDate = (n: number) => {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() + n);
    return d;
  };

  // ── Helper: add an additional version to an existing policy ──────────────
  async function addVersion(input: {
    policyKey: string;
    versionNumber: number;
    status: "DRAFT" | "PENDING_APPROVAL" | "APPROVED" | "PUBLISHED";
    contentMarkdown: string;
    changeNote: string;
    publishedAt?: Date | null;
    graceUntil?: Date | null;
    forcesResign?: boolean;
    setCurrent?: boolean;
  }) {
    const policy = await prisma.policyDocument.findUnique({
      where: { key: input.policyKey },
    });
    if (!policy) throw new Error(`Policy ${input.policyKey} missing`);
    const contentDigest = createHash("sha256").update(input.contentMarkdown).digest("hex");
    const version = await prisma.policyDocumentVersion.create({
      data: {
        policyDocumentId: policy.id,
        versionNumber: input.versionNumber,
        contentFormat: "MARKDOWN",
        contentMarkdown: input.contentMarkdown,
        contentDigest,
        changeNote: input.changeNote,
        forcesResign: input.forcesResign ?? false,
        status: input.status,
        publishedAt: input.publishedAt ?? null,
        publishedById: input.publishedAt ? adminId : null,
        approvedAt: input.status === "APPROVED" || input.status === "PUBLISHED" ? now : null,
        approvedById: input.status === "APPROVED" || input.status === "PUBLISHED" ? adminId : null,
        submittedAt: input.status !== "DRAFT" ? now : null,
        submittedById: input.status !== "DRAFT" ? adminId : null,
        graceUntil: input.graceUntil ?? null,
        createdById: adminId,
      },
    });
    if (input.setCurrent) {
      await prisma.policyDocument.update({
        where: { id: policy.id },
        data: { currentVersionId: version.id },
      });
    }
    return version;
  }

  // ── Helper: worker signs a specific version ──────────────────────────────
  async function signAs(input: {
    userId: string;
    policyKey: string;
    versionNumber: number;
    signedAt: Date;
    workerActionAtSign: "SIGN" | "ACKNOWLEDGE" | "NONE";
    typedName?: string;
    upload?: {
      r2Key: string;
      fileName: string;
      contentType: string;
      digest: string;
      expiresAt: Date;
      status: "PENDING_REVIEW" | "APPROVED" | "REJECTED";
    };
  }) {
    const policy = await prisma.policyDocument.findUnique({
      where: { key: input.policyKey },
    });
    if (!policy) throw new Error(`Policy ${input.policyKey} missing`);
    const version = await prisma.policyDocumentVersion.findFirst({
      where: { policyDocumentId: policy.id, versionNumber: input.versionNumber },
    });
    if (!version) throw new Error(`Version ${input.policyKey} v${input.versionNumber} missing`);
    await prisma.policySignature.create({
      data: {
        userId: input.userId,
        policyDocumentVersionId: version.id,
        workerActionAtSign: input.workerActionAtSign,
        signedByUserId: input.userId,
        signedAt: input.signedAt,
        typedNameRaw: input.typedName ?? null,
        typedNameNormalized: input.typedName?.trim().toLowerCase().replace(/\s+/g, " ") ?? null,
        contentDigestAtSign: version.contentDigest,
        signatureIp: "127.0.0.1",
        signatureUserAgent: "seed-script",
        uploadR2Key: input.upload?.r2Key ?? null,
        uploadFileName: input.upload?.fileName ?? null,
        uploadContentType: input.upload?.contentType ?? null,
        uploadDigest: input.upload?.digest ?? null,
        uploadExpiresAt: input.upload?.expiresAt ?? null,
        uploadStatus: input.upload?.status ?? "NONE",
      },
    });
  }

  // ── Helper: super grants an exception ────────────────────────────────────
  async function grantException(userId: string, policyKey: string, expiresInDays: number, reason: string) {
    const policy = await prisma.policyDocument.findUnique({
      where: { key: policyKey },
    });
    if (!policy) throw new Error(`Policy ${policyKey} missing`);
    await prisma.policyException.create({
      data: {
        userId,
        policyDocumentId: policy.id,
        grantedById: adminId,
        expiresAt: daysFromNowDate(expiresInDays),
        reason,
      },
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Additional versions
  // ─────────────────────────────────────────────────────────────────────────

  // Safety SOP v2 — DRAFT. Exercises the "Preview" button on unpublished
  // versions. Never becomes current.
  await addVersion({
    policyKey: "SAFETY_SOP",
    versionNumber: 2,
    status: "DRAFT",
    changeNote: "Added tick prevention section (Q3 policy refresh).",
    contentMarkdown: [
      "# Safety Standard Operating Procedure — v2 DRAFT",
      "",
      "## PPE",
      "",
      "You must wear the following on every job:",
      "",
      "- Safety glasses",
      "- Steel-toed footwear",
      "- Hearing protection when operating powered equipment",
      "- **NEW**: Long pants and permethrin-treated socks in tall grass",
      "",
      "## Tick prevention (NEW SECTION)",
      "",
      "Perform a full-body tick check at end of workday between May and October.",
      "Report any embedded ticks within 24 hours.",
      "",
      "## Equipment operation",
      "",
      "1. Inspect equipment before use.",
      "2. Report any damaged / unsafe equipment immediately.",
      "3. Never operate under the influence of alcohol or drugs.",
    ].join("\n"),
  });

  // Vehicle Policy v2 — APPROVED, not yet published. Exercises "Bulk publish".
  await addVersion({
    policyKey: "VEHICLE_POLICY",
    versionNumber: 2,
    status: "APPROVED",
    changeNote: "Added dashcam recording clause.",
    contentMarkdown: [
      "# Vehicle & Driving Policy — v2",
      "",
      "By signing this policy I agree:",
      "",
      "1. I hold a valid, unrestricted driver's license.",
      "2. I will maintain the company vehicle in a clean and operable condition.",
      "3. I will report any incidents (damage, tickets, close calls) within 24 hours.",
      "4. I will not use company vehicles for personal errands without prior approval.",
      "5. **NEW**: I consent to dashcam recording during company drives.",
      "",
      "Renewal: re-sign annually.",
    ].join("\n"),
  });

  // Handbook v2 — PUBLISHED with grace expired 3 days ago. Exercises the
  // auto-dormancy grace extension: on a worker's next getWorkerPoliciesView
  // call, a 24h catch-up exception is created automatically.
  const handbookV2GraceUntil = daysAgoDate(3);
  const handbookV2 = await addVersion({
    policyKey: "HANDBOOK",
    versionNumber: 2,
    status: "PUBLISHED",
    changeNote: "Added remote-work section.",
    publishedAt: daysAgoDate(10),
    graceUntil: handbookV2GraceUntil,
    setCurrent: true,
    contentMarkdown: [
      "# Employee Handbook — v2",
      "",
      "## PTO",
      "",
      "Two weeks accrued per year, prorated by hours worked.",
      "",
      "## Expenses",
      "",
      "Submit receipts weekly.",
      "",
      "## Remote work (NEW SECTION)",
      "",
      "Admin-track staff may work remotely up to two days per week with prior approval.",
      "",
      "## Conduct",
      "",
      "Treat clients, coworkers, and property with respect.",
    ].join("\n"),
  });
  void handbookV2;

  // ─────────────────────────────────────────────────────────────────────────
  // Signatures per worker
  //
  // Reserved user IDs (see file top):
  //   ADMIN_WORKER  — has ADMIN role, workerType=EMPLOYEE
  //   EMPLOYEE      — pure worker
  //   CONTRACTOR    — pure worker, gets INSURANCE_CERT
  //   TRAINEE       — pure worker, target of auto-grace demo
  // ─────────────────────────────────────────────────────────────────────────

  const ADMIN_WORKER_UID = "cmnry8iih000k5acx7hf27aay";
  const CONTRACTOR_UID   = "cmnrylyaz000s5abyeyg77m4x";
  const EMPLOYEE_UID     = "cmnrz00fd002d5abyyr88byen";
  const TRAINEE_UID      = "cmnrzapcl003g5abybrzttuxs";

  // Confirm the users exist before signing — otherwise a fresh user reseed
  // hasn't run yet and we should skip silently.
  const users = await prisma.user.findMany({
    where: { id: { in: [ADMIN_WORKER_UID, CONTRACTOR_UID, EMPLOYEE_UID, TRAINEE_UID] } },
    select: { id: true },
  });
  const knownIds = new Set(users.map((u) => u.id));
  if (knownIds.size < 4) {
    console.log(`  ⚠  Some test-scenario users are missing (${knownIds.size}/4) — skipping signatures.`);
    return;
  }

  // Timestamps for the various sig events.
  const sig40dAgo = daysAgoDate(40);
  const sig30dAgo = daysAgoDate(30);
  const sig20dAgo = daysAgoDate(20);

  // ADMIN_WORKER — compliant on everything, but has an active exception on
  // Handbook (super granted for orientation) so we can see the yellow badge
  // in the sign matrix.
  await signAs({ userId: ADMIN_WORKER_UID, policyKey: "SAFETY_SOP", versionNumber: 1, signedAt: sig40dAgo, workerActionAtSign: "SIGN", typedName: "Ada Admin" });
  await signAs({ userId: ADMIN_WORKER_UID, policyKey: "VEHICLE_POLICY", versionNumber: 1, signedAt: sig40dAgo, workerActionAtSign: "SIGN", typedName: "Ada Admin" });
  await signAs({ userId: ADMIN_WORKER_UID, policyKey: "PHOTO_RELEASE", versionNumber: 1, signedAt: sig40dAgo, workerActionAtSign: "ACKNOWLEDGE" });
  await grantException(ADMIN_WORKER_UID, "HANDBOOK", 14, "Orientation not yet complete — exception during ramp-up.");

  // CONTRACTOR — signed everything, but INSURANCE_CERT upload is still
  // PENDING_REVIEW. Exercises the "Uploads awaiting review" admin banner
  // + Approve/Reject buttons.
  await signAs({ userId: CONTRACTOR_UID, policyKey: "SAFETY_SOP", versionNumber: 1, signedAt: sig20dAgo, workerActionAtSign: "SIGN", typedName: "Carlos Contractor" });
  await signAs({ userId: CONTRACTOR_UID, policyKey: "VEHICLE_POLICY", versionNumber: 1, signedAt: sig20dAgo, workerActionAtSign: "SIGN", typedName: "Carlos Contractor" });
  await signAs({ userId: CONTRACTOR_UID, policyKey: "PHOTO_RELEASE", versionNumber: 1, signedAt: sig20dAgo, workerActionAtSign: "ACKNOWLEDGE" });
  await signAs({
    userId: CONTRACTOR_UID,
    policyKey: "INSURANCE_CERT",
    versionNumber: 1,
    signedAt: sig20dAgo,
    workerActionAtSign: "SIGN",
    typedName: "Carlos Contractor",
    upload: {
      // Fake R2 key — the object doesn't actually exist. Preview / download
      // will 404, but Approve / Reject only touch the DB record so those
      // work fine for the walk-through.
      r2Key: "docs/seed/contractor-insurance-cert-2026.pdf",
      fileName: "cert-of-insurance-2026.pdf",
      contentType: "application/pdf",
      digest: "seed-fake-digest-0000000000000000000000000000000000000000000000000000",
      expiresAt: daysFromNowDate(180),
      status: "PENDING_REVIEW",
    },
  });

  // TRAINEE — signed Safety+Handbook+Photo on the OLD v1 of Handbook. When
  // TRAINEE next loads /me/policies, Handbook v2 (current) has grace that
  // expired 3 days ago and no auto-grace exception exists yet → the auto-
  // grace helper creates one for 24h. This is the star of the auto-dormancy
  // demo.
  await signAs({ userId: TRAINEE_UID, policyKey: "SAFETY_SOP", versionNumber: 1, signedAt: sig30dAgo, workerActionAtSign: "SIGN", typedName: "Tina Trainee" });
  await signAs({ userId: TRAINEE_UID, policyKey: "PHOTO_RELEASE", versionNumber: 1, signedAt: sig30dAgo, workerActionAtSign: "ACKNOWLEDGE" });
  await signAs({ userId: TRAINEE_UID, policyKey: "HANDBOOK", versionNumber: 1, signedAt: sig30dAgo, workerActionAtSign: "SIGN", typedName: "Tina Trainee" });

  // EMPLOYEE — the "fresh sign-up" case. No signatures. Everything
  // targeted (Safety, Vehicle, Photo, Handbook) is pending. Exercises the
  // multi-policy sign wizard + BLOCK-gate interceptor when they try to
  // start a workday, claim a job, or reserve a vehicle.
  //
  // (No sign calls here — leaving EMPLOYEE with zero signatures on purpose.)

  // ── Attach the Insurance Cert policy to specific high-value equipment ──
  //
  // Demonstrates the per-piece Equipment.requiredPolicyIds pattern. Only
  // these pieces trigger the insurance check on reservation; low-risk
  // equipment (small trimmers, wheelbarrow, blowers) reserves without the
  // insurance gate. Matches the pre-migration behavior where "requires
  // insurance" was a per-piece flag.
  const insurance = await prisma.policyDocument.findUnique({
    where: { key: "INSURANCE_CERT" },
    select: { id: true },
  });
  if (insurance) {
    // qrSlug is the stable identifier for each piece — deterministic across
    // reseeds. Attach the insurance policy to the trailer (large, road-
    // hauling) and the chainsaw (high injury risk).
    const attachToSlugs = ["bigtex-35sa-001", "stihl-ms271-001"];
    const pieces = await prisma.equipment.findMany({
      where: { qrSlug: { in: attachToSlugs } },
      select: { id: true, qrSlug: true, requiredPolicyIds: true },
    });
    for (const p of pieces) {
      // Idempotent — don't re-add if already present.
      if (p.requiredPolicyIds.includes(insurance.id)) continue;
      await prisma.equipment.update({
        where: { id: p.id },
        data: { requiredPolicyIds: [...p.requiredPolicyIds, insurance.id] },
      });
    }
    console.log(`    Attached Insurance Cert to ${pieces.length} piece(s) of equipment.`);
  }

  console.log(`  ✓ Test scenarios: 5 policies, ${users.length} workers, mixed signature states`);
}

/**
 * Dual-use vehicle fixtures — one active truck + owner + one worker
 * assignment so the Vehicles admin tab and the worker MileageStrip
 * both render with real data on first load. Also generates a handful
 * of past MileageEntry rows so the log has content to view/approve.
 */
async function seedVehicleFixtures() {
  console.log("  Vehicles + mileage fixtures...");
  // Main-reset section wipes Vehicle / VehicleAssignment / MileageEntry
  // rows before this runs, so we always start from a clean slate.

  const truck = await prisma.vehicle.create({
    data: {
      displayName: "Mike's Ram 2500",
      make: "Ram",
      vehicleModel: "2500",
      year: 2020,
      plate: "NC-LWN-42",
      inServiceDate: "2024-03-01",
      currentOdometer: 48231,
    },
  });

  // Second truck — assigned only to MICHAEL_ID so the Start-mileage
  // vehicle picker on Jobs-Next renders multi-vehicle for him. Also
  // gives the Vehicles admin tab a second row to look at.
  const secondTruck = await prisma.vehicle.create({
    data: {
      displayName: "Jacob's F-150",
      make: "Ford",
      vehicleModel: "F-150",
      year: 2019,
      plate: "NC-LWN-88",
      inServiceDate: "2024-05-15",
      currentOdometer: 62450,
    },
  });

  // Utility van — third option so the picker has enough to exercise
  // its wrap/scroll behavior. Assigned to MICHAEL_ID only.
  const van = await prisma.vehicle.create({
    data: {
      displayName: "Crew Van",
      make: "Ford",
      vehicleModel: "Transit",
      year: 2022,
      plate: "NC-LWN-15",
      inServiceDate: "2025-01-10",
      currentOdometer: 18740,
    },
  });

  // Assignments. MICHAEL_ID gets all three so the vehicle picker
  // renders as a multi-choice row. EMPLOYEE_ID stays on the Ram
  // (single-vehicle worker flow still testable via that account).
  await prisma.vehicleAssignment.createMany({
    data: [
      { vehicleId: truck.id, userId: MICHAEL_ID },
      { vehicleId: truck.id, userId: EMPLOYEE_ID },
      { vehicleId: secondTruck.id, userId: MICHAEL_ID },
      { vehicleId: van.id, userId: MICHAEL_ID },
    ],
    skipDuplicates: true,
  });

  // Backfill three past mileage sessions — one already approved, one
  // pending approval, one open (still driving). Exercises every row
  // state in the admin log at a glance.
  const now = new Date();
  const dayKey = (d: Date) => etFormatDate(d);

  const twoDaysAgo = new Date(now);
  twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
  twoDaysAgo.setHours(8, 15, 0, 0);
  const twoDaysAgoEnd = new Date(twoDaysAgo);
  twoDaysAgoEnd.setHours(16, 40, 0, 0);

  await prisma.mileageEntry.create({
    data: {
      vehicleId: truck.id,
      driverUserId: MICHAEL_ID,
      entryDate: dayKey(twoDaysAgo),
      startedAt: twoDaysAgo,
      endedAt: twoDaysAgoEnd,
      startOdometer: 48150,
      endOdometer: 48198,
      miles: 48,
      notes: "Chapel Hill route — 5 properties",
      approvedAt: new Date(twoDaysAgoEnd.getTime() + 20 * 60 * 60 * 1000),
      approvedById: MICHAEL_ID,
    },
  });

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  yesterday.setHours(7, 50, 0, 0);
  const yesterdayEnd = new Date(yesterday);
  yesterdayEnd.setHours(15, 10, 0, 0);

  await prisma.mileageEntry.create({
    data: {
      vehicleId: truck.id,
      driverUserId: EMPLOYEE_ID,
      entryDate: dayKey(yesterday),
      startedAt: yesterday,
      endedAt: yesterdayEnd,
      startOdometer: 48198,
      endOdometer: 48231,
      miles: 33,
      notes: "Using vehicle to service lawns",
      // approvedAt intentionally null — surfaces in pending-approval queue.
    },
  });

  // Companion PENDING-APPROVAL workday for Employee yesterday. Exists
  // so the workday → mileage cascade is testable end-to-end: Super
  // approves this workday in the Workdays tab and the pending mileage
  // entry above auto-approves alongside via the cascade wired in
  // apps/api/src/routes/admin.ts. The workday-fixture function
  // deliberately left EMPLOYEE_ID at NOT_STARTED today; this adds a
  // separate row for yesterday, so today's Home-strip fixture is
  // undisturbed.
  await prisma.workerWorkday.upsert({
    where: { userId_workdayDate: { userId: EMPLOYEE_ID, workdayDate: dayKey(yesterday) } },
    create: {
      userId: EMPLOYEE_ID,
      workdayDate: dayKey(yesterday),
      startedAt: yesterday,
      endedAt: yesterdayEnd,
      totalPausedMs: 30 * 60 * 1000, // 30-min lunch
    },
    update: {},
  });

  const today = new Date(now);
  today.setHours(now.getHours() - 1, 0, 0, 0);
  await prisma.mileageEntry.create({
    data: {
      vehicleId: truck.id,
      driverUserId: MICHAEL_ID,
      entryDate: dayKey(today),
      startedAt: today,
      // endedAt intentionally null — open session, still driving.
      startOdometer: 48231,
    },
  });

  // Backfill enrichment — 10 additional past-30d approved sessions
  // spread across all three vehicles + all drivers, plus one extra
  // pending entry per week. This populates the Super Insights strip
  // on the Vehicles tab: "Last 30d miles" gets ~250-400 realistic
  // miles, "Pending approvals" ticks past 1, "Fleet" + "Unassigned"
  // read as configured. Odometers are advanced monotonically so the
  // per-vehicle current-odo stays consistent with the log.
  const vehiclePool = [
    { v: truck, driver: EMPLOYEE_ID, baseOdo: 47500 },
    { v: truck, driver: MICHAEL_ID, baseOdo: 47700 },
    { v: secondTruck, driver: MICHAEL_ID, baseOdo: 62100 },
    { v: van, driver: MICHAEL_ID, baseOdo: 18400 },
  ];
  let seededMileage = 0;
  let seededPending = 0;
  for (let i = 0; i < 12; i++) {
    const bucket = vehiclePool[i % vehiclePool.length]!;
    const daysBack = 2 + i * 2; // 2, 4, 6, ... 24 days back
    const start = new Date(now);
    start.setDate(start.getDate() - daysBack);
    start.setHours(8, 30, 0, 0);
    const end = new Date(start);
    end.setHours(15, 45, 0, 0);
    const miles = 22 + (i * 4) % 45; // 22-66 mile deterministic spread
    const startOdo = bucket.baseOdo + i * 60;
    const endOdo = startOdo + miles;
    // Every 4th entry stays pending to give the "Pending approvals"
    // panel non-zero data.
    const isPending = i % 4 === 3;
    await prisma.mileageEntry.create({
      data: {
        vehicleId: bucket.v.id,
        driverUserId: bucket.driver,
        entryDate: dayKey(start),
        startedAt: start,
        endedAt: end,
        startOdometer: startOdo,
        endOdometer: endOdo,
        miles,
        notes: isPending ? "Awaiting approval." : "Routine service loop.",
        approvedAt: isPending ? null : new Date(end.getTime() + 12 * 60 * 60 * 1000),
        approvedById: isPending ? null : MICHAEL_ID,
      },
    });
    if (isPending) seededPending++;
    else seededMileage++;
  }

  console.log(`    Seeded 3 vehicles, 4 assignments, 3 baseline mileage entries + ${seededMileage} approved + ${seededPending} pending in last 30d.`);
}

/**
 * Workday fixtures — one row per seed worker covering every UI state so the
 * Worker Home strip + dialogs can be eyeballed end-to-end without manual
 * setup. Anchored on the actual current wall-clock so all the live
 * durations tick correctly in the strip.
 *
 *   EMPLOYEE_ID    → NOT_STARTED (no row — surfaces the "Start workday"
 *                    button; required for the team-workday-gate fixture
 *                    on the "Guest House" today card where Employee is
 *                    the claimer. After tapping Start on that card, the
 *                    claimer-workday dialog fires; clicking "Start
 *                    workday & continue" then trips the team-workday
 *                    pre-check on Admin Worker.)
 *   CONTRACTOR_ID  → PAUSED (started 4h ago, paused 30m ago, 12m prior pause)
 *   TRAINEE_ID     → COMPLETED (8h day with 30m lunch — today's edit window
 *                    is still open so the "Edit times" affordance fires)
 *   ADMIN_WORKER_ID → forgot-yesterday + today IN_PROGRESS (open row from
 *                    yesterday surfaces the orange catch-up strip; the
 *                    today row started ~3h ago and gives the Admin Home
 *                    Team Overview "Workdays in progress" panel a third
 *                    row alongside Michael + Contractor)
 *   MICHAEL_ID     → NOT_STARTED (no row today). The operator account
 *                    starts the day clocked OUT so Work → Home opens on
 *                    the "Prepare for work day" hero, which is hidden
 *                    once someone is on the clock.
 *
 *                    The end-of-day nudge test still works, it just runs
 *                    from the top: start the workday (via the hero or the
 *                    strip), then complete Michael's one scheduled today
 *                    job and remaining hits 0.
 *
 *                    COST OF THIS CHOICE: the title-bar on-the-clock
 *                    bubble no longer opens in a ticking state for the
 *                    signed-in user, and Admin Home → Team Overview
 *                    "Workdays in progress" drops from three rows to two
 *                    (CONTRACTOR paused + ADMIN_WORKER in progress).
 *                    Start the workday to get both back.
 */
async function seedWorkdayFixtures() {
  console.log("  Workday fixtures (one row per state for each seed worker)...");

  const now = new Date();
  const today = etFormatDate(now);
  const yesterday = etFormatDate(daysAgo(1));
  const mins = (n: number) => n * 60 * 1000;
  const hrs = (n: number) => n * 60 * 60 * 1000;

  // ── EMPLOYEE_ID: NOT_STARTED ────────────────────────────────────────
  // Deliberately no row today. This drives the two-stage team-workday
  // gate demo on the "Guest House" card: tapping Start fires the
  // claimer-workday dialog first, and accepting it ("Start workday &
  // continue") then trips the team-workday-check on Admin Worker.

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

  // ── ADMIN_WORKER_ID: IN_PROGRESS today ─────────────────────────────
  // Fresh today workday started ~3h ago. Coexists with the
  // forgot-yesterday row above — realistic scenario for a worker who
  // clocked in this morning without addressing the still-open prior
  // day. Populates the Admin Home Team Overview "Workdays in progress"
  // panel with a third distinct row (Michael IN_PROGRESS ~90m,
  // Contractor PAUSED ~4h, Admin Worker IN_PROGRESS ~3h) so an admin
  // testing can see multiple workers on the clock at once with
  // different durations.
  await prisma.workerWorkday.create({
    data: {
      userId: ADMIN_WORKER_ID,
      workdayDate: today,
      startedAt: new Date(now.getTime() - hrs(3)),
      totalPausedMs: mins(5), // one quick coffee break
    },
  });

  // ── MICHAEL_ID: NOT_STARTED ────────────────────────────────────────
  // Deliberately NO row today, so the operator account lands on Work →
  // Home clocked out and the "Prepare for work day" hero is reachable —
  // it is hidden the moment someone is on the clock.
  //
  // This row used to be IN_PROGRESS (started ~90m ago) to give the
  // title-bar bubble a visibly ticking duration and to let the
  // end-of-day nudge test skip the start-workday preamble. Both still
  // work; they just need the workday started first, which is the path a
  // real worker takes anyway.
  //
  // Michael's open mileage entry (seeded above, "still driving") is left
  // alone: mileage is not gated on an active workday server-side, and
  // an already-open session is what exercises the workflow's
  // `prior-open` step.

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

  // ─── Reverse pass: companion jobs for otherwise-bare workdays ────────
  //
  // The state-only workday fixtures above (Super Workdays approval demo)
  // land on dates that don't necessarily have completed jobs for the same
  // worker. Left alone, that shows up as "workday with 0 jobs" on the
  // Approximate-Pay-Per-Hour card breakdown — the user flagged that as
  // clearly-not-normal seed data.
  //
  // This pass walks every closed workday (all sources), and if the worker
  // has zero qualifying completed jobs on that ET date, spawns a single
  // lightweight companion mow-style occurrence. Uses upsert-style checks
  // to stay idempotent across reseeds. Uses a JobAssigneeDefault as the
  // parent Job when available; otherwise falls back to any Job so the
  // occurrence has a valid parent (property, name, etc.).
  console.log("    Companion-job pass: fill bare workdays with a completed job...");
  const closedWorkdays = await prisma.workerWorkday.findMany({
    where: { endedAt: { not: null } },
    select: { userId: true, workdayDate: true, startedAt: true },
  });
  let companionCreated = 0;
  let companionSkippedNoJob = 0;
  for (const w of closedWorkdays) {
    // ET day bounds — completedAt is a UTC instant; use etMidnight of
    // the workday and etMidnight of the next day as [start, end).
    // DST-safe via the canonical helpers.
    const dayStart = etMidnight(w.workdayDate);
    const dayEnd = etMidnight(etAddDays(w.workdayDate, 1));
    const existingCount = await prisma.jobOccurrence.count({
      where: {
        completedAt: { gte: dayStart, lt: dayEnd },
        workflow: { in: ["STANDARD", "ONE_OFF"] },
        status: { notIn: ["CANCELED", "ARCHIVED"] },
        assignees: {
          some: {
            userId: w.userId,
            OR: [{ role: null }, { role: { not: "observer" } }],
          },
        },
      },
    });
    if (existingCount > 0) continue;

    const defaultAssign = await prisma.jobAssigneeDefault.findFirst({
      where: { userId: w.userId },
      include: { job: { select: { id: true, kind: true } } },
    });
    const jobRow = defaultAssign?.job
      ?? (await prisma.job.findFirst({ select: { id: true, kind: true } }));
    if (!jobRow) {
      companionSkippedNoJob += 1;
      continue;
    }

    const startAt = etInstantFromParts(w.workdayDate, "10:00");
    const completedAt = new Date(startAt.getTime() + 45 * 60 * 1000);
    // Skip if this would land in the future (safety — some fixture
    // arithmetic can produce forward-drifted dates near DST edges).
    if (completedAt.getTime() > Date.now() + 60 * 1000) continue;

    await prisma.jobOccurrence.create({
      data: {
        jobId: jobRow.id,
        kind: jobRow.kind ?? "SINGLE_ADDRESS",
        startAt,
        endAt: completedAt,
        startedAt: startAt,
        completedAt,
        status: "CLOSED",
        workflow: "STANDARD",
        jobTags: '["MOW"]',
        price: 75.0,
        estimatedMinutes: 45,
        completionSplits: [{ userId: w.userId, percent: 100 }],
        assignees: {
          create: [{ userId: w.userId, role: "primary" }],
        },
      },
    });
    companionCreated += 1;
  }
  console.log(
    `    Companion-job pass: created ${companionCreated} occurrences (${companionSkippedNoJob} skipped — no parent Job available).`,
  );
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
  // Fair penny-residual distribution — MUST mirror
  // services/payments.ts → computeBreakdown. Distributes one cent per
  // row, wrapping if the residual magnitude exceeds row count. Keeps
  // max spread between workers on the same split% to 1 cent. If the
  // logic here drifts from payments.ts, seed data won't match what
  // production produces.
  const distributed = rows.reduce((s, r) => s + r.net + r.fee, 0);
  const residualCents = Math.round((N - distributed) * 100);
  if (residualCents !== 0 && rows.length > 0) {
    const sign = residualCents < 0 ? -1 : 1;
    let remaining = Math.abs(residualCents);
    let i = 0;
    while (remaining > 0) {
      const idx = i % rows.length;
      rows[idx].net = Math.round((rows[idx].net + sign * 0.01) * 100) / 100;
      remaining -= 1;
      i += 1;
    }
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
    create: { key: "QB_INCLUDE_CONTRACT_LABOR", value: "true", description: "When ON, qb-journal-expenses.csv emits Contract Labor rows for contractor payment splits. When OFF, the entire Contract Labor section is dropped — appropriate once Gusto's QuickBooks integration is configured to post contractor payments to QB directly. Default ON.", updatedById: MICHAEL_ID },
    update: { description: "When ON, qb-journal-expenses.csv emits Contract Labor rows for contractor payment splits. When OFF, the entire Contract Labor section is dropped — appropriate once Gusto's QuickBooks integration is configured to post contractor payments to QB directly. Default ON." },
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
    // The five "Test City" clients exist to exercise alphabetical ordering,
  // not geography. Deliberately left OUT OF STATE so they also cover the
  // parcel lookup's graceful-degradation path — a property the service
  // has no coverage for should show no icon rather than a broken dialog.
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
        receiptNumber: legacyReceiptNumberFor(occ.id),
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
          receiptNumber: legacyReceiptNumberFor(occ.id),
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

  // ── Approvable-queue invariant ──────────────────────────────────────
  // Every unconfirmed Payment shows up in the admin's PENDING APPROVAL
  // queue, but approvePayment() rejects anything whose occurrence isn't
  // PENDING_PAYMENT ("Occurrence is not pending payment"). A fixture that
  // pairs an unconfirmed payment with a COMPLETED/CLOSED occurrence
  // therefore renders a row the operator can see, click, and never
  // approve — indistinguishable from a real bug in the app.
  //
  // That shipped in the Martinez Cabin fixture and cost real debugging
  // time. Fail the seed rather than hand over a queue with dead rows.
  const unapprovable = await prisma.payment.findMany({
    where: {
      confirmed: false,
      writtenOff: false,
      skippedAt: null,
      occurrence: { status: { not: "PENDING_PAYMENT" } },
    },
    select: {
      amountPaid: true,
      occurrence: {
        select: {
          status: true,
          job: { select: { property: { select: { displayName: true } } } },
        },
      },
    },
  });
  if (unapprovable.length > 0) {
    console.error("Unapprovable pending-approval rows (unconfirmed payment on a non-PENDING_PAYMENT occurrence):");
    for (const u of unapprovable) {
      console.error(
        `  - $${u.amountPaid} on "${u.occurrence?.job?.property?.displayName ?? "?"}" (occurrence is ${u.occurrence?.status})`,
      );
    }
    throw new Error(
      `Seed produced ${unapprovable.length} pending-approval row(s) that can never be approved. ` +
        "Set the occurrence status to PENDING_PAYMENT, or confirm the payment.",
    );
  }
  console.log("✓ Every pending-approval row is actually approvable.");

  // ── Reconcile seeded splits against the FINAL expense totals ────────
  //
  // Expenses are reimbursed off the top before anyone is paid, so a
  // worker's share is computed on (collected − expenses) — see
  // computeBreakdown in services/payments.ts. But expenses arrive from
  // several places in this seed (the per-job list, supply holds, …) and
  // some are created AFTER the payments are. Rather than have the payment
  // loop try to predict them all, recompute once here when everything
  // exists. Idempotent: the pool is derived from amountPaid each time, and
  // the split proportions are scale-invariant.
  const toReconcile = await prisma.payment.findMany({
    where: { writtenOff: false, skippedAt: null },
    include: {
      splits: { include: { user: { select: { workerType: true } } } },
      occurrence: { select: { expenses: { select: { cost: true } } } },
    },
  });
  for (const pay of toReconcile) {
    if (pay.splits.length === 0) continue;
    const expenses = (pay.occurrence?.expenses ?? []).reduce((a, e) => a + e.cost, 0);
    const pool = Math.max(
      0,
      Math.round((pay.amountPaid - pay.tipAmount - pay.overageAmount - expenses) * 100) / 100,
    );
    const basis = pay.splits.map((sp) => sp.grossAmount ?? sp.amount);
    const basisTotal = basis.reduce((a, b) => a + b, 0);
    if (basisTotal <= 0) continue;
    const rows = pay.splits.map((sp, i) => {
      const ratePercent = sp.user?.workerType === "CONTRACTOR" ? 20 : 30;
      const gross = Math.round(pool * (basis[i] / basisTotal) * 100) / 100;
      return { id: sp.id, ratePercent, gross };
    });
    // Hand the rounding residual to the first row so gross sums exactly.
    const grossSum = rows.reduce((a, r) => a + r.gross, 0);
    const residual = Math.round((pool - grossSum) * 100) / 100;
    if (residual !== 0) rows[0].gross = Math.round((rows[0].gross + residual) * 100) / 100;

    let platformFee = 0;
    let margin = 0;
    for (const r of rows) {
      const feeAmount = Math.round(r.gross * r.ratePercent) / 100;
      const netAmount = Math.round((r.gross - feeAmount) * 100) / 100;
      if (r.ratePercent === 20) platformFee += feeAmount;
      else margin += feeAmount;
      await prisma.paymentSplit.update({
        where: { id: r.id },
        data: {
          amount: netAmount,
          grossAmount: r.gross,
          ratePercent: r.ratePercent,
          feeAmount,
          netAmount,
        },
      });
    }
    await prisma.payment.update({
      where: { id: pay.id },
      data: {
        platformFeeAmount: platformFee > 0 ? Math.round(platformFee * 100) / 100 : null,
        platformFeePercent: platformFee > 0 ? 20 : null,
        businessMarginAmount: margin > 0 ? Math.round(margin * 100) / 100 : null,
        businessMarginPercent: margin > 0 ? 30 : null,
      },
    });
  }
  console.log(`✓ Reconciled splits on ${toReconcile.length} payment(s) against final expense totals.`);

  // ── Divergent-basis fixtures: give dev the PRODUCTION shape ─────────
  //
  // Everything above writes agreeing columns: `amount`, `netAmount` and
  // `grossAmount − feeAmount` all land on the same number, because the
  // seed computes one basis (the invoice) and stores it everywhere.
  //
  // Production does not look like that on an overpaid job.
  // `reconcileApproval` computes the ACTUAL breakdown on everything the
  // client handed over — the tip included — and stores it in
  // grossAmount/feeAmount/netAmount, while `amount` keeps the PROMISED net
  // from the invoice snapshot, because employees don't share in an
  // overpayment. The two bases diverge and the payment card has to know
  // which one to render.
  //
  // No dev row could reproduce that, which is how a card rendering
  // "$63.00 share − $22.05 margin = $51.45" against a real payout of
  // $44.62 shipped under a green e2e suite. So re-stamp the flagged
  // fixtures here, AFTER the expense reconciler (which would otherwise
  // immediately undo it): promisedPayouts from the settled invoice basis,
  // gross/fee/net moved onto the collected basis, `amount` untouched.
  // Which fixtures? Exactly the ones where the client paid more than the
  // invoice — designated a tip or not. That IS the condition under which
  // production's two bases diverge, so it needs no separate flag.
  const divergent = await prisma.payment.findMany({
    where: { writtenOff: false, skippedAt: null, OR: [{ tipAmount: { gt: 0 } }, { overageAmount: { gt: 0 } }] },
    include: {
      splits: { include: { user: { select: { workerType: true } } } },
      occurrence: { select: { id: true, expenses: { select: { cost: true } } } },
    },
  });
  for (const pay of divergent) {
    const occId = pay.occurrence?.id;
    if (!occId || pay.splits.length === 0) continue;
    const expenses = (pay.occurrence?.expenses ?? []).reduce((a, e) => a + e.cost, 0);
    // The invoice basis, as just settled by the reconciler.
    const invoicePool = pay.splits.reduce((a, sp) => a + (sp.grossAmount ?? sp.amount), 0);
    if (invoicePool <= 0) continue;
    // Everything the client handed over, which is what production's actual
    // breakdown is computed on.
    const actualPool = Math.max(0, Math.round((pay.amountPaid - expenses) * 100) / 100);

    await prisma.jobOccurrence.update({
      where: { id: occId },
      data: {
        promisedPayouts: pay.splits.map((sp) => ({
          userId: sp.userId,
          workerType: sp.user?.workerType ?? "EMPLOYEE",
          gross: sp.grossAmount ?? sp.amount,
          ratePercent: sp.ratePercent ?? 30,
          fee: sp.feeAmount ?? 0,
          net: sp.amount,
          splitPercent: Math.round(((sp.grossAmount ?? sp.amount) / invoicePool) * 100),
        })),
      },
    });

    for (const sp of pay.splits) {
      const share = (sp.grossAmount ?? sp.amount) / invoicePool;
      const gross = Math.round(actualPool * share * 100) / 100;
      const fee = Math.round(gross * (sp.ratePercent ?? 30)) / 100;
      await prisma.paymentSplit.update({
        where: { id: sp.id },
        // `amount` is deliberately NOT touched — it stays the promised net.
        data: { grossAmount: gross, feeAmount: fee, netAmount: Math.round((gross - fee) * 100) / 100 },
      });
    }
  }
  console.log(`✓ Stamped the production two-basis shape on ${divergent.length} overpaid fixture(s).`);

  // ── Write-off fixture: the shortfall shape ──────────────────────────────
  //
  // When a client never pays, the employee is still made whole under the
  // guarantee policy: the payment goes to $0, the worker keeps their promised
  // net as a `topUpAmount`, and the uncollected money is booked as
  // `shortfallAmount` — which the conservation identity SUBTRACTS.
  //
  // Dev had ZERO payments in this shape, so nothing could catch a money card
  // that forgets the shortfall term. One did: the job-card reconciliation
  // line omitted it and rendered a red "Unaccounted" warning on all 12 such
  // payments in production, while the e2e stayed green. Same gap that hid the
  // two-basis bug — the seed only ever produced the happy path.
  const woTarget = await prisma.payment.findFirst({
    where: {
      confirmed: true, writtenOff: false, skippedAt: null,
      tipAmount: 0, overageAmount: 0,
      splits: { some: {} },
      occurrence: { status: "CLOSED", expenses: { none: {} } },
    },
    include: { splits: true },
    orderBy: { id: "asc" },
  });
  if (woTarget) {
    const splitTotal = woTarget.splits.reduce((a, b) => a + b.amount, 0);
    const business = (woTarget.platformFeeAmount ?? 0) + (woTarget.businessMarginAmount ?? 0);
    // shortfall = everything that was promised but never collected, so
    // splits + business − shortfall = 0 = amountPaid.
    const shortfall = Math.round((splitTotal + business) * 100) / 100;
    await prisma.payment.update({
      where: { id: woTarget.id },
      data: {
        amountPaid: 0, grossCharged: 0, netReceived: 0,
        processorFeeAmount: 0,
        writtenOff: true, writtenOffAt: new Date(), writtenOffById: MICHAEL_ID,
        writeOffReason: "Client never paid — worker made whole per guarantee policy",
        shortfallAmount: shortfall,
      },
    });
    // Workers keep their promised net; the business funded it, so the money
    // moves from job pay (gross/fee) to a top-up.
    for (const sp of woTarget.splits) {
      await prisma.paymentSplit.update({
        where: { id: sp.id },
        data: { grossAmount: 0, feeAmount: 0, netAmount: 0, topUpAmount: sp.amount },
      });
    }
    console.log(`✓ Seeded the write-off / shortfall shape ($${shortfall.toFixed(2)}) on 1 payment.`);
  } else {
    console.log("!! No eligible payment for the write-off fixture — shortfall rendering is UNTESTED.");
  }

  // ── Payment conservation invariant ──────────────────────────────────
  // Every dollar a client paid must be accounted for exactly once:
  //
  //   amountPaid = Σ split.amount (NET) + Σ split.tipAmount
  //              + platformFeeAmount + businessMarginAmount
  //              + tipToBusinessAmount + overageAmount
  //              − shortfallAmount + expenses
  //
  // This is the same identity the payments build gate fuzzes against the
  // reconciler; asserting it on seeded ROWS catches the other failure mode:
  // a fixture that hand-writes split amounts in the wrong basis.
  //
  // That shipped — the seed stored each worker's GROSS share in
  // `split.amount` while also recording the fee, so a $350 payment rendered
  // "TOTAL TO WORKERS $350" beside "business kept $95". The card was right;
  // the data was contradictory. Fail the seed rather than ship numbers that
  // make the app look broken.
  const allPayments = await prisma.payment.findMany({
    where: { writtenOff: false, skippedAt: null },
    select: {
      amountPaid: true, platformFeeAmount: true, businessMarginAmount: true,
      tipAmount: true, tipToBusinessAmount: true, overageAmount: true,
      shortfallAmount: true,
      splits: { select: { amount: true, tipAmount: true } },
      occurrence: {
        select: {
          expenses: { select: { cost: true } },
          job: { select: { property: { select: { displayName: true } } } },
        },
      },
    },
  });
  const drift: string[] = [];
  for (const pay of allPayments) {
    if (pay.splits.length === 0) continue; // unapproved rows have no splits yet
    const nets = pay.splits.reduce((a, b) => a + b.amount, 0);
    const tips = pay.splits.reduce((a, b) => a + b.tipAmount, 0);
    const expenses = (pay.occurrence?.expenses ?? []).reduce((a, e) => a + e.cost, 0);
    const accounted =
      nets + tips + (pay.platformFeeAmount ?? 0) + (pay.businessMarginAmount ?? 0) +
      pay.tipToBusinessAmount + pay.overageAmount - pay.shortfallAmount + expenses;
    if (Math.abs(accounted - pay.amountPaid) >= 0.02) {
      drift.push(
        `  - "${pay.occurrence?.job?.property?.displayName ?? "?"}": paid $${pay.amountPaid.toFixed(2)} ` +
          `but accounted $${accounted.toFixed(2)} ` +
          `(workers $${nets.toFixed(2)} + tips $${tips.toFixed(2)} + fee $${(pay.platformFeeAmount ?? 0).toFixed(2)} ` +
          `+ margin $${(pay.businessMarginAmount ?? 0).toFixed(2)} + tipToBiz $${pay.tipToBusinessAmount.toFixed(2)} ` +
          `+ overage $${pay.overageAmount.toFixed(2)} + expenses $${expenses.toFixed(2)})`,
      );
    }
  }
  if (drift.length > 0) {
    console.error("Payment conservation violations — these render as self-contradicting money cards:");
    for (const d of drift) console.error(d);
    throw new Error(`Seed produced ${drift.length} payment(s) whose money doesn't add up.`);
  }
  console.log(`✓ Payment conservation holds across ${allPayments.length} payment(s).`);

  // ── Job-portion invariant ───────────────────────────────────────────
  // Conservation alone isn't enough: a fixture can account for every dollar
  // of the PAYMENT while still splitting the wrong pool. The Harrington tip
  // fixture did exactly that — an $85 job whose splits summed to $105 — and
  // every dollar balanced. The workers were simply being paid on a job that
  // didn't cost that much, which made the card read as nonsense.
  //
  //   amountPaid − tip − overage + shortfall  ==  invoice (price + add-ons)
  const jobPortionDrift: string[] = [];
  const payRows = await prisma.payment.findMany({
    where: { writtenOff: false, skippedAt: null },
    select: {
      amountPaid: true, tipAmount: true, overageAmount: true, shortfallAmount: true,
      splits: { select: { id: true } },
      occurrence: {
        select: {
          price: true,
          addons: { select: { price: true } },
          job: { select: { property: { select: { displayName: true } } } },
        },
      },
    },
  });
  for (const pay of payRows) {
    if (pay.splits.length === 0) continue;
    const occ = pay.occurrence;
    if (!occ || occ.price == null) continue;
    const invoice = occ.price + (occ.addons ?? []).reduce((a, x) => a + (x.price ?? 0), 0);
    const jobPortion = Math.round((pay.amountPaid - pay.tipAmount - pay.overageAmount + pay.shortfallAmount) * 100) / 100;
    if (Math.abs(jobPortion - invoice) >= 0.02) {
      jobPortionDrift.push(
        `  - "${occ.job?.property?.displayName ?? "?"}": invoice $${invoice.toFixed(2)} but job portion is ` +
          `$${jobPortion.toFixed(2)} (paid $${pay.amountPaid.toFixed(2)} − tip $${pay.tipAmount.toFixed(2)} ` +
          `− overage $${pay.overageAmount.toFixed(2)} + shortfall $${pay.shortfallAmount.toFixed(2)})`,
      );
    }
  }
  if (jobPortionDrift.length > 0) {
    console.error("Job-portion violations — workers are being paid on a pool that isn't the invoice:");
    for (const d of jobPortionDrift) console.error(d);
    throw new Error(`Seed produced ${jobPortionDrift.length} payment(s) whose job portion doesn't match the invoice.`);
  }
  console.log("✓ Job portion matches the invoice on every payment.");
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
    default:
      console.error(
        `Unknown template: ${template}. Available: default, payments-clean, payments-active`,
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

/**
 * Education-guide fixtures. See docs/features/education.md.
 *
 * Deliberately exercises all three visible states so the review queue,
 * the alert badge and the worker catalog all have something in them on a
 * fresh seed — an empty feature is indistinguishable from a broken one.
 */
/**
 * Upload the guide-media fixtures to R2 and create their GuideAsset rows.
 *
 * Deterministic keys (`guides/seed/<filename>`) rather than a UUID per
 * run: a reseed overwrites the same five objects instead of leaving the
 * previous run's bytes orphaned in the bucket, since seed cleanup drops
 * the GuideAsset rows and nothing would ever point at the old keys again.
 *
 * Returns filename → asset id so the markdown below can reference the
 * real ids. Guide bodies store `guide-asset:<id>` tokens, never URLs, so
 * they have to be built AFTER the rows exist.
 *
 * Returns an empty map when R2 isn't configured. Guides then seed as
 * text-only rather than failing the whole seed — a new dev environment
 * should come up before its object storage does.
 */
async function seedGuideAssets(): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  if (!process.env.R2_GUIDE_MEDIA_BUCKET_NAME) {
    console.log("  guides: R2_GUIDE_MEDIA_BUCKET_NAME unset — seeding guides without media");
    return ids;
  }

  const { readFileSync } = require("fs") as typeof import("fs");
  const { join } = require("path") as typeof import("path");
  const { getUploadUrl } = require("../src/lib/r2") as typeof import("../src/lib/r2");

  const FIXTURES: Array<{ file: string; type: string; kind: "IMAGE" | "VIDEO"; alt: string }> = [
    { file: "mowing-heights.png", type: "image/png", kind: "IMAGE", alt: "Bar chart of cutting heights by grass type" },
    { file: "fertilizer-calendar.png", type: "image/png", kind: "IMAGE", alt: "Twelve-month feeding calendar for warm-season grass" },
    { file: "trimmer-line.png", type: "image/png", kind: "IMAGE", alt: "Five steps for replacing bump-feed trimmer line" },
    { file: "ppe-checklist.png", type: "image/png", kind: "IMAGE", alt: "Pre-start safety checklist" },
    { file: "grass-id-chart.png", type: "image/png", kind: "IMAGE", alt: "Comparison of nine grass species: blade shape, growth habit, mowing height, and sun and shade tolerance" },
    { file: "striping-demo.webm", type: "video/webm", kind: "VIDEO", alt: "Two-pass striping demonstration" },
  ];

  for (const f of FIXTURES) {
    const bytes = readFileSync(join(__dirname, "fixtures", "guides", f.file));
    const r2Key = `guides/seed/${f.file}`;
    try {
      const url = await getUploadUrl(r2Key, f.type, 900, "guide-media");
      const res = await fetch(url, {
        method: "PUT",
        headers: { "Content-Type": f.type },
        body: new Uint8Array(bytes),
      });
      if (!res.ok) throw new Error(`R2 PUT ${res.status}`);
    } catch (err: any) {
      console.log(`  guides: upload of ${f.file} failed (${err?.message ?? err}) — skipping its media`);
      continue;
    }
    const asset = await prisma.guideAsset.create({
      data: {
        kind: f.kind,
        r2Key,
        contentType: f.type,
        originalFilename: f.file,
        // The real byte count, same as the app stores after reading it
        // back from R2. Nothing here is guessed.
        sizeBytes: bytes.length,
        altText: f.alt,
        uploadedById: MICHAEL_ID,
      },
    });
    ids.set(f.file, asset.id);
  }
  console.log(`  guides: ${ids.size} media asset(s) uploaded`);
  return ids;
}

async function seedGuides() {
  const digest = (md: string) =>
    require("crypto").createHash("sha256").update(md, "utf8").digest("hex");

  const media = await seedGuideAssets();
  /** Image markdown for a fixture, or "" when media isn't available. */
  const img = (file: string, caption: string) => {
    const id = media.get(file);
    return id ? `![${caption}](guide-asset:${id})\n\n` : "";
  };
  /** Video directive for a fixture, or "" when media isn't available. */
  const vid = (file: string) => {
    const id = media.get(file);
    return id ? `:::video guide-asset:${id}\n\n` : "";
  };

  const bermuda = `# Fertilizing Bermuda grass

Bermuda is a **warm-season** grass. Feed it when it is actively growing —
not before green-up, or you are feeding the weeds.

## When

${img("fertilizer-calendar.png", "Feeding calendar for warm-season grass")}| Month | What |
| --- | --- |
| Apr–May | First feed once fully green |
| Jun–Aug | Every 4–6 weeks |
| Sep | Last feed — stop 6 weeks before first frost |

## Rate

Aim for **1 lb of nitrogen per 1,000 sq ft** per application. More is not
better: excess nitrogen produces soft growth that scalps easily and invites
disease.

## On the job

1. Mow first, and bag the clippings if the lawn is thatchy.
2. Spread in two passes at right angles — one heavy pass stripes the lawn.
3. Water in with about a quarter inch unless rain is due.

Mow before you feed — see [mowing heights by grass type](guide:mowing-heights-by-grass-type),
and run the [pre-start check](guide:before-you-start-the-mower) first.

> Never apply to a drought-stressed lawn. Water it, wait a day, then feed.

## Two passes, not one

${vid("striping-demo.webm")}The second pass runs at right angles to the first. Stripes show because
the blades end up lying in opposite directions — not because the grass is
a different height.
`;

  const mowing = `# Mowing heights by grass type

Cutting too short is the most common cause of a lawn we get called back to.

${img("mowing-heights.png", "Cutting height by grass type")}- **Bermuda** — 1 to 2 inches
- **Zoysia** — 1 to 2.5 inches
- **Tall fescue** — 3 to 4 inches
- **St. Augustine** — 3.5 to 4 inches

Never remove more than **one third** of the blade in a single cut. If the
lawn got away from you, come down over two visits.
`;

  const trimmer = `# Trimmer line replacement

Bump-feed head, 0.095" line, about 20 feet.

${img("trimmer-line.png", "Five steps for replacing bump-feed trimmer line")}Wind in the direction of the arrow on the spool. Winding it backwards is
why line jams on the next bump, and it is the mistake almost everyone
makes once.

> If the line welds itself together inside the head, it was wound too
> tight.
`;

  const safety = `# Before you start the mower

${img("ppe-checklist.png", "Pre-start safety checklist")}Walk the yard first. A stone thrown by a mower deck travels faster than a
golf ball off a driver, and the things that get thrown are almost always
the things nobody looked for: a hose fitting, a dog's chew toy, the head
of a sprinkler.

## If you are not sure

Stop and ask. Nothing on a lawn is worth an eye.
`;

  const overseeding = `# Winter overseeding

Ryegrass over dormant Bermuda keeps a lawn green through the winter.

Seed at 5 to 10 lbs per 1,000 sq ft once soil temperatures are steadily
below 65°F.

Mow low and bag the clippings first so the seed reaches soil.
`;

  const g1 = await prisma.guide.create({
    data: {
      slug: "fertilizing-bermuda-grass",
      title: "Fertilizing Bermuda grass",
      summary: "When to feed, how much, and the mistakes that burn a lawn.",
      categoryKey: "lawn-care",
      tags: ["bermuda", "fertilizer", "warm-season"],
      createdById: MICHAEL_ID,
      versions: {
        create: {
          versionNumber: 1,
          contentMarkdown: bermuda,
          contentDigest: digest(bermuda),
          changeNote: "Initial guide",
          status: "PUBLISHED",
          createdById: MICHAEL_ID,
          approvedById: MICHAEL_ID,
          approvedAt: new Date(),
          publishedById: MICHAEL_ID,
          publishedAt: new Date(),
        },
      },
    },
    include: { versions: true },
  });
  await prisma.guide.update({
    where: { id: g1.id },
    data: { currentVersionId: g1.versions[0].id },
  });

  // Pending — this is what puts a row in the Super review queue and a
  // count on the alert badge.
  await prisma.guide.create({
    data: {
      slug: "mowing-heights-by-grass-type",
      title: "Mowing heights by grass type",
      summary: "How low to go, per species — and why scalping causes callbacks.",
      categoryKey: "lawn-care",
      tags: ["mowing", "heights"],
      createdById: ADMIN_WORKER_ID,
      versions: {
        create: {
          versionNumber: 1,
          contentMarkdown: mowing,
          contentDigest: digest(mowing),
          changeNote: "First draft for review",
          status: "PENDING_APPROVAL",
          createdById: ADMIN_WORKER_ID,
          submittedById: ADMIN_WORKER_ID,
          submittedAt: new Date(),
        },
      },
    },
  });

  // Bare draft — never submitted. Visible to authors, invisible to workers.
  await prisma.guide.create({
    data: {
      slug: "trimmer-line-replacement",
      title: "Trimmer line replacement",
      summary: null,
      categoryKey: "equipment",
      tags: ["trimmer"],
      createdById: ADMIN_WORKER_ID,
      versions: {
        create: {
          versionNumber: 1,
          contentMarkdown: trimmer,
          contentDigest: digest(trimmer),
          changeNote: "Initial draft",
          status: "DRAFT",
          createdById: ADMIN_WORKER_ID,
        },
      },
    },
  });

  // Published safety guide — a second published page, so the worker
  // catalog has more than one row and the category grouping is visible.
  const g2 = await prisma.guide.create({
    data: {
      slug: "before-you-start-the-mower",
      title: "Before you start the mower",
      summary: "The pre-start check, every job, every time.",
      categoryKey: "safety",
      tags: ["safety", "ppe", "mower"],
      createdById: MICHAEL_ID,
      versions: {
        create: {
          versionNumber: 1,
          contentMarkdown: safety,
          contentDigest: digest(safety),
          changeNote: "Initial guide",
          status: "PUBLISHED",
          createdById: MICHAEL_ID,
          approvedById: MICHAEL_ID,
          approvedAt: new Date(),
          publishedById: MICHAEL_ID,
          publishedAt: new Date(),
        },
      },
    },
    include: { versions: true },
  });
  await prisma.guide.update({
    where: { id: g2.id },
    data: { currentVersionId: g2.versions[0].id },
  });

  // Sent back by a Super — the REJECTED state, which is ours and not
  // policies'. Without a fixture the author-facing rejection note and its
  // "edit to return to draft" path never get exercised.
  await prisma.guide.create({
    data: {
      slug: "winter-overseeding",
      title: "Winter overseeding",
      summary: "Ryegrass over dormant Bermuda.",
      categoryKey: "lawn-care",
      tags: ["overseeding", "ryegrass"],
      createdById: ADMIN_WORKER_ID,
      versions: {
        create: {
          versionNumber: 1,
          contentMarkdown: overseeding,
          contentDigest: digest(overseeding),
          changeNote: "First pass",
          status: "REJECTED",
          createdById: ADMIN_WORKER_ID,
          submittedById: ADMIN_WORKER_ID,
          submittedAt: new Date(),
          rejectedById: MICHAEL_ID,
          rejectedAt: new Date(),
          rejectionNote:
            "Seeding rate is for the transition zone — use the NC number, and say what happens to the Bermuda underneath.",
        },
      },
    },
  });

  // Archived — the only state from which a permanent delete is allowed,
  // so without one the purge path can't be reached in the UI at all.
  await prisma.guide.create({
    data: {
      slug: "old-billing-walkthrough",
      title: "Old billing walkthrough",
      summary: "Superseded by the current invoicing flow.",
      categoryKey: "admin",
      tags: ["billing"],
      createdById: MICHAEL_ID,
      archivedById: MICHAEL_ID,
      archivedAt: new Date(),
      versions: {
        create: {
          versionNumber: 1,
          contentMarkdown: "# Old billing walkthrough\n\nSuperseded. Kept only so the archive has something in it.\n",
          contentDigest: digest("# Old billing walkthrough\n\nSuperseded. Kept only so the archive has something in it.\n"),
          changeNote: "Archived",
          status: "ROLLED_BACK",
          createdById: MICHAEL_ID,
        },
      },
    },
  });

  // A broad reference guide — deliberately the longest fixture. It exercises
  // the reader's long-form rendering (tables, nested headings, a long body)
  // in a way the short fixtures above don't.
  const grassTypes = `# Grass types at a glance

North Carolina sits in the **transition zone** — the band where it gets
too hot for northern grasses and too cold for southern ones. That is why
we service both families, sometimes on the same street, and why the same
job can call for two different mowing heights.

Get the species right before you touch anything. Height, feeding, and
watering all follow from it, and the most expensive mistakes on a lawn
start with treating one type like the other.

## The two families

**Warm-season** grasses grow from late spring through summer and go
**dormant** — tan, straw-colored, but alive — after the first hard frost.
They love heat and full sun.

**Cool-season** grasses do their growing in spring and fall. They stay
green through winter and struggle in July and August, when heat and
drought stress them.

${img("grass-id-chart.png", "All nine species compared: blade, growth habit, height, sun and shade")}
Blade width and growth habit are what actually identify a grass in the
field — from standing height every lawn is just green. Get down and look
at a single blade.

## Warm-season types

### Bermuda
The default for full-sun lawns and athletic fields. Spreads aggressively
by both above-ground runners and underground rhizomes, so it repairs its
own damage and creeps into flower beds if the edges are not kept.

- Mow **1–2"**. It thrives on low, frequent cuts.
- No real shade tolerance — thin, patchy Bermuda under a tree is a light
  problem, not a fertilizer problem.
- Excellent traffic tolerance.

### Zoysia
Dense enough that weeds have trouble establishing. Slow to fill in, which
makes repairs expensive, so treat established zoysia carefully.

- Mow **1–2"**.
- Takes more shade than Bermuda, though not as much as St. Augustine.
- Builds thatch — expect to dethatch more often than on Bermuda.

### Centipede
The low-input lawn. Wants acidic soil, little fertilizer, and to be left
alone.

- Mow **1.5–2"**.
- **Do not over-fertilize.** Pushing centipede with nitrogen causes
  "centipede decline" — it greens up, then dies back the following
  spring. On centipede, doing less is doing the job right.
- Poor traffic tolerance; slow to recover.

### St. Augustine
Coastal lawns. Wide, coarse blades and the best shade tolerance of the
warm-season grasses.

- Mow **2.5–4"** — the tallest of the warm-season group.
- Not cold hardy; winter kill happens inland.
- Watch for chinch bugs in hot, dry spells.

### Bahia
Coarse and thin-looking by design. Common on large lots, roadsides, and
anywhere irrigation is not happening.

- Mow **3–4"**.
- Very drought tolerant, very low input.
- Sends up tall seed heads fast — it can look unmown three days after a
  cut, which is worth telling the client before they call about it.

## Cool-season types

### Tall fescue
The workhorse for most of the Piedmont and the mountains. Deep roots make
it the most heat-tolerant of the cool-season grasses.

- Mow **3–4"**. Taller in summer shades its own roots and helps it hold.
- **Bunch-forming — it does not repair itself.** A bare spot in fescue
  stays a bare spot until someone seeds it. This is the single biggest
  practical difference from Bermuda.
- Overseed in fall, not spring.

### Kentucky bluegrass
Spreads by rhizomes, so unlike fescue it does self-repair. Usually seen
blended into fescue rather than on its own here.

- Mow **2.5–3.5"**.
- Needs more water than fescue and browns out sooner in summer.

### Perennial ryegrass
Germinates faster than anything else we use, which is what makes it the
overseeding grass for dormant Bermuda.

- Mow **1.5–2.5"**.
- Short-lived in our summers — treat winter overseeding as temporary
  color, not a permanent lawn.

### Fine fescues
Creeping red, chewings, and hard fescue. The shade-and-neglect group.

- Mow **2.5–4"**.
- Best shade tolerance of anything on this list.
- Poor traffic tolerance — not for play areas or dog runs.

## Mowing heights, all together

| Grass | Family | Height | Notes |
| --- | --- | --- | --- |
| Bermuda | Warm | 1–2" | Full sun only |
| Zoysia | Warm | 1–2" | Slow to repair |
| Centipede | Warm | 1.5–2" | Do not push with nitrogen |
| St. Augustine | Warm | 2.5–4" | Coastal, shade tolerant |
| Bahia | Warm | 3–4" | Fast seed heads |
| Tall fescue | Cool | 3–4" | Does not self-repair |
| Kentucky bluegrass | Cool | 2.5–3.5" | Thirsty |
| Perennial ryegrass | Cool | 1.5–2.5" | Overseeding only |
| Fine fescues | Cool | 2.5–4" | Shade, low traffic |

## Rules that apply to every lawn

**The one-third rule.** Never remove more than a third of the blade in a
single cut. If the lawn got away from us, cut it high, wait a few days,
and cut again. Scalping a lawn to catch up stresses the roots and is a
reliable way to earn a callback.

**Brown is not always dead.** Tan Bermuda or zoysia in January is
dormant and normal — do not let a client talk us into "fixing" it. Brown
fescue in August may be dormant *or* dead, and telling the difference
takes a look at the crowns, not the blades.

**Sharp blades.** A dull blade tears rather than cuts, and the frayed
tips brown within a day. If a lawn looks off-color right after a cut,
the blade is the first thing to check.

## When you are not sure

Photograph the lawn and ask before cutting. Guessing the species and
mowing an inch too low is not something we can undo — it takes a season
to grow back.
`;

  const grassGuide = await prisma.guide.create({
    data: {
      slug: "grass-types-at-a-glance",
      title: "Grass types at a glance",
      summary:
        "Every species we service, warm- and cool-season, with mowing heights and the mistakes each one punishes.",
      categoryKey: "lawn-care",
      tags: ["grass", "species", "mowing", "reference", "warm-season", "cool-season"],
      createdById: MICHAEL_ID,
      versions: {
        create: {
          versionNumber: 1,
          contentMarkdown: grassTypes,
          contentDigest: digest(grassTypes),
          changeNote: "Initial reference guide",
          status: "PUBLISHED",
          createdById: MICHAEL_ID,
          approvedById: MICHAEL_ID,
          approvedAt: new Date(),
          publishedById: MICHAEL_ID,
          publishedAt: new Date(),
        },
      },
    },
    include: { versions: true },
  });
  await prisma.guide.update({
    where: { id: grassGuide.id },
    data: { currentVersionId: grassGuide.versions[0].id },
  });
}
