import { PrismaClient } from "@prisma/client";
import { PrismaNeon } from "@prisma/adapter-neon";
import { neonConfig } from "@neondatabase/serverless";
import ws from "ws";

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
  await prisma.paymentSplit.deleteMany();
  await prisma.expense.deleteMany();
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
  await prisma.jobSchedule.deleteMany();

  console.log("  Clearing jobs...");
  await prisma.job.deleteMany();

  console.log("  Clearing equipment...");
  await prisma.checkout.deleteMany();
  await prisma.equipment.deleteMany();

  console.log("  Clearing properties...");
  await prisma.property.deleteMany();

  console.log("  Clearing contacts...");
  await prisma.clientContact.deleteMany();

  console.log("  Clearing clients...");
  await prisma.client.deleteMany();

  console.log("  Clearing audit log...");
  await prisma.auditEvent.deleteMany();

  console.log("  Done. (User, UserRole, Setting preserved)");
}

// ── Seed database ───────────────────────────────────────────────────────────
async function seedDatabase() {
  // ── Clients (12) ──────────────────────────────────────────────────────────
  console.log("  Creating clients...");

  const vipClient = await prisma.client.create({
    data: { type: "PERSON", displayName: "Harrington Estate", isVip: true, vipReason: "Long-time client, premium service tier", notesInternal: "Gate code: 4821" },
  });
  const martinezFamily = await prisma.client.create({
    data: { type: "PERSON", displayName: "Martinez Family" },
  });
  const willowbrookHoa = await prisma.client.create({
    data: { type: "COMMUNITY", displayName: "Willowbrook HOA", notesInternal: "Board contact: Susan" },
  });
  const chenResidence = await prisma.client.create({
    data: { type: "PERSON", displayName: "Chen Residence" },
  });
  const vipThompson = await prisma.client.create({
    data: { type: "PERSON", displayName: "Thompson Manor", isVip: true, vipReason: "Referral source - sends 3+ clients/year" },
  });
  const obrienFamily = await prisma.client.create({
    data: { type: "PERSON", displayName: "O'Brien Family", notesInternal: "Dog in backyard, latch gate before entering" },
  });
  const sunriseHoa = await prisma.client.create({
    data: { type: "COMMUNITY", displayName: "Sunrise Meadows HOA", notesInternal: "Monthly board meeting first Tuesday" },
  });
  const patelResidence = await prisma.client.create({
    data: { type: "PERSON", displayName: "Patel Residence" },
  });
  const riverBend = await prisma.client.create({
    data: { type: "ORGANIZATION", displayName: "River Bend Office Park", notesInternal: "Property manager onsite M-F" },
  });
  const kimResidence = await prisma.client.create({
    data: { type: "PERSON", displayName: "Kim Residence" },
  });
  const garciaFamily = await prisma.client.create({
    data: { type: "PERSON", displayName: "Garcia Family", status: "PAUSED", notesInternal: "Paused for winter, resume March" },
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

  const mower1 = await prisma.equipment.create({
    data: { type: "Mower", brand: "Scag", model: "V-Ride II 52\"", shortDesc: "Commercial stand-on mower", status: "CHECKED_OUT", energy: "Gas", dailyRate: 75.0, requiresInsurance: true, qrSlug: "scag-vride-001" },
  });
  const mower2 = await prisma.equipment.create({
    data: { type: "Mower", brand: "Scag", model: "V-Ride II 48\"", shortDesc: "Commercial stand-on mower (compact)", status: "AVAILABLE", energy: "Gas", dailyRate: 70.0, requiresInsurance: true, qrSlug: "scag-vride-002" },
  });
  const mower3 = await prisma.equipment.create({
    data: { type: "Mower", brand: "Honda", model: "HRN216VKA", shortDesc: "21\" push mower", status: "MAINTENANCE", energy: "Gas", dailyRate: 25.0, qrSlug: "honda-hrn216-001", issues: "Blade needs sharpening" },
  });
  const mower4 = await prisma.equipment.create({
    data: { type: "Mower", brand: "Toro", model: "TimeCutter 42\"", shortDesc: "Zero-turn residential mower", status: "AVAILABLE", energy: "Gas", dailyRate: 50.0, qrSlug: "toro-tc42-001" },
  });
  const trimmer1 = await prisma.equipment.create({
    data: { type: "Trimmer", brand: "Stihl", model: "FS 131", shortDesc: "Professional string trimmer", status: "AVAILABLE", energy: "Gas", dailyRate: 15.0, qrSlug: "stihl-fs131-001" },
  });
  const trimmer2 = await prisma.equipment.create({
    data: { type: "Trimmer", brand: "Stihl", model: "FS 91 R", shortDesc: "Lightweight string trimmer", status: "CHECKED_OUT", energy: "Gas", dailyRate: 12.0, qrSlug: "stihl-fs91r-001" },
  });
  const trimmer3 = await prisma.equipment.create({
    data: { type: "Trimmer", brand: "Stihl", model: "HS 82", shortDesc: "30\" hedge trimmer", status: "AVAILABLE", energy: "Gas", dailyRate: 15.0, qrSlug: "stihl-hs82-001" },
  });
  const blower1 = await prisma.equipment.create({
    data: { type: "Blower", brand: "Echo", model: "PB-8010T", shortDesc: "Backpack blower", status: "CHECKED_OUT", energy: "Gas", dailyRate: 20.0, qrSlug: "echo-pb8010t-001" },
  });
  const blower2 = await prisma.equipment.create({
    data: { type: "Blower", brand: "Stihl", model: "BR 800 C-E", shortDesc: "Backpack blower (heavy duty)", status: "AVAILABLE", energy: "Gas", dailyRate: 22.0, qrSlug: "stihl-br800-001" },
  });
  const blower3 = await prisma.equipment.create({
    data: { type: "Blower", brand: "Echo", model: "PB-580T", shortDesc: "Backpack blower (mid-range)", status: "CHECKED_OUT", energy: "Gas", dailyRate: 18.0, qrSlug: "echo-pb580t-001" },
  });
  const edger1 = await prisma.equipment.create({
    data: { type: "Edger", brand: "Stihl", model: "FC 91", shortDesc: "Professional edger", status: "AVAILABLE", energy: "Gas", dailyRate: 15.0, qrSlug: "stihl-fc91-001" },
  });
  const edger2 = await prisma.equipment.create({
    data: { type: "Edger", brand: "Echo", model: "PE-2620", shortDesc: "Stick edger", status: "AVAILABLE", energy: "Gas", dailyRate: 12.0, qrSlug: "echo-pe2620-001" },
  });
  const chainsawEquip = await prisma.equipment.create({
    data: { type: "Chainsaw", brand: "Stihl", model: "MS 271", shortDesc: "20\" farm & ranch chainsaw", status: "AVAILABLE", energy: "Gas", dailyRate: 30.0, requiresInsurance: true, qrSlug: "stihl-ms271-001" },
  });
  const aerator = await prisma.equipment.create({
    data: { type: "Aerator", brand: "Billy Goat", model: "AE401H", shortDesc: "19\" reciprocating aerator", status: "AVAILABLE", energy: "Gas", dailyRate: 45.0, qrSlug: "billygoat-ae401-001" },
  });
  const spreader = await prisma.equipment.create({
    data: { type: "Spreader", brand: "Lesco", model: "101186", shortDesc: "80lb broadcast spreader", status: "AVAILABLE", energy: "Manual", dailyRate: 10.0, qrSlug: "lesco-101186-001" },
  });
  const trailer = await prisma.equipment.create({
    data: { type: "Trailer", brand: "Big Tex", model: "35SA", shortDesc: "12ft single-axle utility trailer", status: "CHECKED_OUT", energy: "N/A", dailyRate: 35.0, qrSlug: "bigtex-35sa-001" },
  });
  const pressureWasher = await prisma.equipment.create({
    data: { type: "Pressure Washer", brand: "Simpson", model: "MSH3125", shortDesc: "3100 PSI gas pressure washer", status: "AVAILABLE", energy: "Gas", dailyRate: 40.0, qrSlug: "simpson-msh3125-001" },
  });
  const wheelbarrow = await prisma.equipment.create({
    data: { type: "Wheelbarrow", brand: "Jackson", model: "M6T22", shortDesc: "6 cu ft steel wheelbarrow", status: "RETIRED", energy: "Manual", dailyRate: 5.0, qrSlug: "jackson-m6t22-001", retiredAt: daysAgo(10) },
  });

  // ── Equipment checkouts (5 active) ────────────────────────────────────────
  console.log("  Creating checkouts...");

  await prisma.checkout.create({ data: { equipmentId: mower1.id, userId: EMPLOYEE_ID, reservedAt: daysAgo(5), checkedOutAt: daysAgo(5) } });
  await prisma.checkout.create({ data: { equipmentId: blower1.id, userId: CONTRACTOR_ID, reservedAt: daysAgo(3), checkedOutAt: daysAgo(3) } });
  await prisma.checkout.create({ data: { equipmentId: trimmer2.id, userId: ADMIN_WORKER_ID, reservedAt: daysAgo(2), checkedOutAt: daysAgo(2) } });
  await prisma.checkout.create({ data: { equipmentId: blower3.id, userId: TRAINEE_ID, reservedAt: daysAgo(1), checkedOutAt: daysAgo(1) } });
  await prisma.checkout.create({ data: { equipmentId: trailer.id, userId: ADMIN_WORKER_ID, reservedAt: daysAgo(7), checkedOutAt: daysAgo(7) } });
  // Past returned checkout
  await prisma.checkout.create({ data: { equipmentId: chainsawEquip.id, userId: CONTRACTOR_ID, reservedAt: daysAgo(14), checkedOutAt: daysAgo(14), releasedAt: daysAgo(12), rentalDays: 2, rentalCost: 60.0 } });

  // ── Jobs (18) ─────────────────────────────────────────────────────────────
  console.log("  Creating jobs...");

  // Harrington (VIP) - 2 recurring
  const harringtonMow = await prisma.job.create({
    data: { propertyId: harringtonMain.id, kind: "SINGLE_ADDRESS", status: "ACCEPTED", frequencyDays: 7, defaultPrice: 85.0, estimatedMinutes: 45, notes: "Premium mow + edge + blow" },
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
    data: { propertyId: willowbrookCommon.id, kind: "ENTIRE_SITE", status: "ACCEPTED", frequencyDays: 7, defaultPrice: 250.0, estimatedMinutes: 120, notes: "Common area maintenance" },
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
    data: { propertyId: riverBendCampus.id, kind: "ENTIRE_SITE", status: "ACCEPTED", frequencyDays: 7, defaultPrice: 400.0, estimatedMinutes: 150, notes: "Full campus grounds maintenance" },
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
    { jobId: patelMow.id, userId: TRAINEE_ID, role: "primary" },
    { jobId: riverBendWeekly.id, userId: ADMIN_WORKER_ID, role: "primary" },
    { jobId: riverBendWeekly.id, userId: CONTRACTOR_ID, role: "helper" },
    { jobId: kimMow.id, userId: EMPLOYEE_ID, role: "primary" },
    { jobId: churchWeekly.id, userId: EMPLOYEE_ID, role: "primary" },
  ];
  for (const d of defaults) {
    await prisma.jobAssigneeDefault.create({ data: d });
  }

  // ── Helper to create occurrence + assignees ───────────────────────────────
  type OccData = Parameters<typeof prisma.jobOccurrence.create>[0]["data"];
  type Assignee = { userId: string; role?: string };

  async function occ(data: OccData, assignees?: Assignee[]) {
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
    { jobId: harringtonMow.id, kind: "SINGLE_ADDRESS", startAt: daysAgo(21, 8), endAt: addMinutes(daysAgo(21, 8), 45), status: "COMPLETED", workflow: "STANDARD", jobType: "MOW_TRIM_BLOW", price: 85.0, estimatedMinutes: 45, startedAt: daysAgo(21, 8), completedAt: addMinutes(daysAgo(21, 8), 40) },
    [{ userId: ADMIN_WORKER_ID, role: "primary" }, { userId: EMPLOYEE_ID, role: "helper" }],
  );
  const cHarrington14 = await occ(
    { jobId: harringtonMow.id, kind: "SINGLE_ADDRESS", startAt: daysAgo(14, 8), endAt: addMinutes(daysAgo(14, 8), 45), status: "COMPLETED", workflow: "STANDARD", jobType: "MOW_TRIM_BLOW", price: 85.0, estimatedMinutes: 45, startedAt: daysAgo(14, 8), completedAt: addMinutes(daysAgo(14, 8), 42) },
    [{ userId: ADMIN_WORKER_ID, role: "primary" }, { userId: EMPLOYEE_ID, role: "helper" }],
  );
  const cHarrington7 = await occ(
    { jobId: harringtonMow.id, kind: "SINGLE_ADDRESS", startAt: daysAgo(7, 8), endAt: addMinutes(daysAgo(7, 8), 45), status: "COMPLETED", workflow: "STANDARD", jobType: "MOW_TRIM_BLOW", price: 85.0, estimatedMinutes: 45, startedAt: daysAgo(7, 8), completedAt: addMinutes(daysAgo(7, 8), 50) },
    [{ userId: ADMIN_WORKER_ID, role: "primary" }, { userId: EMPLOYEE_ID, role: "helper" }],
  );
  const cLake14 = await occ(
    { jobId: harringtonLakeMow.id, kind: "SINGLE_ADDRESS", startAt: daysAgo(14, 13), endAt: addMinutes(daysAgo(14, 13), 35), status: "COMPLETED", workflow: "STANDARD", jobType: "MOW_ONLY", price: 65.0, estimatedMinutes: 35, startedAt: daysAgo(14, 13), completedAt: addMinutes(daysAgo(14, 13), 30) },
    [{ userId: CONTRACTOR_ID, role: "primary" }],
  );
  const cLake7 = await occ(
    { jobId: harringtonLakeMow.id, kind: "SINGLE_ADDRESS", startAt: daysAgo(7, 13), endAt: addMinutes(daysAgo(7, 13), 35), status: "COMPLETED", workflow: "STANDARD", jobType: "MOW_ONLY", price: 65.0, estimatedMinutes: 35, startedAt: daysAgo(7, 13), completedAt: addMinutes(daysAgo(7, 13), 32) },
    [{ userId: CONTRACTOR_ID, role: "primary" }],
  );
  const cMartinez14 = await occ(
    { jobId: martinezBiweekly.id, kind: "SINGLE_ADDRESS", startAt: daysAgo(14, 9), endAt: addMinutes(daysAgo(14, 9), 40), status: "COMPLETED", workflow: "STANDARD", jobType: "FULL_SERVICE", price: 55.0, estimatedMinutes: 40, startedAt: daysAgo(14, 9), completedAt: addMinutes(daysAgo(14, 9), 38) },
    [{ userId: EMPLOYEE_ID, role: "primary" }],
  );
  const cWillowbrook14 = await occ(
    { jobId: willowbrookWeekly.id, kind: "ENTIRE_SITE", startAt: daysAgo(14, 7), endAt: addMinutes(daysAgo(14, 7), 120), status: "COMPLETED", workflow: "STANDARD", jobType: "MOW_TRIM_BLOW", price: 250.0, estimatedMinutes: 120, startedAt: daysAgo(14, 7), completedAt: addMinutes(daysAgo(14, 7), 110) },
    [{ userId: ADMIN_WORKER_ID, role: "primary" }, { userId: CONTRACTOR_ID, role: "helper" }],
  );
  const cWillowbrook7 = await occ(
    { jobId: willowbrookWeekly.id, kind: "ENTIRE_SITE", startAt: daysAgo(7, 7), endAt: addMinutes(daysAgo(7, 7), 120), status: "COMPLETED", workflow: "STANDARD", jobType: "MOW_TRIM_BLOW", price: 250.0, estimatedMinutes: 120, startedAt: daysAgo(7, 7), completedAt: addMinutes(daysAgo(7, 7), 115) },
    [{ userId: ADMIN_WORKER_ID, role: "primary" }, { userId: CONTRACTOR_ID, role: "helper" }],
  );
  const cThompson14 = await occ(
    { jobId: thompsonMow.id, kind: "SINGLE_ADDRESS", startAt: daysAgo(14, 9), endAt: addMinutes(daysAgo(14, 9), 60), status: "COMPLETED", workflow: "STANDARD", jobType: "FULL_SERVICE", price: 125.0, estimatedMinutes: 60, startedAt: daysAgo(14, 9), completedAt: addMinutes(daysAgo(14, 9), 55) },
    [{ userId: CONTRACTOR_ID, role: "primary" }, { userId: TRAINEE_ID, role: "helper" }],
  );
  const cThompson7 = await occ(
    { jobId: thompsonMow.id, kind: "SINGLE_ADDRESS", startAt: daysAgo(7, 9), endAt: addMinutes(daysAgo(7, 9), 60), status: "COMPLETED", workflow: "STANDARD", jobType: "FULL_SERVICE", price: 125.0, estimatedMinutes: 60, startedAt: daysAgo(7, 9), completedAt: addMinutes(daysAgo(7, 9), 58) },
    [{ userId: CONTRACTOR_ID, role: "primary" }, { userId: TRAINEE_ID, role: "helper" }],
  );
  const cObrien7 = await occ(
    { jobId: obrienMow.id, kind: "SINGLE_ADDRESS", startAt: daysAgo(7, 8), endAt: addMinutes(daysAgo(7, 8), 35), status: "COMPLETED", workflow: "STANDARD", jobType: "MOW_ONLY", price: 60.0, estimatedMinutes: 35, startedAt: daysAgo(7, 8), completedAt: addMinutes(daysAgo(7, 8), 33) },
    [{ userId: EMPLOYEE_ID, role: "primary" }],
  );
  const cSunrise7 = await occ(
    { jobId: sunriseWeekly.id, kind: "ENTIRE_SITE", startAt: daysAgo(7, 7), endAt: addMinutes(daysAgo(7, 7), 180), status: "COMPLETED", workflow: "STANDARD", jobType: "FULL_SERVICE", price: 350.0, estimatedMinutes: 180, startedAt: daysAgo(7, 7), completedAt: addMinutes(daysAgo(7, 7), 170) },
    [{ userId: ADMIN_WORKER_ID, role: "primary" }, { userId: EMPLOYEE_ID, role: "helper" }, { userId: CONTRACTOR_ID, role: "helper" }],
  );
  const cPatel7 = await occ(
    { jobId: patelMow.id, kind: "SINGLE_ADDRESS", startAt: daysAgo(7, 15), endAt: addMinutes(daysAgo(7, 15), 25), status: "COMPLETED", workflow: "STANDARD", jobType: "MOW_ONLY", price: 45.0, estimatedMinutes: 25, startedAt: daysAgo(7, 15), completedAt: addMinutes(daysAgo(7, 15), 22) },
    [{ userId: TRAINEE_ID, role: "primary" }],
  );
  const cRiverBend7 = await occ(
    { jobId: riverBendWeekly.id, kind: "ENTIRE_SITE", startAt: daysAgo(7, 6), endAt: addMinutes(daysAgo(7, 6), 150), status: "COMPLETED", workflow: "STANDARD", jobType: "MOW_TRIM_BLOW", price: 400.0, estimatedMinutes: 150, startedAt: daysAgo(7, 6), completedAt: addMinutes(daysAgo(7, 6), 145) },
    [{ userId: ADMIN_WORKER_ID, role: "primary" }, { userId: CONTRACTOR_ID, role: "helper" }],
  );
  const cChurch7 = await occ(
    { jobId: churchWeekly.id, kind: "ENTIRE_SITE", startAt: daysAgo(7, 14), endAt: addMinutes(daysAgo(7, 14), 90), status: "COMPLETED", workflow: "STANDARD", jobType: "MOW_TRIM_BLOW", price: 200.0, estimatedMinutes: 90, startedAt: daysAgo(7, 14), completedAt: addMinutes(daysAgo(7, 14), 85) },
    [{ userId: EMPLOYEE_ID, role: "primary" }],
  );
  const cKim14 = await occ(
    { jobId: kimMow.id, kind: "SINGLE_ADDRESS", startAt: daysAgo(14, 10), endAt: addMinutes(daysAgo(14, 10), 30), status: "COMPLETED", workflow: "STANDARD", jobType: "MOW_ONLY", price: 50.0, estimatedMinutes: 30, startedAt: daysAgo(14, 10), completedAt: addMinutes(daysAgo(14, 10), 28) },
    [{ userId: EMPLOYEE_ID, role: "primary" }],
  );

  // ─── OVERDUE (past, still SCHEDULED, unclaimed) ───────────────────────────
  await occ({ jobId: harringtonLakeMow.id, kind: "SINGLE_ADDRESS", startAt: daysAgo(1, 13), endAt: addMinutes(daysAgo(1, 13), 35), status: "SCHEDULED", workflow: "STANDARD", jobType: "MOW_ONLY", price: 65.0, estimatedMinutes: 35 });
  await occ({ jobId: martinezBiweekly.id, kind: "SINGLE_ADDRESS", startAt: daysAgo(1, 9), endAt: addMinutes(daysAgo(1, 9), 40), status: "SCHEDULED", workflow: "STANDARD", jobType: "FULL_SERVICE", price: 55.0, estimatedMinutes: 40 });
  await occ({ jobId: willowbrookWeekly.id, kind: "ENTIRE_SITE", startAt: daysAgo(2, 7), endAt: addMinutes(daysAgo(2, 7), 120), status: "SCHEDULED", workflow: "STANDARD", jobType: "MOW_TRIM_BLOW", price: 250.0, estimatedMinutes: 120 });
  await occ({ jobId: obrienMow.id, kind: "SINGLE_ADDRESS", startAt: daysAgo(1, 8), endAt: addMinutes(daysAgo(1, 8), 35), status: "SCHEDULED", workflow: "STANDARD", jobType: "MOW_ONLY", price: 60.0, estimatedMinutes: 35 });
  await occ({ jobId: sunriseWeekly.id, kind: "ENTIRE_SITE", startAt: daysAgo(2, 7), endAt: addMinutes(daysAgo(2, 7), 180), status: "SCHEDULED", workflow: "STANDARD", jobType: "FULL_SERVICE", price: 350.0, estimatedMinutes: 180 });
  await occ({ jobId: riverBendWeekly.id, kind: "ENTIRE_SITE", startAt: daysAgo(1, 6), endAt: addMinutes(daysAgo(1, 6), 150), status: "SCHEDULED", workflow: "STANDARD", jobType: "MOW_TRIM_BLOW", price: 400.0, estimatedMinutes: 150 });
  await occ({ jobId: patelMow.id, kind: "SINGLE_ADDRESS", startAt: daysAgo(3, 15), endAt: addMinutes(daysAgo(3, 15), 25), status: "SCHEDULED", workflow: "STANDARD", jobType: "MOW_ONLY", price: 45.0, estimatedMinutes: 25 });
  await occ({ jobId: churchWeekly.id, kind: "ENTIRE_SITE", startAt: daysAgo(1, 14), endAt: addMinutes(daysAgo(1, 14), 90), status: "SCHEDULED", workflow: "STANDARD", jobType: "MOW_TRIM_BLOW", price: 200.0, estimatedMinutes: 90 });
  // One overdue but assigned (not unclaimed)
  await occ(
    { jobId: thompsonMow.id, kind: "SINGLE_ADDRESS", startAt: daysAgo(1, 9), endAt: addMinutes(daysAgo(1, 9), 60), status: "SCHEDULED", workflow: "STANDARD", jobType: "FULL_SERVICE", price: 125.0, estimatedMinutes: 60 },
    [{ userId: CONTRACTOR_ID, role: "primary" }],
  );

  // ─── TODAY / TOMORROW ─────────────────────────────────────────────────────
  // Assigned today
  await occ(
    { jobId: harringtonMow.id, kind: "SINGLE_ADDRESS", startAt: daysFromNow(0, 8), endAt: addMinutes(daysFromNow(0, 8), 45), status: "SCHEDULED", workflow: "STANDARD", jobType: "MOW_TRIM_BLOW", price: 85.0, estimatedMinutes: 45 },
    [{ userId: ADMIN_WORKER_ID, role: "primary" }, { userId: EMPLOYEE_ID, role: "helper" }],
  );
  await occ(
    { jobId: willowbrookWeekly.id, kind: "ENTIRE_SITE", startAt: daysFromNow(0, 7), endAt: addMinutes(daysFromNow(0, 7), 120), status: "SCHEDULED", workflow: "STANDARD", jobType: "MOW_TRIM_BLOW", price: 250.0, estimatedMinutes: 120 },
    [{ userId: ADMIN_WORKER_ID, role: "primary" }],
  );
  await occ(
    { jobId: patelMow.id, kind: "SINGLE_ADDRESS", startAt: daysFromNow(0, 15), endAt: addMinutes(daysFromNow(0, 15), 25), status: "SCHEDULED", workflow: "STANDARD", jobType: "MOW_ONLY", price: 45.0, estimatedMinutes: 25 },
    [{ userId: TRAINEE_ID, role: "primary" }],
  );
  await occ(
    { jobId: riverBendWeekly.id, kind: "ENTIRE_SITE", startAt: daysFromNow(0, 6), endAt: addMinutes(daysFromNow(0, 6), 150), status: "SCHEDULED", workflow: "STANDARD", jobType: "MOW_TRIM_BLOW", price: 400.0, estimatedMinutes: 150 },
    [{ userId: ADMIN_WORKER_ID, role: "primary" }, { userId: CONTRACTOR_ID, role: "helper" }],
  );
  // In progress today
  await occ(
    { jobId: obrienMow.id, kind: "SINGLE_ADDRESS", startAt: daysFromNow(0, 8), endAt: addMinutes(daysFromNow(0, 8), 35), status: "IN_PROGRESS", workflow: "STANDARD", jobType: "MOW_ONLY", price: 60.0, estimatedMinutes: 35, startedAt: daysFromNow(0, 8) },
    [{ userId: EMPLOYEE_ID, role: "primary" }],
  );

  // Unclaimed today
  await occ({ jobId: martinezBiweekly.id, kind: "SINGLE_ADDRESS", startAt: daysFromNow(0, 9), endAt: addMinutes(daysFromNow(0, 9), 40), status: "SCHEDULED", workflow: "STANDARD", jobType: "FULL_SERVICE", price: 55.0, estimatedMinutes: 40 });
  await occ({ jobId: churchWeekly.id, kind: "ENTIRE_SITE", startAt: daysFromNow(0, 14), endAt: addMinutes(daysFromNow(0, 14), 90), status: "SCHEDULED", workflow: "STANDARD", jobType: "MOW_TRIM_BLOW", price: 200.0, estimatedMinutes: 90 });

  // Assigned tomorrow
  await occ(
    { jobId: chenLeafCleanup.id, kind: "SINGLE_ADDRESS", startAt: daysFromNow(1, 9), endAt: addMinutes(daysFromNow(1, 9), 90), status: "SCHEDULED", workflow: "ONE_OFF", jobType: "LEAF_CLEANUP", price: 120.0, estimatedMinutes: 90, isOneOff: true },
    [{ userId: EMPLOYEE_ID, role: "primary" }, { userId: TRAINEE_ID, role: "helper" }],
  );
  await occ(
    { jobId: thompsonMow.id, kind: "SINGLE_ADDRESS", startAt: daysFromNow(1, 9), endAt: addMinutes(daysFromNow(1, 9), 60), status: "SCHEDULED", workflow: "STANDARD", jobType: "FULL_SERVICE", price: 125.0, estimatedMinutes: 60 },
    [{ userId: CONTRACTOR_ID, role: "primary" }, { userId: TRAINEE_ID, role: "helper" }],
  );

  // Unclaimed tomorrow
  await occ({ jobId: harringtonLakeMow.id, kind: "SINGLE_ADDRESS", startAt: daysFromNow(1, 13), endAt: addMinutes(daysFromNow(1, 13), 35), status: "SCHEDULED", workflow: "STANDARD", jobType: "MOW_ONLY", price: 65.0, estimatedMinutes: 35 });
  await occ({ jobId: sunriseWeekly.id, kind: "ENTIRE_SITE", startAt: daysFromNow(1, 7), endAt: addMinutes(daysFromNow(1, 7), 180), status: "SCHEDULED", workflow: "STANDARD", jobType: "FULL_SERVICE", price: 350.0, estimatedMinutes: 180 });
  await occ({ jobId: kimMow.id, kind: "SINGLE_ADDRESS", startAt: daysFromNow(1, 10), endAt: addMinutes(daysFromNow(1, 10), 30), status: "SCHEDULED", workflow: "STANDARD", jobType: "MOW_ONLY", price: 50.0, estimatedMinutes: 30 });

  // ─── UPCOMING (2-7 days) ──────────────────────────────────────────────────
  // Assigned
  await occ(
    { jobId: harringtonMow.id, kind: "SINGLE_ADDRESS", startAt: daysFromNow(7, 8), endAt: addMinutes(daysFromNow(7, 8), 45), status: "SCHEDULED", workflow: "STANDARD", jobType: "MOW_TRIM_BLOW", price: 85.0, estimatedMinutes: 45 },
    [{ userId: ADMIN_WORKER_ID, role: "primary" }],
  );
  await occ(
    { jobId: harringtonLakeMow.id, kind: "SINGLE_ADDRESS", startAt: daysFromNow(7, 13), endAt: addMinutes(daysFromNow(7, 13), 35), status: "SCHEDULED", workflow: "STANDARD", jobType: "MOW_ONLY", price: 65.0, estimatedMinutes: 35 },
    [{ userId: CONTRACTOR_ID, role: "primary" }],
  );
  await occ(
    { jobId: obrienMow.id, kind: "SINGLE_ADDRESS", startAt: daysFromNow(3, 8), endAt: addMinutes(daysFromNow(3, 8), 35), status: "SCHEDULED", workflow: "STANDARD", jobType: "MOW_ONLY", price: 60.0, estimatedMinutes: 35 },
    [{ userId: EMPLOYEE_ID, role: "primary" }],
  );
  await occ(
    { jobId: riverBendWeekly.id, kind: "ENTIRE_SITE", startAt: daysFromNow(6, 6), endAt: addMinutes(daysFromNow(6, 6), 150), status: "SCHEDULED", workflow: "STANDARD", jobType: "MOW_TRIM_BLOW", price: 400.0, estimatedMinutes: 150 },
    [{ userId: ADMIN_WORKER_ID, role: "primary" }, { userId: CONTRACTOR_ID, role: "helper" }],
  );

  // Unclaimed upcoming
  await occ({ jobId: willowbrookWeekly.id, kind: "ENTIRE_SITE", startAt: daysFromNow(5, 7), endAt: addMinutes(daysFromNow(5, 7), 120), status: "SCHEDULED", workflow: "STANDARD", jobType: "MOW_TRIM_BLOW", price: 250.0, estimatedMinutes: 120 });
  await occ({ jobId: sunriseWeekly.id, kind: "ENTIRE_SITE", startAt: daysFromNow(5, 7), endAt: addMinutes(daysFromNow(5, 7), 180), status: "SCHEDULED", workflow: "STANDARD", jobType: "FULL_SERVICE", price: 350.0, estimatedMinutes: 180 });
  await occ({ jobId: patelMow.id, kind: "SINGLE_ADDRESS", startAt: daysFromNow(4, 15), endAt: addMinutes(daysFromNow(4, 15), 25), status: "SCHEDULED", workflow: "STANDARD", jobType: "MOW_ONLY", price: 45.0, estimatedMinutes: 25 });
  await occ({ jobId: churchWeekly.id, kind: "ENTIRE_SITE", startAt: daysFromNow(6, 14), endAt: addMinutes(daysFromNow(6, 14), 90), status: "SCHEDULED", workflow: "STANDARD", jobType: "MOW_TRIM_BLOW", price: 200.0, estimatedMinutes: 90 });

  // Tentative upcoming
  await occ(
    { jobId: martinezBiweekly.id, kind: "SINGLE_ADDRESS", startAt: daysFromNow(6, 9), endAt: addMinutes(daysFromNow(6, 9), 40), status: "SCHEDULED", workflow: "STANDARD", jobType: "FULL_SERVICE", price: 55.0, estimatedMinutes: 40, isTentative: true },
    [{ userId: EMPLOYEE_ID, role: "primary" }],
  );
  await occ(
    { jobId: thompsonGuestMow.id, kind: "SINGLE_ADDRESS", startAt: daysFromNow(3, 14), endAt: addMinutes(daysFromNow(3, 14), 30), status: "SCHEDULED", workflow: "STANDARD", jobType: "MOW_ONLY", price: 55.0, estimatedMinutes: 30, isTentative: true },
    [{ userId: CONTRACTOR_ID, role: "primary" }],
  );

  // ─── FURTHER OUT (8-14 days) ──────────────────────────────────────────────
  await occ(
    { jobId: harringtonMow.id, kind: "SINGLE_ADDRESS", startAt: daysFromNow(14, 8), endAt: addMinutes(daysFromNow(14, 8), 45), status: "SCHEDULED", workflow: "STANDARD", jobType: "MOW_TRIM_BLOW", price: 85.0, estimatedMinutes: 45 },
    [{ userId: ADMIN_WORKER_ID, role: "primary" }, { userId: EMPLOYEE_ID, role: "helper" }],
  );
  await occ({ jobId: willowbrookPoolMow.id, kind: "SINGLE_ADDRESS", startAt: daysFromNow(10, 8), endAt: addMinutes(daysFromNow(10, 8), 30), status: "SCHEDULED", workflow: "STANDARD", jobType: "MOW_TRIM_BLOW", price: 75.0, estimatedMinutes: 30 });
  await occ({ jobId: willowbrookWeekly.id, kind: "ENTIRE_SITE", startAt: daysFromNow(12, 7), endAt: addMinutes(daysFromNow(12, 7), 120), status: "SCHEDULED", workflow: "STANDARD", jobType: "MOW_TRIM_BLOW", price: 250.0, estimatedMinutes: 120, isTentative: true, isAdminOnly: true });

  // ─── CANCELED ─────────────────────────────────────────────────────────────
  await occ({ jobId: harringtonMow.id, kind: "SINGLE_ADDRESS", startAt: daysAgo(28, 8), endAt: addMinutes(daysAgo(28, 8), 45), status: "CANCELED", workflow: "STANDARD", jobType: "MOW_TRIM_BLOW", price: 85.0, estimatedMinutes: 45 });
  await occ({ jobId: willowbrookWeekly.id, kind: "ENTIRE_SITE", startAt: daysAgo(21, 7), endAt: addMinutes(daysAgo(21, 7), 120), status: "CANCELED", workflow: "STANDARD", jobType: "MOW_TRIM_BLOW", price: 250.0, estimatedMinutes: 120 });
  await occ({ jobId: thompsonMow.id, kind: "SINGLE_ADDRESS", startAt: daysAgo(21, 9), endAt: addMinutes(daysAgo(21, 9), 60), status: "CANCELED", workflow: "STANDARD", jobType: "FULL_SERVICE", price: 125.0, estimatedMinutes: 60 });

  // ─── ESTIMATES ────────────────────────────────────────────────────────────
  await occ({ jobId: chenTreeEstimate.id, kind: "SINGLE_ADDRESS", startAt: daysFromNow(3, 10), endAt: addMinutes(daysFromNow(3, 10), 60), status: "PROPOSAL_SUBMITTED", workflow: "ESTIMATE", jobType: "TREE_TRIMMING", isEstimate: true, isAdminOnly: true, proposalAmount: 450, proposalNotes: "3 large oaks in backyard, estimate includes debris removal" });
  await occ({ jobId: churchPressureWash.id, kind: "ENTIRE_SITE", startAt: daysFromNow(8, 10), endAt: addMinutes(daysFromNow(8, 10), 120), status: "PROPOSAL_SUBMITTED", workflow: "ESTIMATE", jobType: "PRESSURE_WASH", isEstimate: true, isAdminOnly: true, proposalAmount: 800, proposalNotes: "Full walkway and parking lot pressure wash, ~5000 sqft" });

  // ─── ONE-OFF (aeration) ───────────────────────────────────────────────────
  await occ(
    { jobId: patelAeration.id, kind: "SINGLE_ADDRESS", startAt: daysFromNow(5, 10), endAt: addMinutes(daysFromNow(5, 10), 60), status: "SCHEDULED", workflow: "ONE_OFF", jobType: "AERATION", price: 150.0, estimatedMinutes: 60, isOneOff: true },
    [{ userId: EMPLOYEE_ID, role: "primary" }],
  );

  // ── Payments (for completed occurrences) ──────────────────────────────────
  console.log("  Creating payments...");

  const paymentData: { occId: string; amount: number; method: "CASH" | "CHECK" | "VENMO" | "ZELLE" | "APPLE_PAY"; collector: string; splits: { userId: string; amount: number }[] }[] = [
    { occId: cHarrington21.id, amount: 85, method: "CASH", collector: ADMIN_WORKER_ID, splits: [{ userId: ADMIN_WORKER_ID, amount: 50 }, { userId: EMPLOYEE_ID, amount: 35 }] },
    { occId: cHarrington14.id, amount: 85, method: "CHECK", collector: ADMIN_WORKER_ID, splits: [{ userId: ADMIN_WORKER_ID, amount: 50 }, { userId: EMPLOYEE_ID, amount: 35 }] },
    { occId: cHarrington7.id, amount: 85, method: "VENMO", collector: ADMIN_WORKER_ID, splits: [{ userId: ADMIN_WORKER_ID, amount: 50 }, { userId: EMPLOYEE_ID, amount: 35 }] },
    { occId: cLake14.id, amount: 65, method: "CASH", collector: CONTRACTOR_ID, splits: [{ userId: CONTRACTOR_ID, amount: 65 }] },
    { occId: cLake7.id, amount: 65, method: "VENMO", collector: CONTRACTOR_ID, splits: [{ userId: CONTRACTOR_ID, amount: 65 }] },
    { occId: cMartinez14.id, amount: 55, method: "ZELLE", collector: EMPLOYEE_ID, splits: [{ userId: EMPLOYEE_ID, amount: 55 }] },
    { occId: cWillowbrook14.id, amount: 250, method: "CHECK", collector: ADMIN_WORKER_ID, splits: [{ userId: ADMIN_WORKER_ID, amount: 150 }, { userId: CONTRACTOR_ID, amount: 100 }] },
    { occId: cWillowbrook7.id, amount: 250, method: "CHECK", collector: ADMIN_WORKER_ID, splits: [{ userId: ADMIN_WORKER_ID, amount: 150 }, { userId: CONTRACTOR_ID, amount: 100 }] },
    { occId: cThompson14.id, amount: 125, method: "APPLE_PAY", collector: CONTRACTOR_ID, splits: [{ userId: CONTRACTOR_ID, amount: 85 }, { userId: TRAINEE_ID, amount: 40 }] },
    { occId: cThompson7.id, amount: 125, method: "VENMO", collector: CONTRACTOR_ID, splits: [{ userId: CONTRACTOR_ID, amount: 85 }, { userId: TRAINEE_ID, amount: 40 }] },
    { occId: cObrien7.id, amount: 60, method: "CASH", collector: EMPLOYEE_ID, splits: [{ userId: EMPLOYEE_ID, amount: 60 }] },
    { occId: cSunrise7.id, amount: 350, method: "CHECK", collector: ADMIN_WORKER_ID, splits: [{ userId: ADMIN_WORKER_ID, amount: 150 }, { userId: EMPLOYEE_ID, amount: 100 }, { userId: CONTRACTOR_ID, amount: 100 }] },
    { occId: cPatel7.id, amount: 45, method: "CASH", collector: TRAINEE_ID, splits: [{ userId: TRAINEE_ID, amount: 45 }] },
    { occId: cRiverBend7.id, amount: 400, method: "CHECK", collector: ADMIN_WORKER_ID, splits: [{ userId: ADMIN_WORKER_ID, amount: 250 }, { userId: CONTRACTOR_ID, amount: 150 }] },
    { occId: cChurch7.id, amount: 200, method: "CHECK", collector: EMPLOYEE_ID, splits: [{ userId: EMPLOYEE_ID, amount: 200 }] },
    { occId: cKim14.id, amount: 50, method: "ZELLE", collector: EMPLOYEE_ID, splits: [{ userId: EMPLOYEE_ID, amount: 50 }] },
  ];

  for (const p of paymentData) {
    await prisma.payment.create({
      data: {
        occurrenceId: p.occId,
        amountPaid: p.amount,
        method: p.method,
        collectedById: p.collector,
        splits: { create: p.splits },
      },
    });
  }

  // ── Expenses ──────────────────────────────────────────────────────────────
  console.log("  Creating expenses...");

  const expenseData: { occId: string; userId: string; cost: number; desc: string }[] = [
    { occId: cWillowbrook7.id, userId: ADMIN_WORKER_ID, cost: 25.0, desc: "Fuel for mowers" },
    { occId: cWillowbrook14.id, userId: ADMIN_WORKER_ID, cost: 28.0, desc: "Fuel for mowers" },
    { occId: cMartinez14.id, userId: EMPLOYEE_ID, cost: 12.5, desc: "Trimmer line replacement" },
    { occId: cHarrington7.id, userId: EMPLOYEE_ID, cost: 8.0, desc: "Edger blade" },
    { occId: cSunrise7.id, userId: ADMIN_WORKER_ID, cost: 35.0, desc: "Fuel and 2-cycle oil" },
    { occId: cRiverBend7.id, userId: CONTRACTOR_ID, cost: 18.0, desc: "Mulch bags (2)" },
    { occId: cThompson7.id, userId: CONTRACTOR_ID, cost: 15.0, desc: "Hedge trimmer fuel mix" },
    { occId: cObrien7.id, userId: EMPLOYEE_ID, cost: 6.0, desc: "Trash bags for debris" },
  ];

  for (const e of expenseData) {
    await prisma.expense.create({
      data: { occurrenceId: e.occId, createdById: e.userId, cost: e.cost, description: e.desc },
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
      data: { scope: "JOB", verb: "UPDATED", action: "occurrence_completed", actorUserId: c.actor, metadata: { occurrenceId: c.id, status: "COMPLETED" }, createdAt: c.at },
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

  console.log("  Seed complete!");
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const resetOnly = process.argv.includes("--reset-only");

  console.log("Clearing database (preserving User, UserRole, Setting)...");
  await clearDatabase();

  if (resetOnly) {
    console.log("--reset-only flag set. Skipping seed.");
  } else {
    console.log("Seeding database...");
    await seedDatabase();
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
