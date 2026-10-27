import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { crewPool } from "../lib/jobPricing";
import { ESTIMATE_ADDRESS_PART_FIELDS, pickEstimateAddressParts } from "../lib/estimateAddress";
import { carryInstructionsToNewOccurrence } from "../lib/instructionCarry";
import { computeResumeStartAt } from "../services/jobs";
import { randomUUID } from "crypto";
import { services } from "../services";
import { prisma } from "../db/prisma";
import { deleteObject, getDownloadUrl, getUploadUrl } from "../lib/r2";
import { LIVE_WINDOW_MS, OFFLINE_WINDOW_MS } from "../services/displays";
import { etAddDays, etDaysBetween, etEndOfDay, etFormatDate, etFormatDateOpts, etInstantFromParts, etMidnight, etStartOfMonth, etStartOfYear, etSundayOnOrBefore, etToday, parseUserDate, type EtDateKey } from "../lib/dates";
import { AUDIT } from "../lib/auditActions";
import { writeAudit } from "../lib/auditLogger";
import { enforceAssigneeInvariants } from "../lib/claimerInvariant";
import { callerCan, callerCanFn } from "../lib/callerCan";
import { JobKind, JobOccurrenceStatus, JobStatus, Prisma } from "@prisma/client";
import { normalizePhone } from "../lib/phone";
import { generateLedgerId } from "../lib/ledgerId";
import { loadCategoryLabels, loadExpenseCategories } from "../services/expenseCategories";
import { isFixedAsset, loadFixedAssetMinCost } from "../services/exports";
import { cutoffWhere, expensesIncludeWithCutoff, occurrenceWorkDateCutoff, paymentIncludeWithCutoff, resolveCutoff } from "../lib/businessStartCutoff";
import { makeGuards } from "../lib/routeGuards";
import { resolveOccurrenceArea } from "../lib/occurrenceArea";
import { areaWhere, areaWhereVia } from "../lib/areaScope";
import { WORKER_TYPES, isW2, isWorkerType, rateForProjection, type WorkerType } from "@repo/money";
import { currentUserId, enrichSyncTasks, nextRecurrenceDate } from "./_shared";

const LEDGER_ROW_INCLUDE = Prisma.validator<Prisma.BusinessExpenseInclude>()({
  createdBy: { select: { id: true, displayName: true, email: true } },
  reconciledBy: { select: { id: true, displayName: true, email: true } },
  recurrenceEndedBy: { select: { id: true, displayName: true, email: true } },
  equipment: { select: { id: true, shortDesc: true, brand: true, model: true, qrSlug: true } },
  occurrence: {
    select: {
      id: true,
      startAt: true,
      completedAt: true,
      job: {
        select: {
          id: true,
          property: {
            select: { id: true, displayName: true, client: { select: { displayName: true } } },
          },
        },
      },
    },
  },
  // PLURAL. One receipt can back several supply purchases — that is the
  // whole point of the many-to-one link — so this is a list, and a row
  // may carry more than one badge.
  supplyPurchases: {
    select: {
      id: true,
      quantity: true,
      unitCost: true,
      supply: { select: { id: true, name: true, unit: true } },
    },
  },
});

export default async function booksRoutes(app: FastifyInstance) {
  const { expensesCsv, capitalCsv, incomeCsv, workdaysCsv } = await import("../services/exports");
  const ledgerFollowups = await import("../services/ledgerFollowups");
  function readDateRange(req: any): { start: Date; end: Date } {
    const startStr = String(req.query?.start ?? "");
    const endStr = String(req.query?.end ?? "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startStr) || !/^\d{4}-\d{2}-\d{2}$/.test(endStr)) {
      throw app.httpErrors.badRequest("start and end query params must be YYYY-MM-DD");
    }
    const start = etMidnight(startStr as EtDateKey);
    const end = etEndOfDay(endStr as EtDateKey);
    if (end < start) throw app.httpErrors.badRequest("end must be on or after start");
    return { start, end };
  }
  // THE ONE PLACE A TAX EXPORT LEAVES THE BUILDING, so it is the one place
  // that records who took it.
  //
  // `AUDIT.EXPORT.DOWNLOADED` has existed since the Exports tab shipped,
  // with a doc comment promising "the Audit Log shows when each payroll /
  // QB pull happened" — and no call site anywhere. Five endpoints behind
  // `books.export-tax` handed out expenses, capital, income, workdays and
  // payroll CSVs leaving no trace of who pulled them or for what range.
  //
  // IT SURVIVED BECAUSE IT CANNOT BE SEEN BY THE RATCHET. The
  // audit-coverage gate counts Prisma writes per file and compares against
  // a baseline; a GET that only reads has no write to count, so a
  // completely unaudited export scores perfectly. Read events have to be
  // audited deliberately — the gate will never ask for them.
  //
  // Audited BEFORE the bytes go out: if the write fails the operator gets
  // an error instead of an untracked copy of the payroll.
  async function deliverPlainCsv(
    req: any,
    reply: FastifyReply,
    fileSlug: string,
    range: { startStr: string; endStr: string },
    csv: string,
  ) {
    const fn = `${fileSlug}-${range.startStr}_${range.endStr}.csv`;
    await writeAudit(prisma, AUDIT.EXPORT.DOWNLOADED, await currentUserId(req), {
      kind: fileSlug,
      start: range.startStr,
      end: range.endStr,
      filename: fn,
      bytes: Buffer.byteLength(csv, "utf-8"),
    });
    reply.header("Content-Type", "text/csv; charset=utf-8");
    reply.header("Content-Disposition", `attachment; filename="${fn}"`);
    return reply.send(Buffer.from(csv, "utf-8"));
  }
  async function clampExportStartToCutoff(req: any, start: Date): Promise<Date> {
    const cutoff = await resolveCutoff(req);
    if (!cutoff) return start;
    if (cutoff > start) {
      req.log?.warn(
        { originalStart: start.toISOString(), cutoff: cutoff.toISOString() },
        "Export start clamped to Business Start Date cutoff — pre-cutoff rows excluded. Toggle the reveal header for full history.",
      );
      return cutoff;
    }
    return start;
  }

  const { requires, approvedUser } = makeGuards(app);
  const req_booksExportTax = requires("books.export-tax");
  const req_booksManage = requires("books.manage");
  // RECORDING a purchase, as distinct from rewriting the books.
  //
  // `expenses.charge` is "charge the company's own purchases to the business"
  // — it exists for exactly this. `install-starter-roles.ts` puts it in the
  // baseline Admin role, so on a default install someone with `books.view` can record a
  // purchase; an operator can grant it to any other role instead. Converting the
  // role guards I pointed this route at `books.manage` (owner-only) instead,
  // which orphaned the entitlement entirely: nothing enforced it, while the
  // profile page kept showing holders of `books.view` a green "Enabled" badge for a thing the
  // server would refuse. Editing, deleting and reconciling stay on
  // `books.manage` — recording is not rewriting.
  const req_expensesCharge = requires("expenses.charge");
  const req_booksView = requires("books.view");
  const req_materialsCharge = requires("materials.charge");
  const req_settingsManage = requires("settings.manage");

  // Look up a payment by its client-facing receipt number. Accepts the
  // canonical form (SL-XXXXXXXX), the bare 8-char core, and any
  // reasonable variation of case/whitespace — the lookup normalizes.
  // Returns 404 when nothing matches so the caller can render an
  // "unknown receipt #" toast rather than an ambiguous empty payload.
  // view-as-allow: pure lookup — no per-user filtering applies, admin
  // scope is the whole business ledger regardless of impersonation.
  app.get(
    "/receipts/lookup",
    req_booksView,
    async (req: any, reply: any) => {
      const { normalizeReceiptNumber } = await import("../lib/receiptNumber");
      const raw = String((req.query || {}).number ?? "");
      const canonical = normalizeReceiptNumber(raw);
      if (!canonical) {
        return reply.code(400).send({ message: "Invalid receipt-number format." });
      }
      const payment = await prisma.payment.findUnique({
        where: { receiptNumber: canonical },
        select: {
          id: true,
          amountPaid: true,
          method: true,
          confirmedAt: true,
          receiptNumber: true,
          occurrence: {
            select: {
              id: true,
              startAt: true,
              completedAt: true,
              jobType: true,
              status: true,
              job: {
                select: {
                  id: true,
                  property: {
                    select: {
                      id: true,
                      displayName: true,
                      client: { select: { id: true, displayName: true } },
                    },
                  },
                },
              },
            },
          },
        },
      });
      if (!payment) {
        return reply.code(404).send({ message: "No receipt found." });
      }
      return { receipt: payment };
    },
  );
  app.get("/ledger-charges", req_booksView, async (req: any) => {
    const q = String((req.query || {}).q ?? "").trim();
    const rows = await prisma.businessExpense.findMany({
      where: {
        type: "EXPENSE",
        ...(q
          ? {
              OR: [
                { description: { contains: q, mode: "insensitive" as const } },
                { vendor: { contains: q, mode: "insensitive" as const } },
              ],
            }
          : {}),
      },
      orderBy: { date: "desc" },
      take: 40,
      select: {
        id: true, date: true, cost: true, description: true,
        vendor: true, category: true,
        // How many jobs already point here — the operator's cue that this is
        // a shared receipt, not a one-job charge.
        _count: { select: { invoiceCharges: true } },
      },
    });
    return rows.map((r) => ({
      id: r.id, date: r.date, cost: r.cost, description: r.description,
      vendor: r.vendor, category: r.category,
      referencedByJobs: r._count.invoiceCharges,
    }));
  });
  // `books.manage`, NOT `materials.charge`.
  //
  // The other five routes on `materials.charge` are invoice charges on a
  // VISIT, which is what that entitlement says it is: "Add billable
  // materials to a visit — charged to the client". This one is the other
  // book. It moves `SupplyPurchase.businessExpenseId`, attaching or
  // detaching a purchase from a Ledger row — and the Ledger is the only
  // deduction (docs/FINANCIAL_SYSTEM.md). Unlinking does not charge
  // anybody; it changes what a tax-facing expense is evidenced by.
  //
  // `materials.charge` is on the BASE RUNG, so as written every field
  // worker could detach a supply purchase from its deduction. The Supplies
  // history dialog offered them the button, and the server would have
  // allowed the write.
  app.patch("/supply-purchases/:id/ledger-link", req_booksManage, async (req: any) => {
    const uid = await currentUserId(req);
    const purchaseId = String(req.params.id);
    const businessExpenseId = (req.body || {}).businessExpenseId ?? null;
    const before = await prisma.supplyPurchase.findUnique({
      where: { id: purchaseId },
      select: { id: true, businessExpenseId: true, supplyId: true },
    });
    if (!before) throw app.httpErrors.notFound("Supply purchase not found.");
    return prisma.$transaction(async (tx) => {
      const row = await tx.supplyPurchase.update({
        where: { id: purchaseId },
        data: { businessExpenseId },
        select: {
          id: true, businessExpenseId: true,
          businessExpense: {
            select: { id: true, cost: true, description: true, vendor: true, date: true },
          },
        },
      });
      // UPDATED, not PURCHASE_RECORDED. Re-pointing an existing purchase at
      // a different ledger entry records no purchase — it only moves a
      // foreign key, and `affectsMoney: false` below says as much. Logged
      // under PURCHASE_RECORDED it inflated every count of purchases made.
      await writeAudit(tx, AUDIT.SUPPLY.UPDATED, uid, {
        action: "ledger_link_changed",
        purchaseId,
        supplyId: before.supplyId,
        businessExpenseIdBefore: before.businessExpenseId,
        businessExpenseIdAfter: businessExpenseId,
        affectsMoney: false,
        affectsStock: false,
      });
      return row;
    });
  });
  // ── System Audit ──
  // Running a system audit is an OPERATION, not a read of the audit log.
  app.post("/system-audit", req_settingsManage, async (req: any) => {
    const checks = (req.body?.checks ?? []) as string[];
    type AuditIssue = { id?: string; description: string; clientId?: string; jobId?: string; occurrenceId?: string };
    const results: { check: string; label: string; issues: AuditIssue[] }[] = [];

    // 1. Duplicate client names
    if (checks.includes("duplicate_clients")) {
      const clients = await prisma.client.findMany({
        where: { archivedAt: null },
        select: { id: true, displayName: true, status: true },
      });
      const nameMap = new Map<string, typeof clients>();
      for (const c of clients) {
        const key = c.displayName.trim().toLowerCase();
        if (!nameMap.has(key)) nameMap.set(key, []);
        nameMap.get(key)!.push(c);
      }
      const issues: AuditIssue[] = [];
      for (const [, group] of nameMap) {
        if (group.length > 1) {
          issues.push({
            id: group[0].id,
            clientId: group[0].id,
            description: `"${group[0].displayName}" appears ${group.length} times (statuses: ${group.map((c) => c.status).join(", ")})`,
          });
        }
      }
      results.push({ check: "duplicate_clients", label: "Duplicate Client Names", issues });
    }

    // 2. Duplicate properties
    if (checks.includes("duplicate_properties")) {
      const properties = await prisma.property.findMany({
        where: { archivedAt: null },
        select: { id: true, displayName: true, street1: true, city: true, state: true, clientId: true, client: { select: { displayName: true } } },
      });
      const addrMap = new Map<string, typeof properties>();
      for (const p of properties) {
        const key = [p.street1, p.city, p.state].filter(Boolean).join("|").toLowerCase().trim();
        if (!key) continue;
        if (!addrMap.has(key)) addrMap.set(key, []);
        addrMap.get(key)!.push(p);
      }
      const issues: AuditIssue[] = [];
      for (const [, group] of addrMap) {
        if (group.length > 1) {
          issues.push({
            id: group[0].id,
            clientId: (group[0] as any).clientId,
            description: `"${group[0].displayName}" (${(group[0] as any).client?.displayName ?? "?"}) at "${group[0].street1}, ${group[0].city}" — ${group.length} duplicates`,
          });
        }
      }
      results.push({ check: "duplicate_properties", label: "Duplicate Properties", issues });
    }

    // 3. Duplicate service jobs (same property + kind)
    if (checks.includes("duplicate_jobs")) {
      const jobs = await prisma.job.findMany({
        where: { status: { not: "ARCHIVED" } },
        select: { id: true, propertyId: true, kind: true, status: true, property: { select: { displayName: true, client: { select: { displayName: true } } } } },
      });
      const jobMap = new Map<string, typeof jobs>();
      for (const j of jobs) {
        const key = `${j.propertyId}|${j.kind}`;
        if (!jobMap.has(key)) jobMap.set(key, []);
        jobMap.get(key)!.push(j);
      }
      const issues: AuditIssue[] = [];
      for (const [, group] of jobMap) {
        if (group.length > 1) {
          const active = group.filter((j) => j.status !== "ARCHIVED");
          if (active.length > 1) {
            const clientName = (group[0].property as any)?.client?.displayName ?? "";
            issues.push({
              id: group[0].id,
              jobId: group[0].id,
              description: `${group[0].property?.displayName ?? "Unknown"}${clientName ? ` (${clientName})` : ""} has ${active.length} active ${group[0].kind} jobs`,
            });
          }
        }
      }
      results.push({ check: "duplicate_jobs", label: "Duplicate Service Jobs", issues });
    }

    // 4. Duplicate repeating occurrences (same job, similar date, both SCHEDULED)
    if (checks.includes("duplicate_occurrences")) {
      const occs = await prisma.jobOccurrence.findMany({
        where: {
          status: "SCHEDULED",
          workflow: "STANDARD",
          jobId: { not: null },
          startAt: { not: null },
        },
        select: { id: true, jobId: true, startAt: true, kind: true, job: { select: { property: { select: { displayName: true, client: { select: { displayName: true } } } } } } },
        orderBy: { startAt: "asc" },
      });
      const jobOccs = new Map<string, typeof occs>();
      for (const o of occs) {
        if (!o.jobId) continue;
        if (!jobOccs.has(o.jobId)) jobOccs.set(o.jobId, []);
        jobOccs.get(o.jobId)!.push(o);
      }
      const issues: AuditIssue[] = [];
      for (const [, group] of jobOccs) {
        for (let i = 0; i < group.length - 1; i++) {
          const a = group[i];
          const b = group[i + 1];
          if (!a.startAt || !b.startAt) continue;
          // date-handling-allow: elapsed-time — comparing two job startAt
          // instants for "scheduled within 2 days of each other". A ≤1-hour
          // DST drift on the threshold doesn't affect the audit result.
          const diffDays = Math.abs(b.startAt.getTime() - a.startAt.getTime()) / 86400000;
          if (diffDays <= 2) {
            const clientName = (a.job?.property as any)?.client?.displayName ?? "";
            issues.push({
              id: a.id,
              jobId: a.jobId!,
              occurrenceId: a.id,
              description: `${a.job?.property?.displayName ?? "Unknown"}${clientName ? ` (${clientName})` : ""}: two SCHEDULED occurrences ${diffDays < 1 ? "same day" : `${Math.round(diffDays)}d apart`} (${etFormatDate(a.startAt)} & ${etFormatDate(b.startAt)})`,
            });
          }
        }
      }
      results.push({ check: "duplicate_occurrences", label: "Duplicate Repeating Occurrences", issues });
    }

    // 5. Missing next repeating occurrence (completed in last 2 months, no SCHEDULED sibling)
    if (checks.includes("missing_next_occurrence")) {
      // ET-anchored ~60-day window. setMonth(-2) on a UTC Date does
      // calendar-month subtraction (March 31 → February 31 = March 3),
      // an anti-pattern for a fixed-duration window.
      const twoMonthsAgo = etMidnight(etAddDays(etToday(), -60));
      const closed = await prisma.jobOccurrence.findMany({
        where: {
          status: { in: ["CLOSED", "COMPLETED"] },
          workflow: "STANDARD",
          jobId: { not: null },
          completedAt: { gte: twoMonthsAgo },
        },
        select: { id: true, jobId: true, startAt: true, completedAt: true, job: { select: { property: { select: { displayName: true, client: { select: { displayName: true } } } }, frequencyDays: true, status: true } } },
        orderBy: { completedAt: "desc" },
      });
      // For each job, check if there's at least one SCHEDULED occurrence
      const jobIds = [...new Set(closed.map((o) => o.jobId).filter(Boolean))] as string[];
      const scheduled = await prisma.jobOccurrence.findMany({
        where: {
          jobId: { in: jobIds },
          status: "SCHEDULED",
          workflow: "STANDARD",
        },
        select: { jobId: true },
      });
      const hasScheduled = new Set(scheduled.map((o) => o.jobId));
      // Check which jobs have a PENDING_PAYMENT occurrence (next will auto-create on payment)
      const pendingPayment = await prisma.jobOccurrence.findMany({
        where: { jobId: { in: jobIds }, status: "PENDING_PAYMENT" },
        select: { jobId: true },
      });
      const hasPending = new Set(pendingPayment.map((o) => o.jobId));
      // Stream-paused jobs — a STREAM_PAUSED occurrence means the
      // recurring stream is intentionally paused, so no next
      // SCHEDULED is expected until the stream resumes. Distinct
      // from Job.status = "PAUSED" (paused-job level) which the
      // check below already handles. See schema.prisma comment on
      // JobOccurrenceStatus.STREAM_PAUSED.
      const streamPaused = await prisma.jobOccurrence.findMany({
        where: { jobId: { in: jobIds }, status: "STREAM_PAUSED" },
        select: { jobId: true },
      });
      const hasStreamPaused = new Set(streamPaused.map((o) => o.jobId));
      const issues: AuditIssue[] = [];
      const seen = new Set<string>();
      for (const o of closed) {
        if (!o.jobId || hasScheduled.has(o.jobId) || seen.has(o.jobId)) continue;
        if (o.job?.status === "ARCHIVED") continue;
        if (hasStreamPaused.has(o.jobId)) continue;
        if (!o.job?.frequencyDays || o.job.frequencyDays <= 0) continue;
        seen.add(o.jobId);
        const clientName = (o.job?.property as any)?.client?.displayName ?? "";
        const isPending = hasPending.has(o.jobId);
        issues.push({
          id: o.id,
          jobId: o.jobId,
          occurrenceId: o.id,
          description: isPending
            ? `${o.job?.property?.displayName ?? "Unknown"}${clientName ? ` (${clientName})` : ""}: awaiting payment — next occurrence will auto-create when payment is accepted (freq: ${o.job?.frequencyDays}d). Not a problem yet.`
            : `${o.job?.property?.displayName ?? "Unknown"}${clientName ? ` (${clientName})` : ""}: completed ${o.completedAt ? etFormatDate(o.completedAt) : "?"} but no next SCHEDULED occurrence found (freq: ${o.job?.frequencyDays}d)`,
        });
      }
      results.push({ check: "missing_next_occurrence", label: "Missing Next Repeating Occurrence", issues });
    }

    // 6. Time estimate mismatch on repeating jobs (median actual differs from
    //    estimate by >25%). Split into two audit checks that share the same
    //    data pipeline: `time_estimate_mismatch` (warning severity) fires when
    //    at least one recent occurrence has unapproved hours, so the operator
    //    can still act by reviewing/adjusting before approving. `stale_estimate`
    //    (info severity) fires when everything's already approved — the
    //    actuals are blessed and the estimate itself is stale, so the
    //    actionable is to update the estimate to match reality.
    if (checks.includes("time_estimate_mismatch") || checks.includes("stale_estimate")) {
      const jobs = await prisma.job.findMany({
        where: {
          status: "ACCEPTED",
          frequencyDays: { gt: 0 },
          estimatedMinutes: { not: null, gt: 0 },
        },
        select: {
          id: true,
          estimatedMinutes: true,
          property: { select: { displayName: true, client: { select: { displayName: true } } } },
        },
      });
      const jobIds = jobs.map((j) => j.id);
      const completedOccs = jobIds.length > 0 ? await prisma.jobOccurrence.findMany({
        where: {
          jobId: { in: jobIds },
          status: { in: ["CLOSED", "COMPLETED", "PENDING_PAYMENT"] },
          startedAt: { not: null },
          completedAt: { not: null },
        },
        select: {
          jobId: true,
          startedAt: true,
          completedAt: true,
          totalPausedMs: true,
          hoursApprovedAt: true,
          assignees: { select: { role: true } },
        },
        orderBy: { completedAt: "desc" },
      }) : [];
      // Group person-minutes (wall-clock × team size) by jobId, last 8 each.
      // Stored as person-minutes so the median is comparable across runs with
      // different team sizes; consumers divide by current team size for display.
      // Tracks whether each recent occurrence has unapproved hours so the
      // check can skip jobs whose entire rolling window is already blessed.
      const byJob: Record<string, { minutes: number; unapproved: boolean }[]> = {};
      for (const o of completedOccs) {
        if (!o.jobId) continue;
        if (!byJob[o.jobId]) byJob[o.jobId] = [];
        if (byJob[o.jobId].length >= 8) continue;
        if (!o.startedAt || !o.completedAt) continue;
        const wallclockMin = (new Date(o.completedAt).getTime() - new Date(o.startedAt).getTime() - (o.totalPausedMs ?? 0)) / 60000;
        if (wallclockMin <= 0) continue;
        const teamSize = Math.max(1, ((o as any).assignees ?? []).filter((a: any) => a.role !== "observer").length);
        byJob[o.jobId].push({
          minutes: wallclockMin * teamSize,
          unapproved: !o.hoursApprovedAt,
        });
      }
      const fmtDur = (m: number) => {
        const h = Math.floor(m / 60); const mm = Math.round(m % 60);
        return h > 0 ? `${h}h ${mm}m` : `${mm}m`;
      };
      const mismatchIssues: AuditIssue[] = [];
      const staleIssues: AuditIssue[] = [];
      for (const job of jobs) {
        const rows = byJob[job.id] ?? [];
        // Need ≥3 completed occurrences to call it an "average".
        if (rows.length < 3) continue;
        const durations = rows.map((r) => r.minutes);
        const sorted = [...durations].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        const median = sorted.length % 2 === 0
          ? (sorted[mid - 1] + sorted[mid]) / 2
          : sorted[mid];
        const est = job.estimatedMinutes!;
        const discrepancy = Math.abs(median - est) / est;
        if (discrepancy <= 0.25) continue;
        const isOver = median > est;
        const propertyName = (job.property as any)?.displayName ?? "Unknown";
        const clientName = (job.property as any)?.client?.displayName ?? "";
        const unapprovedCount = rows.filter((r) => r.unapproved).length;
        if (unapprovedCount > 0) {
          mismatchIssues.push({
            jobId: job.id,
            description: `${propertyName}${clientName ? ` (${clientName})` : ""}: ${Math.round(discrepancy * 100)}% ${isOver ? "over" : "under"} estimate — avg actual ${fmtDur(median)} vs ${fmtDur(est)} est. (${unapprovedCount} of ${rows.length} recent occurrences awaiting hours approval)`,
          });
        } else {
          staleIssues.push({
            jobId: job.id,
            description: `${propertyName}${clientName ? ` (${clientName})` : ""}: median ${fmtDur(median)} vs ${fmtDur(est)} est. — ${Math.round(discrepancy * 100)}% ${isOver ? "over" : "under"}. All ${rows.length} recent occurrences have hours approved; consider updating the estimate.`,
          });
        }
      }
      if (checks.includes("time_estimate_mismatch")) {
        results.push({ check: "time_estimate_mismatch", label: "Time Estimate Mismatch", issues: mismatchIssues });
      }
      if (checks.includes("stale_estimate")) {
        results.push({ check: "stale_estimate", label: "Stale Estimate", issues: staleIssues });
      }
    }

    if (checks.includes("unclaimed_no_guidance")) {
      // Unclaimed (no assignees) SCHEDULED real jobs with no guidance — guidance is
      // defined as at least one OccurrencePropertyPhoto whose underlying PropertyPhoto
      // has a non-empty description (the photo+description pattern that explains how
      // to do the job).
      const occurrences = await prisma.jobOccurrence.findMany({
        where: {
          status: "SCHEDULED",
          workflow: { in: ["STANDARD", "ONE_OFF"] as any },
          mustBeAssigned: false,
          assignees: { none: {} },
        },
        include: {
          job: {
            include: {
              property: { select: { displayName: true, client: { select: { displayName: true } } } },
            },
          },
          propertyPhotos: {
            include: { propertyPhoto: { select: { description: true } } },
          },
        },
      });
      const issues: AuditIssue[] = [];
      for (const occ of occurrences) {
        const hasGuidance = (occ.propertyPhotos ?? []).some(
          (pp) => !!pp.propertyPhoto?.description?.trim(),
        );
        if (hasGuidance) continue;
        const propertyName = (occ.job?.property as any)?.displayName ?? "Unknown property";
        const clientName = (occ.job?.property as any)?.client?.displayName ?? "";
        issues.push({
          jobId: occ.jobId ?? undefined,
          occurrenceId: occ.id,
          description: `${propertyName}${clientName ? ` (${clientName})` : ""}: unclaimed and no guidance (photos with descriptions) set.`,
        });
      }
      results.push({ check: "unclaimed_no_guidance", label: "Unclaimed Jobs Without Guidance", issues });
    }

    // 8. Ledger expenses with no tax-category mapping.
    //
    // "Mapped" means the row's category resolves to a SCHEDULE C LINE through
    // the EXPENSE_CATEGORIES taxonomy. That is the definition that matches the
    // consequence: the QuickBooks expense export writes one row per expense
    // with a "Schedule C Line" column, and an unmapped row goes out with that
    // column blank. A blank Schedule C line is a deduction nobody can file.
    //
    // Three shapes produce it, and they need different answers:
    //
    //   a. NO CATEGORY AT ALL. Listed per row, because each one is an
    //      individual judgement — only the operator knows that "Gas" is Fuel.
    //   b. A CATEGORY THE TAXONOMY DOES NOT HAVE. Grouped by label, because
    //      this is ONE problem however many rows carry it: a category was
    //      renamed or removed in Settings and left its rows behind. The fix is
    //      a single decision (re-add the label, or retag the rows), so N
    //      findings would be N copies of one question.
    //   c. A CATEGORY WITH A BLANK scheduleCLine. Grouped the same way — the
    //      label exists but carries no line, so the export column is still
    //      empty. Fixed in Settings, once, for every row at once.
    //
    // DELIBERATELY NOT FLAGGED: a category with no `qbAccount`. That is a
    // supported state with its own documented behaviour — the row lands under
    // "Unmapped" in the QB CSV and the operator re-categorizes inside QB after
    // import. It is not a tax-mapping gap, and including it would bury the
    // real findings under rows that are working as designed.
    if (checks.includes("unmapped_expense_tax_category")) {
      const cutoff = await resolveCutoff(req);
      const cats = await loadExpenseCategories(prisma);
      const issues: AuditIssue[] = [];

      // GUARD THE EMPTY-TAXONOMY CASE FIRST.
      //
      // `loadExpenseCategories` swallows a parse error and returns [], so a
      // malformed EXPENSE_CATEGORIES setting would make every single expense
      // look unmapped. That is a flood of hundreds of findings whose real
      // cause is one broken setting — and the flood would hide it. Report the
      // cause instead and stop.
      if (cats.length === 0) {
        issues.push({
          description:
            "The expense-category taxonomy is empty or unreadable, so NO expense can be mapped to a Schedule C line. " +
            "Check Settings \u2192 Catalogs & Taxonomies \u2192 Expense Categories; if the JSON is malformed the app falls back to an empty list. " +
            "Per-expense findings are suppressed until this is fixed, because every row would be reported.",
        });
        results.push({
          check: "unmapped_expense_tax_category",
          label: "Expenses Without a Tax Category",
          issues,
        });
      } else {
        const mapped = new Set(
          cats.filter((c) => c.scheduleCLine.trim() !== "").map((c) => c.label),
        );
        // Labels that exist but carry no Schedule C line — shape (c). Tracked
        // separately so the finding can say "has no line" rather than the
        // misleading "is not in the taxonomy".
        const lineless = new Set(
          cats.filter((c) => c.scheduleCLine.trim() === "").map((c) => c.label),
        );

        const rows = await prisma.businessExpense.findMany({
          // EXPENSE only. CAPITAL_CONTRIBUTION and OWNER_DRAW are equity
          // movements, not deductions — they have no Schedule C line by
          // definition and flagging them would be noise.
          where: { type: "EXPENSE", ...cutoffWhere("BusinessExpense", cutoff) },
          select: {
            id: true, date: true, cost: true, category: true,
            description: true, vendor: true,
          },
          orderBy: { date: "desc" },
        });

        // Grouped shapes (b) and (c): label -> row count + dollars.
        const unknownLabels = new Map<string, { n: number; total: number; lineless: boolean }>();

        for (const r of rows) {
          const label = (r.category ?? "").trim();
          if (label !== "" && mapped.has(label)) continue;

          if (label === "") {
            // Shape (a) — per row. Carries date, amount and whatever the
            // operator wrote, because those are what make it findable in the
            // Ledger; there is no deep-link target for a ledger row.
            const what = (r.description ?? "").trim() || (r.vendor ?? "").trim() || "no description";
            issues.push({
              id: r.id,
              description: `${etFormatDate(r.date)} \u00b7 $${r.cost.toFixed(2)} \u00b7 ${what} \u2014 no category set, so it has no Schedule C line.`,
            });
            continue;
          }
          const cur = unknownLabels.get(label) ?? { n: 0, total: 0, lineless: lineless.has(label) };
          cur.n += 1;
          cur.total += r.cost;
          unknownLabels.set(label, cur);
        }

        // Grouped findings after the per-row ones, largest dollar first — the
        // money is the better ordering than the row count when deciding what
        // to fix.
        for (const [label, g] of [...unknownLabels].sort((a, b) => b[1].total - a[1].total)) {
          issues.push({
            description: g.lineless
              ? `${g.n} ${g.n === 1 ? "expense" : "expenses"} ($${g.total.toFixed(2)}) use category "${label}", which has no Schedule C line set. Set its line in Settings \u2192 Expense Categories and all ${g.n} are fixed at once.`
              : `${g.n} ${g.n === 1 ? "expense" : "expenses"} ($${g.total.toFixed(2)}) use category "${label}", which is not in the expense-category taxonomy \u2014 so none of them map to a Schedule C line. Either add that category in Settings or retag the rows.`,
          });
        }

        results.push({
          check: "unmapped_expense_tax_category",
          label: "Expenses Without a Tax Category",
          issues,
        });
      }
    }

    return { results };
  });
  app.get("/business-expenses", req_booksView, async (req: any) => {
    const q = (req.query || {}) as {
      from?: string;
      to?: string;
      category?: string;
      q?: string;
      limit?: string;
      offset?: string;
      all?: string;
      // Optional type filter: EXPENSE | CAPITAL_CONTRIBUTION | OWNER_DRAW.
      // Unspecified → all types (the unfiltered Accounting view).
      type?: string;
      // When "true", narrow to rows that have an open LedgerFollowup
      // flag. Drives the "Followups only" filter chip on the Ledger tab.
      flagOnly?: string;
      // "reconciled" | "unreconciled" | undefined (all). Filters on
      // BusinessExpense.reconciledAt (null vs set). Drives the
      // reconciliation filter chip on the Ledger tab.
      reconciled?: "reconciled" | "unreconciled";
      // Free-text "Payment From" match — narrow to rows paid via the
      // named account. Case-sensitive exact match against the stored
      // value (the picker's collection is what the operator selected
      // from at write time).
      paymentFrom?: string;
    };
    const where: any = {};
    if (q.from || q.to) {
      // ET-anchored boundaries (etMidnight / etEndOfDay) — match the QB
      // exports and the vs-revenue endpoint exactly. See vs-revenue for the
      // UTC-vs-ET divergence this prevents.
      //
      // Accounting tab is the operator's planning + actual view — it
      // shows EVERY BE row whose date falls in range, including planned
      // expenses on future-dated (not-yet-completed) jobs. That works
      // with a plain BE.date filter because BE.date is auto-synced to
      // the occurrence's effective anchor (`startAt` while not yet
      // completed, `completedAt` once it completes). See
      // deriveJobExpenseDate in services/expenses.ts. QB exports + P&L
      // Report keep the stricter "exclude uncompleted" filter via
      // expenseAnchorDateWhere — those are cash-basis reconciliation
      // surfaces, not planning views.
      where.date = {};
      if (q.from) where.date.gte = etMidnight(q.from as EtDateKey);
      if (q.to) where.date.lte = etEndOfDay(q.to as EtDateKey);
    }
    if (q.category) where.category = q.category;
    if (q.reconciled === "reconciled") where.reconciledAt = { not: null };
    else if (q.reconciled === "unreconciled") where.reconciledAt = null;
    if (q.paymentFrom) where.paymentFrom = q.paymentFrom;
    if (q.type) {
      if (!["EXPENSE", "CAPITAL_CONTRIBUTION", "OWNER_DRAW"].includes(q.type)) {
        throw app.httpErrors.badRequest(`Invalid type: ${q.type}`);
      }
      where.type = q.type;
    }
    if (q.q && q.q.trim()) {
      const term = q.q.trim();
      const orConditions: any[] = [
        { description: { contains: term, mode: "insensitive" } },
        { vendor: { contains: term, mode: "insensitive" } },
        { notes: { contains: term, mode: "insensitive" } },
        // invoiceNumber wasn't in the search set — operators searching
        // by invoice number got zero matches. Added.
        { invoiceNumber: { contains: term, mode: "insensitive" } },
      ];
      // Numeric match on cost. Handles three shapes of operator input:
      //   • "50"        → matches ANY cost with integer part 50
      //                    (i.e. 50.00 through 50.99). Was exact-only
      //                    before, which silently missed 50.42, 50.75, etc.
      //   • "50.75"     → matches costs within ±0.005 of 50.75 — tight
      //                    enough for "specific value" queries, wide enough
      //                    to tolerate Float precision on the stored value.
      //   • "$1,250.00" → same rules after stripping $ , and whitespace.
      // Non-numeric queries just skip this branch and text-search only.
      const cleaned = term.replace(/[$,\s]/g, "");
      const numeric = Number(cleaned);
      if (Number.isFinite(numeric) && numeric > 0) {
        const hasDecimalPoint = cleaned.includes(".");
        if (hasDecimalPoint) {
          orConditions.push({ cost: { gte: numeric - 0.005, lte: numeric + 0.005 } });
        } else {
          orConditions.push({ cost: { gte: numeric, lt: numeric + 1 } });
        }
      }
      where.OR = orConditions;
    }
    // Followups-only narrowing — fetch the entityIds of every OPEN
    // BusinessExpense followup and restrict the BE query to that set.
    // Cheap: single index hit on (entityType, resolvedAt) returns just the
    // ids; the BE query then joins those into its existing where clause.
    if (q.flagOnly === "true") {
      const flagged = await prisma.ledgerFollowup.findMany({
        where: { entityType: "businessExpense", resolvedAt: null },
        select: { entityId: true },
      });
      const ids = flagged.map((f) => f.entityId);
      if (ids.length === 0) {
        return { rows: [], total: 0 };
      }
      where.id = { in: ids };
    }
    // Business Start Date filter — pre-cutoff BusinessExpense rows hidden
    // from the Accounting tab. If a from-date is already set, the cutoff is
    // additive (later bound wins). See lib/businessStartCutoff.ts.
    const cutoff = await resolveCutoff(req);
    if (cutoff) {
      const existingGte = where.date?.gte;
      where.date = {
        ...(where.date ?? {}),
        gte: existingGte && existingGte > cutoff ? existingGte : cutoff,
      };
    }

    // Pagination — limit/offset, applied to the same `where` filter so the
    // page is a slice of the filtered set. `all=true` bypasses the page cap;
    // used by the CSV export so the file contains every matching row.
    const all = q.all === "true";
    const rawLimit = Number(q.limit ?? "20");
    const rawOffset = Number(q.offset ?? "0");
    // Hard ceiling so a malicious or buggy caller can't ask for the whole
    // table when in paged mode. The export path uses `all=true` instead.
    const limit = all ? undefined : Math.min(Math.max(1, isNaN(rawLimit) ? 20 : rawLimit), 200);
    const offset = all ? 0 : Math.max(0, isNaN(rawOffset) ? 0 : rawOffset);

    const include = LEDGER_ROW_INCLUDE;

    const [rows, total] = await Promise.all([
      prisma.businessExpense.findMany({
        where,
        orderBy: { date: "desc" },
        include,
        ...(limit !== undefined ? { take: limit } : {}),
        ...(offset > 0 ? { skip: offset } : {}),
      }),
      prisma.businessExpense.count({ where }),
    ]);

    return { rows, total };
  });
  // Fetch ONE row by id. The list is filtered to a persisted date window
  // (last 30 days by default), so a deep link to an older receipt — the
  // Supplies tab's "Ledger: …" breadcrumb, say — cannot rely on the row being
  // in whatever the list currently holds.
  app.get("/business-expenses/:id", req_booksView, async (req: any) => {
    const row = await prisma.businessExpense.findUnique({
      where: { id: String(req.params.id) },
      include: LEDGER_ROW_INCLUDE,
    });
    if (!row) throw app.httpErrors.notFound("Ledger entry not found.");
    return row;
  });
  // Writing the company's books. `expenses.charge` is "charge the company's
  // own purchases to the business" — someone with `books.view` act against a JOB — and it sits
  // granted to the baseline Admin role by the starter script, so it was the
  // wrong gate for creating a ledger row.
  app.post("/business-expenses", req_expensesCharge, async (req: any) => {
    const uid = await currentUserId(req);
    const b = req.body || {};
    if (!b.description?.trim()) throw app.httpErrors.badRequest("description is required");
    if (b.cost == null || isNaN(Number(b.cost))) throw app.httpErrors.badRequest("cost is required");
    if (!b.date) throw app.httpErrors.badRequest("date is required");
    // Type defaults to EXPENSE for backward compat with existing callers
    // (the dialog always sends one explicitly; the supplies/expenses
    // services rely on the schema default).
    const type = b.type ? String(b.type).toUpperCase() : "EXPENSE";
    if (!["EXPENSE", "CAPITAL_CONTRIBUTION", "OWNER_DRAW"].includes(type)) {
      throw app.httpErrors.badRequest(`Invalid type: ${type}`);
    }
    // A negative cost is how a REFUND is recorded — it nets against the
    // category's total and its Schedule C deduction, which is what a refund
    // does on a cash basis. Not allowed on the equity types: a negative
    // contribution is an owner draw and a negative draw is a contribution,
    // and having two ways to spell each would make the equity section
    // ambiguous to total.
    if (Number(b.cost) < 0 && type !== "EXPENSE") {
      throw app.httpErrors.badRequest(
        type === "CAPITAL_CONTRIBUTION"
          ? "A negative contribution is an owner draw — use the Owner Draw type instead."
          : "A negative draw is a capital contribution — use the Capital Contribution type instead.",
      );
    }
    const trimmedCategory = b.category ? String(b.category).trim() : null;
    // Schedule C category is meaningful only for EXPENSE. Silently drop on
    // equity entries — they post to QB equity accounts, not P&L categories.
    if (type === "EXPENSE" && trimmedCategory) {
      if (!(await loadCategoryLabels()).has(trimmedCategory)) {
        throw app.httpErrors.badRequest(`Invalid category: "${trimmedCategory}". Must be a Schedule C line.`);
      }
    }
    const equipmentId = b.equipmentId ? String(b.equipmentId) : null;
    if (equipmentId) {
      if (type !== "EXPENSE") {
        throw app.httpErrors.badRequest("Only expenses can link to equipment.");
      }
      const exists = await prisma.equipment.findUnique({ where: { id: equipmentId }, select: { id: true } });
      if (!exists) throw app.httpErrors.badRequest(`Equipment not found: ${equipmentId}`);
    }
    const recurrence = b.recurrence ? String(b.recurrence).toUpperCase() : null;
    if (recurrence && !["WEEKLY", "MONTHLY", "QUARTERLY", "ANNUALLY"].includes(recurrence)) {
      throw app.httpErrors.badRequest("recurrence must be WEEKLY, MONTHLY, QUARTERLY, or ANNUALLY");
    }
    // Series id derivation for recurring rows. Three cases, in priority:
    //   1. sourceExpenseId provided (the Record-flow path) — copy the
    //      source row's recurrenceSeriesId. This is what keeps the
    //      series welded together across months even if the label text
    //      drifts. If the source row itself has no series id (legacy
    //      row created pre-backfill), mint one and stamp both rows.
    //   2. No source but recurrence set — mint a fresh series id so
    //      future Record-flow inserts on this row can inherit it.
    //   3. No recurrence — series id stays null; not a recurring row.
    // sourceExpenseId is validated in-house rather than trusted from the
    // client: if the caller sends a garbage id we treat it as absent
    // rather than 400ing (fail-open — the row still gets created, just
    // with a fresh series id instead of the intended inheritance).
    let recurrenceSeriesId: string | null = null;
    if (recurrence) {
      const rawSourceId = b.sourceExpenseId ? String(b.sourceExpenseId) : null;
      if (rawSourceId) {
        const source = await prisma.businessExpense.findUnique({
          where: { id: rawSourceId },
          select: { id: true, recurrenceSeriesId: true },
        });
        if (source) {
          if (source.recurrenceSeriesId) {
            recurrenceSeriesId = source.recurrenceSeriesId;
          } else {
            // Source predates the migration — mint an id and stamp it on
            // the source so subsequent Records inherit the same id.
            recurrenceSeriesId = randomUUID();
            await prisma.businessExpense.update({
              where: { id: source.id },
              data: { recurrenceSeriesId },
            });
          }
        }
      }
      if (!recurrenceSeriesId) recurrenceSeriesId = randomUUID();
    }
    const created = await prisma.$transaction(async (tx) => {
      const row = await tx.businessExpense.create({
        data: {
          ledgerId: generateLedgerId(),
          createdById: uid,
          type: type as any,
          description: String(b.description).trim(),
          cost: Number(b.cost),
          date: parseUserDate(String(b.date)),
          category: type === "EXPENSE" ? trimmedCategory : null,
          // Vendor + invoice are expense-only — no external vendor/invoice
          // exists for owner contributions or draws.
          vendor: type === "EXPENSE" && b.vendor ? String(b.vendor).trim() : null,
          invoiceNumber: type === "EXPENSE" && b.invoiceNumber ? String(b.invoiceNumber).trim() : null,
          // paymentFrom applies to every entry type — equity entries (capital
          // contributions / owner draws) have a source/destination too. Pure
          // free-text operator note; never tax-relevant.
          paymentFrom: b.paymentFrom ? String(b.paymentFrom).trim() : null,
          notes: b.notes ? String(b.notes).trim() : null,
          equipmentId: type === "EXPENSE" ? equipmentId : null,
          recurrence: recurrence as any,
          recurrenceSeriesId,
        },
      });
      // Money: creates a Schedule C tax-ledger row that lands in the QB /
      // tax exports and moves the P&L.
      await writeAudit(tx, AUDIT.EXPENSE.CREATED, uid, {
        businessExpenseId: row.id,
        ledgerId: row.ledgerId,
        action: "business_expense_created",
        type: row.type,
        description: row.description,
        costBefore: null,
        costAfter: row.cost,
        date: etFormatDate(row.date),
        category: row.category,
        vendor: row.vendor,
        invoiceNumber: row.invoiceNumber,
        equipmentId: row.equipmentId,
        recurrence: row.recurrence,
        recurrenceSeriesId: row.recurrenceSeriesId,
      });
      return row;
    });
    // For recurring rows, tell the client when the next instance is
    // expected so the success toast can say "Next occurrence expected
    // Aug 15." — matches the copy on repeating jobs' payment-accepted
    // toasts.
    const nextExpectedDate = recurrence
      ? etFormatDate(nextRecurrenceDate(created.date, recurrence))
      : null;
    return { ...created, nextExpectedDate };
  });
  // Pre-flight for the Add Entry dialog: does an existing recurring
  // series soft-match the description/vendor/type the operator is about
  // to create? Returns up to 5 candidates so the dialog can prompt
  // "Looks like a continuation of your existing 'Vercel — App hosting'
  // series — join it?" — solving the second half of the Vercel bug
  // where creating a fresh row via Add Entry (instead of Record) would
  // fork the stream even after the recurrenceSeriesId model landed.
  //
  // Soft match logic (loose on purpose — we're offering a hint, not an
  // auto-merge): normalized (lowercased + trimmed + punctuation-stripped)
  // description equality, plus type match, plus normalized vendor
  // equality when either side has a vendor. Empty vendor on both sides
  // is also a match.
  //
  // Never returns non-recurring rows — a hint only makes sense against
  // an existing series. Also filters out rows already flagged with the
  // legacy null seriesId to avoid suggesting joining a pre-backfill
  // ghost. If backfill hasn't run yet, the endpoint returns nothing and
  // the dialog falls back to its "no hint" mode.
  app.get("/business-expenses/match-recurring", req_booksView, async (req: any) => {
    const q = (req.query || {}) as { description?: string; vendor?: string; type?: string };
    const rawDesc = (q.description ?? "").toString();
    const rawVendor = (q.vendor ?? "").toString();
    const rawType = (q.type ?? "EXPENSE").toString().toUpperCase();
    // Normalize aggressively: lowercase, drop everything that isn't
    // alphanumeric, collapse whitespace. Same rule on both sides so a
    // one-character label drift on either the current row or the
    // candidate history still matches.
    const norm = (s: string): string =>
      s
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    const targetDesc = norm(rawDesc);
    const targetVendor = norm(rawVendor);
    if (targetDesc.length === 0) return { candidates: [] };
    if (!["EXPENSE", "CAPITAL_CONTRIBUTION", "OWNER_DRAW"].includes(rawType)) {
      return { candidates: [] };
    }
    // Load all recurring rows of the matching type that have a series
    // id. Bounded set in practice (<100 recurring series total per
    // business); no need for a DB-side filter beyond type + not-null.
    const rows = await prisma.businessExpense.findMany({
      where: {
        type: rawType as any,
        recurrence: { not: null },
        recurrenceSeriesId: { not: null },
        occurrenceId: null,
        supplyPurchases: { none: {} },
      },
      orderBy: { date: "desc" },
      select: {
        id: true,
        recurrenceSeriesId: true,
        description: true,
        vendor: true,
        cost: true,
        date: true,
        recurrence: true,
        recurrenceEndedAt: true,
      },
    });
    // Dedupe by series — return the most recent row per series only.
    const bySeries = new Map<string, typeof rows[number]>();
    for (const r of rows) {
      if (!r.recurrenceSeriesId) continue;
      if (!bySeries.has(r.recurrenceSeriesId)) bySeries.set(r.recurrenceSeriesId, r);
    }
    const candidates = Array.from(bySeries.values())
      // Ended-series filter — if the operator intentionally ended a
      // series, don't quietly suggest grafting a new row back onto it.
      // They can Restart from the ended row's Edit dialog if they
      // actually want to resume.
      .filter((r) => r.recurrenceEndedAt == null)
      .filter((r) => {
        if (norm(r.description ?? "") !== targetDesc) return false;
        // Vendor match: both empty is fine, both non-empty must match
        // after normalization, one empty and one non-empty doesn't match
        // (we shouldn't suggest joining a Vercel-vendor series when the
        // operator hasn't set a vendor — that's a real difference).
        const rNorm = norm(r.vendor ?? "");
        return rNorm === targetVendor;
      })
      .slice(0, 5)
      .map((r) => ({
        seriesId: r.recurrenceSeriesId!,
        latestId: r.id,
        description: r.description,
        vendor: r.vendor,
        latestCost: r.cost,
        latestDate: etFormatDate(r.date),
        recurrence: r.recurrence,
      }));
    return { candidates };
  });
  app.patch("/business-expenses/:id", req_booksManage, async (req: any) => {
    const uid = await currentUserId(req);
    const id = String(req.params.id);
    const b = req.body || {};
    const data: any = {};
    if ("description" in b) data.description = String(b.description ?? "").trim();
    if ("cost" in b) data.cost = Number(b.cost);
    if ("date" in b) data.date = b.date ? parseUserDate(String(b.date)) : null;
    // Type can be changed (e.g., misclassified entry), but only on
    // freestanding rows — job-paired and supply-paired BEs are always
    // EXPENSE by construction. Blocked below after we know the link status.
    let nextType: string | null = null;
    if ("type" in b) {
      const t = String(b.type ?? "").toUpperCase();
      if (!["EXPENSE", "CAPITAL_CONTRIBUTION", "OWNER_DRAW"].includes(t)) {
        throw app.httpErrors.badRequest(`Invalid type: ${t}`);
      }
      nextType = t;
    }
    if ("category" in b) {
      const trimmedCategory = b.category ? String(b.category).trim() : null;
      if (trimmedCategory && !(await loadCategoryLabels()).has(trimmedCategory)) {
        throw app.httpErrors.badRequest(`Invalid category: "${trimmedCategory}". Must be a Schedule C line.`);
      }
      data.category = trimmedCategory;
    }
    if ("vendor" in b) data.vendor = b.vendor ? String(b.vendor).trim() : null;
    if ("invoiceNumber" in b) data.invoiceNumber = b.invoiceNumber ? String(b.invoiceNumber).trim() : null;
    if ("paymentFrom" in b) data.paymentFrom = b.paymentFrom ? String(b.paymentFrom).trim() : null;
    if ("notes" in b) data.notes = b.notes ? String(b.notes).trim() : null;
    if ("equipmentId" in b) {
      const equipmentId = b.equipmentId ? String(b.equipmentId) : null;
      if (equipmentId) {
        const exists = await prisma.equipment.findUnique({ where: { id: equipmentId }, select: { id: true } });
        if (!exists) throw app.httpErrors.badRequest(`Equipment not found: ${equipmentId}`);
      }
      data.equipmentId = equipmentId;
    }
    if ("recurrence" in b) {
      const r = b.recurrence ? String(b.recurrence).toUpperCase() : null;
      if (r && !["WEEKLY", "MONTHLY", "QUARTERLY", "ANNUALLY"].includes(r)) {
        throw app.httpErrors.badRequest("recurrence must be WEEKLY, MONTHLY, QUARTERLY, or ANNUALLY");
      }
      data.recurrence = r;
    }

    // Load the existing row up front — needed for the no-op type
    // comparison below, the link-status guards, AND the
    // reconciliation-auto-clear check further down.
    const existing = await prisma.businessExpense.findUnique({
      where: { id },
      select: {
        type: true,
        cost: true,
        date: true,
        reconciledAt: true,
        ledgerId: true,
        description: true,
        category: true,
        vendor: true,
        invoiceNumber: true,
        recurrence: true,
      },
    });
    if (!existing) throw app.httpErrors.notFound("Expense not found.");

    // If this BE is the tax-ledger pair of a job-level Expense, mirror
    // cost/description so the worker's payout deduction stays in sync with
    // the ledger. Other fields (category/vendor/date/etc) live only on the BE.
    const linkedExpense = await prisma.invoiceCharge.findFirst({
      where: { businessExpenseId: id },
      select: { id: true },
    });
    // If this BE is paired with a SupplyPurchase (step-3), edits to
    // cost/quantity-effecting fields must be routed through the Supplies tab
    // — direct editing here would desync the SupplyPurchase row, the per-unit
    // cost stored on the Supply, and onHand. Block cost/description edits in
    // that case; tax-only fields (vendor, invoiceNumber, notes, date) are
    // safe to edit directly on the BE.
    const linkedSupplyPurchase = await prisma.supplyPurchase.findFirst({
      where: { businessExpenseId: id },
      select: { id: true, supply: { select: { name: true } } },
    });
    if (linkedSupplyPurchase && ("cost" in data || "description" in data)) {
      throw app.httpErrors.badRequest(
        `This expense is linked to a supply purchase (${linkedSupplyPurchase.supply.name}). To change cost or description, edit the purchase from the Supplies tab.`,
      );
    }
    // Type changes only allowed on freestanding rows. Job-paired and
    // supply-paired BEs are always EXPENSE; changing them to equity would
    // break the linked Expense/SupplyPurchase semantics.
    //
    // Only treat this as a "type change" when the incoming value
    // actually differs from what's stored. The frontend posts the
    // whole record back when saving an edit, so `type` is present in
    // the body even when the operator is only updating notes / vendor
    // / etc. Comparing to `existing.type` avoids false-positive
    // rejections of pure metadata edits on linked expenses.
    if (nextType !== null && nextType !== existing.type) {
      if (linkedExpense || linkedSupplyPurchase) {
        throw app.httpErrors.badRequest(
          "Cannot change type on an expense linked to a job or supply purchase.",
        );
      }
      data.type = nextType;
      // Clearing fields that are meaningless on equity entries — avoid
      // misleading badges or stale category labels after a re-type.
      // Vendor + invoiceNumber follow the same rule: no external party
      // exists for owner contributions/draws.
      if (nextType !== "EXPENSE") {
        data.category = null;
        data.equipmentId = null;
        data.vendor = null;
        data.invoiceNumber = null;
      }
    }

    // Same negative-cost rule as the create path, applied to the type this
    // row will END UP as. Checked here rather than beside the cost
    // assignment because the type may be changing in the same request —
    // editing a refund into a capital contribution has to be caught.
    {
      const finalType = nextType ?? existing.type;
      const finalCost = "cost" in b ? Number(b.cost) : existing.cost;
      if (finalCost < 0 && finalType !== "EXPENSE") {
        throw app.httpErrors.badRequest(
          finalType === "CAPITAL_CONTRIBUTION"
            ? "A negative contribution is an owner draw — use the Owner Draw type instead."
            : "A negative draw is a capital contribution — use the Capital Contribution type instead.",
        );
      }
    }

    // Auto-clear reconciliation on any material edit. A row marked
    // Reconciled says "the amount + date on this ledger row match
    // QuickBooks" — if either changes, the match no longer holds and
    // leaving the chip green would silently mislead the operator.
    // Description / vendor / notes / category are considered cosmetic
    // (QB doesn't care about display strings), so they don't trigger.
    //
    // Only fires when there's an ACTUAL change vs. the stored value —
    // the frontend echoes the full record on Save, so cost + date
    // are always present in the body even for pure notes edits.
    // Comparing to `existing.*` avoids false-positive clears.
    //
    // Only fires when the row was Reconciled to begin with — no point
    // re-writing null → null.
    if (existing.reconciledAt) {
      const costChanged = "cost" in data && data.cost !== existing.cost;
      const dateChanged =
        "date" in data &&
        !!data.date &&
        (data.date as Date).getTime() !== existing.date.getTime();
      if (costChanged || dateChanged) {
        data.reconciledAt = null;
        data.reconciledById = null;
      }
    }
    const updated = await prisma.$transaction(async (tx) => {
      const updated = await tx.businessExpense.update({ where: { id }, data });
      // NO WRITE-THROUGH TO THE JOB. Editing a ledger row used to mirror
      // cost/description onto the linked invoice charge — so correcting a
      // receipt silently changed what a CLIENT was billed on a job, and on a
      // many-to-one breadcrumb it would change the wrong job entirely.
      //
      // The two books reconcile in aggregate only. See
      // docs/features/job-materials.md.
      const syncedFields: string[] = [];
      // Money: edits a Schedule C tax-ledger row. It does NOT touch any job
      // or any payout. A cost/date change silently clears the QuickBooks
      // reconciliation.
      await writeAudit(tx, AUDIT.EXPENSE.UPDATED, uid, {
        businessExpenseId: id,
        ledgerId: existing.ledgerId,
        action: "business_expense_updated",
        changedFields: Object.keys(data),
        costBefore: existing.cost,
        costAfter: "cost" in data ? data.cost : existing.cost,
        dateBefore: etFormatDate(existing.date),
        dateAfter: data.date ? etFormatDate(data.date as Date) : etFormatDate(existing.date),
        typeBefore: existing.type,
        typeAfter: "type" in data ? data.type : existing.type,
        categoryBefore: existing.category,
        categoryAfter: "category" in data ? data.category : existing.category,
        descriptionBefore: existing.description,
        descriptionAfter: "description" in data ? data.description : existing.description,
        vendorBefore: existing.vendor,
        vendorAfter: "vendor" in data ? data.vendor : existing.vendor,
        recurrenceBefore: existing.recurrence,
        recurrenceAfter: "recurrence" in data ? data.recurrence : existing.recurrence,
        reconciliationCleared: "reconciledAt" in data && data.reconciledAt === null,
        reconciledAtBefore: existing.reconciledAt ? existing.reconciledAt.toISOString() : null,
        linkedExpenseId: linkedExpense?.id ?? null,
        linkedExpenseSyncedFields: syncedFields,
      });
      return updated;
    });
    // Same tail as the create endpoint: if the row is (still or now)
    // recurring, echo the next expected date so the client's "Expense
    // updated" toast can trail with the forecast.
    const nextExpectedDate = updated.recurrence
      ? etFormatDate(nextRecurrenceDate(updated.date, String(updated.recurrence)))
      : null;
    return { ...updated, nextExpectedDate };
  });
  // Toggle the "ended" flag on a recurring BusinessExpense series.
  // Accepts ANY row in the series (the panel card sends `latestId`,
  // but by the time it clicks the actual latest may have shifted if
  // another instance was recorded in another tab). We defensively
  // re-derive the latest row from the seriesId inside the endpoint
  // so the flag always lands on the current tip.
  //
  // Body: { ended: boolean } — true stamps the flag + actor, false
  // clears both (restart). Idempotent — no-op if you re-send the
  // same value. Applies to all EntryTypes since equity entries can
  // also be recurring (e.g. monthly owner draw).
  app.post("/business-expenses/:id/end-recurrence-series", req_booksManage, async (req: any) => {
    const id = String(req.params.id);
    const uid = await currentUserId(req);
    const b = req.body || {};
    if (typeof b.ended !== "boolean") {
      throw app.httpErrors.badRequest("ended must be a boolean.");
    }
    const source = await prisma.businessExpense.findUnique({
      where: { id },
      select: { id: true, recurrenceSeriesId: true, recurrence: true },
    });
    if (!source) throw app.httpErrors.notFound("Business expense not found.");
    if (!source.recurrence) {
      throw app.httpErrors.badRequest("This row isn't part of a recurring series.");
    }
    // END vs RESTART target different rows deliberately:
    //   • ENDING: stamp the flag on whichever row is CURRENTLY the
    //     latest by date. Only that row governs the panel's "is this
    //     series still active?" check.
    //   • RESTARTING: clear the flag on EVERY row in the series that
    //     carries it. Handles the cross-tab race where the operator
    //     ends series S (flag on row R), then a new instance R' is
    //     recorded elsewhere (making R' the latest), then the
    //     operator opens Edit on R and clicks Restart. If we only
    //     targeted the current latest (R'), R would keep the stale
    //     flag and the "Series ended" badge would stay visible.
    //     Clearing all is idempotent + defensive against any
    //     historical multi-flag state.
    if (b.ended) {
      const latest = source.recurrenceSeriesId
        ? await prisma.businessExpense.findFirst({
            where: { recurrenceSeriesId: source.recurrenceSeriesId },
            orderBy: { date: "desc" },
            select: { id: true },
          })
        : source;
      if (!latest) throw app.httpErrors.notFound("Latest row in series not found.");
      const updated = await prisma.$transaction(async (tx) => {
        const row = await tx.businessExpense.update({
          where: { id: latest.id },
          data: { recurrenceEndedAt: new Date(), recurrenceEndedById: uid },
          include: {
            recurrenceEndedBy: { select: { id: true, displayName: true, email: true } },
          },
        });
        // Records the recurring tax-ledger series being closed out — no
        // further instances will be prompted for or forecast.
        await writeAudit(tx, AUDIT.EXPENSE.UPDATED, uid, {
          businessExpenseId: row.id,
          ledgerId: row.ledgerId,
          action: "recurrence_series_ended",
          recurrenceSeriesId: source.recurrenceSeriesId,
          recurrence: String(source.recurrence),
          requestedFromId: id,
          recurrenceEndedAtBefore: null,
          recurrenceEndedAtAfter: row.recurrenceEndedAt ? row.recurrenceEndedAt.toISOString() : null,
        });
        return row;
      });
      return updated;
    }
    // Restart path — clear flag on every row in the series that has it.
    await prisma.$transaction(async (tx) => {
      let clearedIds: string[] = [];
      if (source.recurrenceSeriesId) {
        // Snapshot which rows carried the flag — updateMany doesn't return
        // them and the flag is gone afterwards.
        const flagged = await tx.businessExpense.findMany({
          where: {
            recurrenceSeriesId: source.recurrenceSeriesId,
            recurrenceEndedAt: { not: null },
          },
          select: { id: true },
        });
        clearedIds = flagged.map((r) => r.id);
        await tx.businessExpense.updateMany({
          where: {
            recurrenceSeriesId: source.recurrenceSeriesId,
            recurrenceEndedAt: { not: null },
          },
          data: { recurrenceEndedAt: null, recurrenceEndedById: null },
        });
      } else {
        await tx.businessExpense.update({
          where: { id: source.id },
          data: { recurrenceEndedAt: null, recurrenceEndedById: null },
        });
        clearedIds = [source.id];
      }
      // Records the series being reopened — future instances get forecast
      // and prompted again across every row that carried the ended flag.
      await writeAudit(tx, AUDIT.EXPENSE.UPDATED, uid, {
        businessExpenseId: source.id,
        action: "recurrence_series_restarted",
        recurrenceSeriesId: source.recurrenceSeriesId,
        recurrence: String(source.recurrence),
        clearedBusinessExpenseIds: clearedIds,
        recurrenceEndedAtAfter: null,
      });
    });
    // Re-fetch the source row so the caller sees its new (null) flag.
    const refetched = await prisma.businessExpense.findUnique({
      where: { id: source.id },
      include: {
        recurrenceEndedBy: { select: { id: true, displayName: true, email: true } },
      },
    });
    return refetched;
  });
  // Toggle the QuickBooks-reconciliation flag on a ledger row.
  // POST with { reconciled: true } stamps reconciledAt + reconciledById
  // to the caller. { reconciled: false } clears both. Idempotent —
  // re-sending the same value is a no-op. Applies to all EntryTypes
  // (EXPENSE, CAPITAL_CONTRIBUTION, OWNER_DRAW).
  app.post("/business-expenses/:id/reconcile", req_booksManage, async (req: any) => {
    const id = String(req.params.id);
    const uid = await currentUserId(req);
    const b = req.body || {};
    if (typeof b.reconciled !== "boolean") {
      throw app.httpErrors.badRequest("reconciled must be a boolean.");
    }
    const existing = await prisma.businessExpense.findUnique({
      where: { id },
      select: { id: true, ledgerId: true, cost: true, date: true, reconciledAt: true, reconciledById: true },
    });
    if (!existing) throw app.httpErrors.notFound("Business expense not found.");
    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.businessExpense.update({
        where: { id },
        data: b.reconciled
          ? { reconciledAt: new Date(), reconciledById: uid }
          : { reconciledAt: null, reconciledById: null },
        include: {
          reconciledBy: { select: { id: true, displayName: true, email: true } },
        },
      });
      // Money: asserts (or retracts) that this ledger row's amount + date
      // match QuickBooks — the sign-off the tax exports lean on.
      await writeAudit(tx, AUDIT.EXPENSE.RECONCILED, uid, {
        businessExpenseId: id,
        ledgerId: existing.ledgerId,
        action: b.reconciled ? "reconciled" : "unreconciled",
        cost: existing.cost,
        date: etFormatDate(existing.date),
        reconciledAtBefore: existing.reconciledAt ? existing.reconciledAt.toISOString() : null,
        reconciledAtAfter: row.reconciledAt ? row.reconciledAt.toISOString() : null,
        reconciledByIdBefore: existing.reconciledById,
        reconciledByIdAfter: row.reconciledById,
      });
      return row;
    });
    return updated;
  });
  app.delete("/business-expenses/:id", req_booksManage, async (req: any) => {
    const uid = await currentUserId(req);
    const id = String(req.params.id);
    // Snapshot the ledger row before anything is destroyed.
    const beBefore = await prisma.businessExpense.findUnique({ where: { id } });
    if (!beBefore) throw app.httpErrors.notFound("Business expense not found.");

    // WHAT HAPPENS TO THE THINGS POINTING AT THIS ROW: they lose the pointer,
    // and nothing else.
    //
    // `businessExpenseId` used to mean two different things — a 1:1 pair from
    // the old dual-write (delete together) or a decorative breadcrumb (unlink)
    // — and only the occurrence's pricingModel told them apart. Getting it
    // backwards destroyed a deduction twice.
    //
    // Unifying the pricing model removed the distinction. A job line is now
    // always a charge the CLIENT was billed, and the ledger row is always the
    // deduction; the two are independent facts. Deleting a receipt must not
    // remove a line a client legitimately paid for, whenever it was written.
    // So there is one behaviour, and no way to pick the wrong one.
    const linked = await prisma.invoiceCharge.findMany({
      where: { businessExpenseId: id },
      select: { id: true, occurrenceId: true, cost: true, description: true },
    });

    // INVENTORY IS NEVER REVERSED HERE. Recording a purchase no longer
    // creates a ledger row, so a ledger row is not evidence that stock
    // arrived — and several purchases may share one receipt. Deleting a
    // receipt must not silently take bags of mulch off the shelf. The
    // purchases just lose their pointer.
    const referencingPurchases = await prisma.supplyPurchase.count({
      where: { businessExpenseId: id },
    });

    await prisma.$transaction(async (tx) => {
      // The FK is SetNull, so the pointers clear themselves.
      await tx.businessExpense.delete({ where: { id } });
      // Destructive money path: removes a Schedule C row from the tax
      // exports. Every destroyed value is captured because nothing else
      // survives.
      await writeAudit(tx, AUDIT.EXPENSE.DELETED, uid, {
        businessExpenseId: id,
        ledgerId: beBefore.ledgerId,
        action: "business_expense_deleted",
        type: beBefore.type,
        description: beBefore.description,
        costBefore: beBefore.cost,
        costAfter: null,
        date: etFormatDate(beBefore.date),
        category: beBefore.category,
        vendor: beBefore.vendor,
        invoiceNumber: beBefore.invoiceNumber,
        paymentFrom: beBefore.paymentFrom,
        notes: beBefore.notes,
        equipmentId: beBefore.equipmentId,
        recurrence: beBefore.recurrence,
        recurrenceSeriesId: beBefore.recurrenceSeriesId,
        reconciledAt: beBefore.reconciledAt ? beBefore.reconciledAt.toISOString() : null,
        receiptR2Key: beBefore.receiptR2Key,
        createdById: beBefore.createdById,
        // Nothing is destroyed any more — every linked job line simply loses
        // its pointer. Recorded so the trail explains what became of them.
        unlinkedInvoiceCharges: linked.map((l) => ({
          invoiceChargeId: l.id,
          occurrenceId: l.occurrenceId,
          cost: l.cost,
          description: l.description,
        })),
        unlinkedSupplyPurchases: referencingPurchases,
        inventoryReversed: false,
      });
    });
    return { deleted: true };
  });
  app.get("/business-expenses/vs-revenue", req_booksView, async (req: any) => {
    // Scoped to the from/to range selected on the Accounting tab — same
    // range that drives the summary, list, and export.
    //
    // Date bounds are ET-anchored (etMidnight / etEndOfDay) to match the
    // QB Income + QB Expenses exports exactly. Naive `new Date(str)` would
    // parse as UTC midnight, which lets payments confirmed Saturday-night ET
    // (= early Sunday UTC) leak into Sunday's bucket on the Accounting tab
    // while staying in Saturday's bucket on the exports — same data, two
    // different totals. ET boundaries fix the divergence.
    const q = (req.query || {}) as { from?: string; to?: string };
    const from = q.from ? etMidnight(q.from as EtDateKey) : null;
    const to = q.to ? etEndOfDay(q.to as EtDateKey) : null;
    const inRange = (d: Date) => (!from || d >= from) && (!to || d <= to);

    // Business Start Date filter — pre-cutoff rows excluded from the P&L
    // calculation. Each table is filtered on its own anchor (see
    // lib/businessStartCutoff.ts).
    const cutoff = await resolveCutoff(req);

    const [payments, allEntries, rentals, fixedAssetMinCost] = await Promise.all([
      // Cash-flow view shows what ACTUALLY moved — confirmed, non-written-off
      // payments only, anchored on `confirmedAt` (the moment the cash hit).
      // This matches the QB Expenses + QB Income exports' filter exactly so
      // the Accounting tab and the export totals always agree. Without these
      // filters, the tab includes pending self-reported payments and
      // written-off ones, which inflates platform fees / margin / processor
      // fees beyond what actually got reported to QB.
      prisma.payment.findMany({
        where: { confirmed: true, writtenOff: false, skippedAt: null, ...cutoffWhere("Payment", cutoff) },
        select: { confirmedAt: true, platformFeeAmount: true, businessMarginAmount: true, processorFeeAmount: true },
      }),
      // One query covers all three EntryType buckets; split by `type`
      // below. Saves a round-trip vs. separate queries. Plain BE.date —
      // BE.date is auto-synced to the occurrence's effective anchor
      // (startAt for planned, completedAt for done), so a date-range
      // filter naturally captures the right rows including planned
      // expenses for future jobs in the selected window. See
      // deriveJobExpenseDate in services/expenses.ts. QB exports +
      // P&L Report use the stricter completion-anchored filter.
      prisma.businessExpense.findMany({
        where: { ...cutoffWhere("BusinessExpense", cutoff) },
        select: { type: true, date: true, cost: true },
      }),
      prisma.checkout.findMany({
        where: { rentalCost: { not: null }, releasedAt: { not: null }, ...cutoffWhere("Checkout", cutoff) },
        select: { releasedAt: true, rentalCost: true },
      }),
      // Same FA threshold the QB Expenses export uses. Loading here keeps
      // the Accounting tab's "Business expenses" line aligned with the
      // export — both exclude capitalized purchases, both surface them
      // on a separate line. See services/exports.ts isFixedAsset.
      loadFixedAssetMinCost(),
    ]);

    let platformFees = 0, businessMargin = 0, equipmentRentals = 0, expenseTotal = 0, processingFees = 0;
    let capitalContributions = 0, ownerDraws = 0, fixedAssetPurchases = 0;
    for (const p of payments) {
      // confirmedAt is non-null because the WHERE clause requires confirmed=true.
      if (!p.confirmedAt || !inRange(p.confirmedAt)) continue;
      platformFees += p.platformFeeAmount ?? 0;
      businessMargin += p.businessMarginAmount ?? 0;
      processingFees += p.processorFeeAmount ?? 0;
    }
    for (const r of rentals) {
      if (!inRange(r.releasedAt!)) continue;
      equipmentRentals += r.rentalCost ?? 0;
    }
    for (const e of allEntries) {
      if (!inRange(e.date)) continue;
      if (e.type === "EXPENSE") {
        // Split: fixed-asset purchases (capitalized — balance sheet) vs
        // regular operating expenses (P&L). Same threshold + start-date
        // policy the QB Expenses CSV uses, so the totals reconcile.
        if (isFixedAsset(e, fixedAssetMinCost)) {
          fixedAssetPurchases += e.cost;
        } else {
          expenseTotal += e.cost;
        }
      }
      else if (e.type === "CAPITAL_CONTRIBUTION") capitalContributions += e.cost;
      else if (e.type === "OWNER_DRAW") ownerDraws += e.cost;
    }

    const round = (n: number) => Math.round(n * 100) / 100;
    const earnings = platformFees + businessMargin + equipmentRentals;
    // Operating net excludes fixed-asset purchases — those are capital
    // expenditures, not operating expenses (matches QB's P&L treatment).
    // FA purchases still hit the bank account so they DO subtract from
    // Net cash change below.
    const operatingNet = earnings - expenseTotal - processingFees;
    const equityNet = capitalContributions - ownerDraws;
    return {
      platformFees: round(platformFees),
      businessMargin: round(businessMargin),
      equipmentRentals: round(equipmentRentals),
      earnings: round(earnings),
      expenses: round(expenseTotal),
      processingFees: round(processingFees),
      fixedAssetPurchases: round(fixedAssetPurchases),
      // Legacy field name preserved for older clients — equals operating net.
      net: round(operatingNet),
      operatingNet: round(operatingNet),
      capitalContributions: round(capitalContributions),
      ownerDraws: round(ownerDraws),
      equityNet: round(equityNet),
      // Net cash change subtracts FA purchases too — they DO leave the
      // bank account even though they don't hit the P&L.
      netCashChange: round(operatingNet + equityNet - fixedAssetPurchases),
    };
  });
  // Summary: totals by today, week, month, year, all time + grouped by category for current period
  app.get("/business-expenses/summary", req_booksView, async (req: any) => {
    const q = (req.query || {}) as { from?: string; to?: string };
    // ET-anchored period starts. Sunday-start to match every other "this
    // week" summary in this file. Naive Date getters would compute UTC
    // boundaries on Vercel — see lib/dates.ts.
    const startOfToday = etMidnight(etToday());
    const startOfWeek = etMidnight(etSundayOnOrBefore());
    const startOfMonth = etMidnight(etStartOfMonth());
    const startOfYear = etMidnight(etStartOfYear());
    // Summary card on the Accounting tab is "expenses only" — by-category
    // breakdown and totals are only meaningful for operating cash-out.
    // Mirrors the list endpoint: plain BE.date filter with no completion
    // check. BE.date is auto-synced to the occurrence's effective anchor,
    // so planned expenses on future-dated jobs show in the period that
    // contains the job's startAt. See the comment in the list endpoint.
    const where: any = { type: "EXPENSE" };
    if (q.from || q.to) {
      // ET-anchored boundaries — same rationale as the list + vs-revenue
      // endpoints. Keeps the summary card on the Accounting tab consistent
      // with the by-category breakdown, the export totals, and the
      // Cash Flow numbers.
      where.date = {};
      if (q.from) where.date.gte = etMidnight(q.from as EtDateKey);
      if (q.to) where.date.lte = etEndOfDay(q.to as EtDateKey);
    }
    // Business Start Date filter — pre-cutoff rows excluded from totals.
    const summaryCutoff = await resolveCutoff(req);
    if (summaryCutoff) {
      const existingGte = where.date?.gte;
      where.date = {
        ...(where.date ?? {}),
        gte: existingGte && existingGte > summaryCutoff ? existingGte : summaryCutoff,
      };
    }
    const all = await prisma.businessExpense.findMany({ where, select: { date: true, cost: true, category: true } });
    let today = 0, thisWeek = 0, thisMonth = 0, thisYear = 0, total = 0;
    const byCategory: Record<string, number> = {};
    for (const e of all) {
      total += e.cost;
      if (e.date >= startOfToday) today += e.cost;
      if (e.date >= startOfWeek) thisWeek += e.cost;
      if (e.date >= startOfMonth) thisMonth += e.cost;
      if (e.date >= startOfYear) thisYear += e.cost;
      const cat = e.category || "(Uncategorized)";
      byCategory[cat] = (byCategory[cat] ?? 0) + e.cost;
    }
    const round = (n: number) => Math.round(n * 100) / 100;
    return {
      today: round(today),
      thisWeek: round(thisWeek),
      thisMonth: round(thisMonth),
      thisYear: round(thisYear),
      total: round(total),
      byCategory: Object.fromEntries(Object.entries(byCategory).map(([k, v]) => [k, round(v)])),
      count: all.length,
    };
  });
  // Worker reconciliation cockpit — per-worker hours + jobs + earnings
  // breakdown for a window, plus period totals and Gusto/QB targets.
  // See services/reconcileWorkers.ts buildReconcileWorkers.
  app.get("/reconcile/period", req_booksView, async (req: any) => {
    const q = (req.query || {}) as { from?: string; to?: string };
    if (!q.from || !q.to || !/^\d{4}-\d{2}-\d{2}$/.test(q.from) || !/^\d{4}-\d{2}-\d{2}$/.test(q.to)) {
      throw app.httpErrors.badRequest("from and to query params required (YYYY-MM-DD).");
    }
    let start = etMidnight(q.from as EtDateKey);
    const end = etEndOfDay(q.to as EtDateKey);
    const cutoff = await resolveCutoff(req);
    if (cutoff && cutoff > start) start = cutoff;
    const { buildReconcileWorkers } = await import("../services/reconcileWorkers");
    return buildReconcileWorkers(start, end, { fromKey: q.from, toKey: q.to });
  });
  app.get("/business-expenses/pnl-report", req_booksView, async (req: any) => {
    const q = (req.query || {}) as { from?: string; to?: string; mode?: string };
    if (!q.from || !q.to) {
      throw app.httpErrors.badRequest("from and to query params required (YYYY-MM-DD).");
    }
    // ET-anchored boundaries — same as the QB exports + vs-revenue endpoint.
    let start = etMidnight(q.from as EtDateKey);
    const end = etEndOfDay(q.to as EtDateKey);
    // Business Start Date filter — pre-cutoff data hidden from every view.
    const cutoff = await resolveCutoff(req);
    if (cutoff && cutoff > start) start = cutoff;
    // Wage-anchor mode. Default (accrual) matches every prior caller;
    // "cash" swaps wages + employer taxes to work-anchored (completedAt)
    // to line up with the workdays CSV / Gusto entry.
    const mode = q.mode === "cash" ? "cash" : "accrual";
    const { buildPnLReport } = await import("../services/pnlReport");
    return buildPnLReport(start, end, { fromStr: q.from, toStr: q.to, mode });
  });
  // Drill-down rows for a specific qbAccount in the P&L. The Preview tab
  // uses this when the operator expands a row — same date range as the
  // report, plus the qbAccount string that identifies which line to
  // detail. See pnlReportDetails in services/pnlReport.ts.
  app.get("/business-expenses/pnl-report/details", req_booksView, async (req: any) => {
    const q = (req.query || {}) as { from?: string; to?: string; qbAccount?: string; mode?: string };
    if (!q.from || !q.to) {
      throw app.httpErrors.badRequest("from and to query params required (YYYY-MM-DD).");
    }
    const qbAccount = (q.qbAccount ?? "").trim();
    if (!qbAccount) {
      throw app.httpErrors.badRequest("qbAccount query param required.");
    }
    let start = etMidnight(q.from as EtDateKey);
    const end = etEndOfDay(q.to as EtDateKey);
    const cutoff = await resolveCutoff(req);
    if (cutoff && cutoff > start) start = cutoff;
    // Mode must match what buildPnLReport was called with, otherwise
    // wage / tax drilldown rows won't sum to the reported bucket total.
    const mode = q.mode === "cash" ? "cash" : "accrual";
    const { pnlReportDetails } = await import("../services/pnlReport");
    return pnlReportDetails(start, end, qbAccount, { mode });
  });
  // Recurring-expense suggestions. Groups freestanding (non-job, non-supply)
  // BEs flagged with a recurrence by (description, vendor); for each group
  // the most recent row drives the next-expected date. Anything overdue or
  // due within the lead-window appears as a suggestion to record.
  app.get("/business-expenses/due-soon", req_booksView, async (_req: any) => {
    const LEAD_DAYS = 7; // suggest 0–7 days before the expected next date
    const now = new Date();
    const horizon = new Date(now); horizon.setDate(horizon.getDate() + LEAD_DAYS);

    // Pull all flagged rows. Exclude BEs paired with a job-Expense or
    // SupplyPurchase — those are event-driven, not calendar-driven.
    // Includes all EntryType values: a recurring owner draw or capital
    // contribution surfaces in the panel just like a recurring software sub.
    const rows = await prisma.businessExpense.findMany({
      where: {
        recurrence: { not: null },
        occurrenceId: null,
        supplyPurchases: { none: {} },
      },
      orderBy: { date: "desc" },
      select: {
        id: true, type: true, date: true, cost: true, description: true, category: true,
        vendor: true, invoiceNumber: true, notes: true, equipmentId: true,
        recurrence: true, recurrenceSkippedUntil: true,
        recurrenceSeriesId: true, recurrenceEndedAt: true,
      },
    });

    // Group by recurrenceSeriesId when set. This is the explicit
    // grouping introduced 2026-07-13 — replaces the fragile legacy key
    // of (type, description, vendor) that forked whenever the label
    // text drifted (Vercel incident: two rows with a one-character
    // description difference showed up as separate series).
    //
    // Fallback for rows still missing a series id (backfill didn't run,
    // or a race between deploy + backfill): key on the legacy
    // (type, description, vendor) tuple. Defense-in-depth so a
    // pre-migration row never gets orphaned out of the Due-to-record
    // panel.
    const seen = new Map<string, typeof rows[number]>();
    for (const r of rows) {
      const key = r.recurrenceSeriesId
        ? `sid::${r.recurrenceSeriesId}`
        : `${r.type}::${(r.description || "").trim().toLowerCase()}::${(r.vendor || "").trim().toLowerCase()}`;
      if (!seen.has(key)) seen.set(key, r);
    }

    const suggestions = Array.from(seen.values())
      // Ended-series filter — MUST run after the group-and-pick
      // (rejecting individual ended rows would let the second-most-
      // recent row keep the series alive in the panel).
      .filter((latest) => latest.recurrenceEndedAt == null)
      .map((latest) => {
        const cadence = String(latest.recurrence);
        const baseNext = nextRecurrenceDate(latest.date, cadence);
        // Skip marker advances the "next expected" by one cadence past the
        // skipped date. Each click of Skip stores the date being skipped.
        const expected =
          latest.recurrenceSkippedUntil && latest.recurrenceSkippedUntil >= baseNext
            ? nextRecurrenceDate(latest.recurrenceSkippedUntil, cadence)
            : baseNext;
        return { latest, expected };
      })
      .filter(({ expected }) => expected <= horizon)
      .sort((a, b) => a.expected.getTime() - b.expected.getTime())
      .map(({ latest, expected }) => ({
        // Pre-fill payload — what the dialog needs to open with everything
        // populated. Cost and date are editable; description/vendor/category
        // copy as-is. `type` carries through so the dialog opens in the
        // right mode (expense vs equity).
        nextExpectedDate: etFormatDate(expected),
        // ET calendar-day diff (DST-safe).
        overdueDays: Math.max(0, etDaysBetween(etFormatDate(expected), etFormatDate(now))),
        recurrence: latest.recurrence,
        type: latest.type,
        prefill: {
          type: latest.type,
          description: latest.description,
          cost: latest.cost,
          category: latest.category,
          vendor: latest.vendor,
          invoiceNumber: null, // invoice numbers are usually unique per period
          notes: null, // notes typically don't repeat
          equipmentId: latest.equipmentId,
          recurrence: latest.recurrence,
        },
        // Reference info for the UI
        latestId: latest.id,
        latestDate: etFormatDate(latest.date),
        latestCost: latest.cost,
      }));

    return suggestions;
  });
  // Cheap count for the alerts dropdown + Tasks page badge. Unlike
  // `/due-soon` above (which surfaces items 0–7 days ahead for the
  // Ledger panel), this counts ONLY items whose expected date is
  // strictly before today (ET) — i.e., actually overdue. Items due
  // today or upcoming don't fire an alert; the operator sees them
  // in the Ledger's Due-to-Record panel. Small bounded set (5–30
  // recurring series in practice), safe to recompute per call.
  // `books.manage`.
  app.get("/business-expenses/due-soon/count", req_booksView, async (_req: any) => {
    const now = new Date();
    const todayKey = etFormatDate(now);
    const rows = await prisma.businessExpense.findMany({
      where: {
        recurrence: { not: null },
        occurrenceId: null,
        supplyPurchases: { none: {} },
      },
      orderBy: { date: "desc" },
      select: {
        type: true, date: true, description: true, vendor: true,
        recurrence: true, recurrenceSkippedUntil: true,
        recurrenceSeriesId: true, recurrenceEndedAt: true,
      },
    });
    // Group by recurrenceSeriesId when set, fall back to legacy key
    // otherwise — mirrors /due-soon above. See the comment there for
    // the rationale.
    const seen = new Map<string, typeof rows[number]>();
    for (const r of rows) {
      const key = r.recurrenceSeriesId
        ? `sid::${r.recurrenceSeriesId}`
        : `${r.type}::${(r.description || "").trim().toLowerCase()}::${(r.vendor || "").trim().toLowerCase()}`;
      if (!seen.has(key)) seen.set(key, r);
    }
    let count = 0;
    for (const latest of seen.values()) {
      // Ended-series filter — matches /due-soon list. Applied after
      // grouping so a series with historical rows but an ended
      // latest row doesn't sneak back into the count.
      if (latest.recurrenceEndedAt != null) continue;
      const cadence = String(latest.recurrence);
      const baseNext = nextRecurrenceDate(latest.date, cadence);
      const expected =
        latest.recurrenceSkippedUntil && latest.recurrenceSkippedUntil >= baseNext
          ? nextRecurrenceDate(latest.recurrenceSkippedUntil, cadence)
          : baseNext;
      // Overdue = expected ET-calendar-day is strictly before today.
      // etDaysBetween(from, to) returns positive when `to` is after
      // `from`, so > 0 means today is past the expected date.
      if (etDaysBetween(etFormatDate(expected), todayKey) > 0) count++;
    }
    return { count };
  });
  // Skip the current expected instance of a recurring BE — the next reminder
  // moves forward by one cadence period. Body: { skipDate: "YYYY-MM-DD" }
  // (the expected date the user is dismissing). Stored on the most recent
  // row of the series; the due-soon endpoint advances past it.
  app.post("/business-expenses/:id/skip-recurrence", req_booksManage, async (req: any) => {
    const uid = await currentUserId(req);
    const id = String(req.params.id);
    const b = req.body || {};
    const be = await prisma.businessExpense.findUnique({
      where: { id },
      select: { id: true, recurrence: true, ledgerId: true, recurrenceSkippedUntil: true },
    });
    if (!be) throw app.httpErrors.notFound("Business expense not found.");
    if (!be.recurrence) {
      throw app.httpErrors.badRequest("This expense isn't flagged as recurring.");
    }
    const skipDateStr = String(b.skipDate ?? "").trim();
    if (!skipDateStr) throw app.httpErrors.badRequest("skipDate is required.");
    const skipDate = new Date(skipDateStr);
    if (isNaN(skipDate.getTime())) {
      throw app.httpErrors.badRequest("skipDate is not a valid date.");
    }
    return prisma.$transaction(async (tx) => {
      const row = await tx.businessExpense.update({
        where: { id },
        data: { recurrenceSkippedUntil: skipDate },
        select: { id: true, recurrenceSkippedUntil: true },
      });
      // Records the operator dismissing one expected instance of a recurring
      // tax-ledger entry — the next reminder moves out by a full period.
      await writeAudit(tx, AUDIT.EXPENSE.UPDATED, uid, {
        businessExpenseId: id,
        ledgerId: be.ledgerId,
        action: "recurrence_instance_skipped",
        recurrence: String(be.recurrence),
        skippedUntilBefore: be.recurrenceSkippedUntil ? etFormatDate(be.recurrenceSkippedUntil) : null,
        skippedUntilAfter: row.recurrenceSkippedUntil ? etFormatDate(row.recurrenceSkippedUntil) : null,
      });
      return row;
    });
  });
  app.get("/export", req_booksView, async (req: any, reply: any) => {

    // Business Start Date filter — pre-cutoff money tables hidden by
    // default. the `books.view` reveal header toggles this off. See
    // lib/businessStartCutoff.ts and services/dataExport.ts.
    const cutoff = await resolveCutoff(req);
    if (cutoff) {
      req.log?.info(
        { cutoff: cutoff.toISOString() },
        "/export running with Business Start Date filter active — pre-cutoff money rows are excluded",
      );
    }
    const { buildDataSnapshot } = await import("../services/dataExport");
    const data = await buildDataSnapshot(cutoff);

    const filename = `seedlings-export-${etToday()}.json`;
    reply
      .header("Content-Type", "application/json; charset=utf-8")
      .header("Content-Disposition", `attachment; filename="${filename}"`)
      .send(JSON.stringify(data, null, 2));
  });
  app.get("/export-summary", req_booksView, async (req: any) => {

    // Business Start Date filter — pre-cutoff money relations hidden via
    // filtered includes. Occurrence rows themselves remain visible (jobs
    // stay on the report) but `payment` resolves to null and `expenses` to
    // [] for pre-cutoff occurrences. See lib/businessStartCutoff.ts.
    const cutoff = await resolveCutoff(req);

    const clients = await prisma.client.findMany({
      orderBy: { displayName: "asc" },
      include: {
        contacts: { orderBy: { isPrimary: "desc" } },
        properties: {
          orderBy: { displayName: "asc" },
          include: {
            pointOfContact: true,
            jobs: {
              orderBy: { createdAt: "asc" },
              include: {
                defaultAssignees: { include: { user: true } },
                occurrences: {
                  orderBy: { startAt: "asc" },
                  include: {
                    assignees: { include: { user: true } },
                    payment: paymentIncludeWithCutoff(cutoff),
                    invoiceCharges: expensesIncludeWithCutoff(cutoff),
                  },
                },
              },
            },
          },
        },
      },
    });

    const users = await prisma.user.findMany({
      orderBy: { displayName: "asc" },
      
    });

    const equipment = await prisma.equipment.findMany({
      orderBy: { brand: "asc" },
      include: {
        checkouts: {
          orderBy: { checkedOutAt: "desc" },
          take: 5,
          include: { user: true },
        },
      },
    });

    const lines: string[] = [];
    const hr = "=".repeat(80);
    const sr = "-".repeat(60);
    // ET-anchored display formatters routed through the canonical
    // etFormatDateOpts helper. Inline Intl.DateTimeFormat is forbidden
    // (see lib/dates.ts header) — using the helper means a TZ change
    // would be a one-line edit, not a sweep.
    const date = (d: Date | string | null | undefined) =>
      d
        ? etFormatDateOpts(new Date(d), {
            year: "numeric",
            month: "short",
            day: "numeric",
          })
        : "—";
    const dateTime = (d: Date | string | null | undefined) =>
      d
        ? etFormatDateOpts(new Date(d), {
            year: "numeric",
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
            timeZoneName: "short",
          })
        : "—";
    const money = (n: number | null | undefined) =>
      n != null ? `$${n.toFixed(2)}` : "—";

    lines.push(`SEEDLINGS LAWN CARE — DATA SUMMARY`);
    lines.push(`Exported: ${dateTime(new Date())}`);
    lines.push(hr);
    lines.push("");

    // ── Users ──
    lines.push("TEAM MEMBERS");
    lines.push(sr);
    for (const u of users) {
      const roles =
        (u as any).customRoles?.map((g: any) => g.customRole?.name).filter(Boolean).join(", ") ||
        "No role";
      lines.push(`  ${u.displayName || u.email || u.id}  (${roles})`);
      if (u.email) lines.push(`    Email: ${u.email}`);
      if (u.phone) lines.push(`    Phone: ${u.phone}`);
      if (u.workerType) lines.push(`    Type: ${u.workerType}`);
      if (u.homeBaseAddress) lines.push(`    Home base: ${u.homeBaseAddress}`);
      lines.push(`    Approved: ${u.isApproved ? "Yes" : "No"}  Joined: ${date(u.createdAt)}`);
    }
    lines.push("");

    // ── Equipment ──
    lines.push("EQUIPMENT");
    lines.push(sr);
    for (const eq of equipment) {
      const eqName = [eq.brand, eq.model].filter(Boolean).join(" ") || eq.shortDesc || eq.id;
      lines.push(`  ${eqName}  [${eq.status}]${eq.type ? "  Type: " + eq.type : ""}`);
      if (eq.shortDesc) lines.push(`    Desc: ${eq.shortDesc}`);
      if (eq.issues) lines.push(`    Issues: ${eq.issues}`);
    }
    lines.push("");

    // ── Clients → Properties → Jobs → Occurrences ──
    lines.push("CLIENTS, PROPERTIES & JOBS");
    lines.push(hr);
    for (const client of clients) {
      lines.push("");
      lines.push(`CLIENT: ${client.displayName}  [${client.status}]  (${client.type})`);
      if ((client as any).isVip) lines.push(`  VIP: Yes${(client as any).vipReason ? " — " + (client as any).vipReason : ""}`);
      if (client.notesInternal) lines.push(`  Notes: ${client.notesInternal}`);
      lines.push(`  Created: ${date(client.createdAt)}`);

      // Contacts
      if (client.contacts.length > 0) {
        lines.push(`  Contacts:`);
        for (const c of client.contacts) {
          const primary = c.isPrimary ? " (PRIMARY)" : "";
          const status = (c as any).status && (c as any).status !== "ACTIVE" ? `  [${(c as any).status}]` : "";
          lines.push(`    - ${c.firstName} ${c.lastName}${primary}${c.role ? " [" + c.role + "]" : ""}${status}`);
          if (c.phone) lines.push(`      Phone: ${c.phone}`);
          if (c.email) lines.push(`      Email: ${c.email}`);
          if ((c as any).nickname) lines.push(`      Nickname: ${(c as any).nickname}`);
        }
      }

      // Properties
      for (const prop of client.properties) {
        lines.push("");
        lines.push(`  PROPERTY: ${prop.displayName}  [${prop.status}]  (${(prop as any).kind ?? ""})`);
        lines.push(`    Address: ${prop.street1}${prop.street2 ? ", " + prop.street2 : ""}, ${prop.city}, ${prop.state} ${prop.postalCode}${(prop as any).country ? " " + (prop as any).country : ""}`);
        if ((prop as any).lotSize) lines.push(`    Lot: ${(prop as any).lotSize} ${(prop as any).lotSizeUnit ?? ""}`);
        if (prop.accessNotes) lines.push(`    Access: ${prop.accessNotes}`);
        if (prop.pointOfContact) {
          const poc = prop.pointOfContact;
          lines.push(`    Point of Contact: ${poc.firstName} ${poc.lastName}${poc.phone ? "  Phone: " + poc.phone : ""}${poc.email ? "  Email: " + poc.email : ""}`);
        }

        // Jobs
        for (const job of prop.jobs) {
          lines.push("");
          lines.push(`    JOB: ${job.kind}  [${job.status}]${job.frequencyDays ? "  Every " + job.frequencyDays + " days" : ""}${job.defaultPrice != null ? "  Default price: " + money(job.defaultPrice) : ""}`);
          if (job.notes) lines.push(`      Notes: ${job.notes}`);

          // Default assignees
          if (job.defaultAssignees.length > 0) {
            lines.push(`      Default crew: ${job.defaultAssignees.map((a: any) => a.user.displayName || a.user.email).join(", ")}`);
          }

          // Occurrences
          if (job.occurrences.length > 0) {
            lines.push(`      Occurrences (${job.occurrences.length}):`);
            for (const occ of job.occurrences) {
              const flags = [
                occ.isOneOff && "one-off",
                occ.isEstimate && "estimate",
                occ.isTentative && "tentative",
              ].filter(Boolean).join(", ");
              const crew = occ.assignees.map((a: any) => a.user.displayName || a.user.email).join(", ");
              lines.push(`        ${date(occ.startAt)}  [${occ.status}]${flags ? "  (" + flags + ")" : ""}  ${money(occ.price)}${crew ? "  Crew: " + crew : ""}`);
              if (occ.notes) lines.push(`          Notes: ${occ.notes}`);
              if (occ.payment) {
                const p = occ.payment;
                lines.push(`          Payment: ${money(p.amountPaid)} via ${p.method} on ${date(p.createdAt)}`);
              }
              if (occ.invoiceCharges.length > 0) {
                for (const ex of occ.invoiceCharges) {
                  lines.push(`          Expense: ${money(ex.cost)} — ${ex.description || "no description"}`);
                }
              }
            }
          }
        }
      }
      lines.push(sr);
    }

    const text = lines.join("\n");
    return { text };
  });
  app.post(
    "/business-expenses/:id/receipt/upload-url",
    req_booksManage,
    async (req: any) => {
      const id = String(req.params.id);
      const b = req.body || {};
      const fileName = String(b.fileName ?? "receipt").trim();
      const contentType = String(b.contentType ?? "image/jpeg");
      if (!/^image\/|^application\/pdf$/.test(contentType)) {
        throw app.httpErrors.badRequest("Receipt must be an image or PDF.");
      }
      const exists = await prisma.businessExpense.findUnique({
        where: { id },
        select: { id: true },
      });
      if (!exists) throw app.httpErrors.notFound("Business expense not found.");
      // Key includes the BE id so the finalize step can verify ownership and
      // so orphaned objects are easy to spot.
      const safeName = fileName.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
      const key = `receipts/${id}/${Date.now()}-${safeName}`;
      const uploadUrl = await getUploadUrl(key, contentType, 300, "receipts");
      return { uploadUrl, key, contentType, fileName: safeName };
    },
  );
  app.post(
    "/business-expenses/:id/receipt",
    req_booksManage,
    async (req: any) => {
      const uid = await currentUserId(req);
      const id = String(req.params.id);
      const b = req.body || {};
      const key = String(b.key ?? "");
      const fileName = String(b.fileName ?? "");
      const contentType = String(b.contentType ?? "");
      // Reject keys that don't belong to this BE — prevents a caller from
      // pointing a different BE at someone else's already-uploaded object.
      if (!key.startsWith(`receipts/${id}/`)) {
        throw app.httpErrors.badRequest("Receipt key does not belong to this expense.");
      }
      // If the BE already had a receipt, delete the old object first.
      const prev = await prisma.businessExpense.findUnique({
        where: { id },
        select: { receiptR2Key: true },
      });
      if (!prev) throw app.httpErrors.notFound("Business expense not found.");
      if (prev.receiptR2Key && prev.receiptR2Key !== key) {
        await deleteObject(prev.receiptR2Key, "receipts").catch(() => {});
      }
      return prisma.$transaction(async (tx) => {
        const row = await tx.businessExpense.update({
          where: { id },
          data: {
            receiptR2Key: key,
            receiptFileName: fileName || null,
            receiptContentType: contentType || null,
            receiptUploadedAt: new Date(),
          },
          select: {
            id: true,
            receiptR2Key: true,
            receiptFileName: true,
            receiptContentType: true,
            receiptUploadedAt: true,
          },
        });
        // Records the tax-substantiation document being attached — and, when
        // it replaced one, the prior R2 object that was destroyed with it.
        await writeAudit(tx, AUDIT.EXPENSE.RECEIPT_ATTACHED, uid, {
          businessExpenseId: id,
          action: "receipt_attached",
          receiptR2KeyBefore: prev.receiptR2Key,
          receiptR2KeyAfter: row.receiptR2Key,
          fileName: row.receiptFileName,
          contentType: row.receiptContentType,
          replacedPreviousReceipt: !!(prev.receiptR2Key && prev.receiptR2Key !== key),
        });
        return row;
      });
    },
  );
  app.get(
    "/business-expenses/:id/receipt-url",
    req_booksView,
    async (req: any) => {
      const id = String(req.params.id);
      const be = await prisma.businessExpense.findUnique({
        where: { id },
        select: { receiptR2Key: true, receiptContentType: true, receiptFileName: true },
      });
      if (!be) throw app.httpErrors.notFound("Business expense not found.");
      if (!be.receiptR2Key) throw app.httpErrors.notFound("No receipt uploaded.");
      const url = await getDownloadUrl(be.receiptR2Key, 3600, "receipts");
      return { url, contentType: be.receiptContentType, fileName: be.receiptFileName };
    },
  );
  app.delete(
    "/business-expenses/:id/receipt",
    req_booksManage,
    async (req: any) => {
      const uid = await currentUserId(req);
      const id = String(req.params.id);
      // Snapshot before the R2 object is destroyed — the receipt is the
      // substantiation for this deduction and nothing else records it.
      const be = await prisma.businessExpense.findUnique({
        where: { id },
        select: {
          ledgerId: true,
          cost: true,
          date: true,
          receiptR2Key: true,
          receiptFileName: true,
          receiptContentType: true,
          receiptUploadedAt: true,
        },
      });
      if (!be) throw app.httpErrors.notFound("Business expense not found.");
      if (be.receiptR2Key) {
        await deleteObject(be.receiptR2Key, "receipts").catch(() => {});
      }
      await prisma.$transaction(async (tx) => {
        await tx.businessExpense.update({
          where: { id },
          data: {
            receiptR2Key: null,
            receiptFileName: null,
            receiptContentType: null,
            receiptUploadedAt: null,
          },
        });
        // Destructive: the R2 receipt object backing this deduction is gone.
        await writeAudit(tx, AUDIT.EXPENSE.RECEIPT_DELETED, uid, {
          businessExpenseId: id,
          ledgerId: be.ledgerId,
          action: "receipt_deleted",
          cost: be.cost,
          date: etFormatDate(be.date),
          receiptR2KeyBefore: be.receiptR2Key,
          receiptR2KeyAfter: null,
          fileName: be.receiptFileName,
          contentType: be.receiptContentType,
          uploadedAt: be.receiptUploadedAt ? be.receiptUploadedAt.toISOString() : null,
        });
      });
      return { deleted: true };
    },
  );
  app.get("/exports/expenses.csv", req_booksExportTax, async (req: any, reply: FastifyReply) => {
    const { start, end } = readDateRange(req);
    const effectiveStart = await clampExportStartToCutoff(req, start);
    const startStr = String(req.query.start);
    const endStr = String(req.query.end);
    const result = await expensesCsv(effectiveStart, end);
    return deliverPlainCsv(req, reply, "expenses", { startStr, endStr }, result.csv);
  });
  app.get("/exports/capital.csv", req_booksExportTax, async (req: any, reply: FastifyReply) => {
    const { start, end } = readDateRange(req);
    const effectiveStart = await clampExportStartToCutoff(req, start);
    const startStr = String(req.query.start);
    const endStr = String(req.query.end);
    const result = await capitalCsv(effectiveStart, end);
    return deliverPlainCsv(req, reply, "capital", { startStr, endStr }, result.csv);
  });
  app.get("/exports/income.csv", req_booksExportTax, async (req: any, reply: FastifyReply) => {
    const { start, end } = readDateRange(req);
    const effectiveStart = await clampExportStartToCutoff(req, start);
    const startStr = String(req.query.start);
    const endStr = String(req.query.end);
    const result = await incomeCsv(effectiveStart, end);
    return deliverPlainCsv(req, reply, "income", { startStr, endStr }, result.csv);
  });
  // Workdays — per-worker daily hours in window. Drives Gusto payroll
  // reconciliation. Intentionally NOT clamped to BUSINESS_START_DATE
  // cutoff (that filter scopes money/audit data, not labor records).
  app.get("/exports/workdays.csv", req_booksExportTax, async (req: any, reply: FastifyReply) => {
    const { start, end } = readDateRange(req);
    const startStr = String(req.query.start);
    const endStr = String(req.query.end);
    const result = await workdaysCsv(start, end);
    return deliverPlainCsv(req, reply, "workdays", { startStr, endStr }, result.csv);
  });
  // Payroll — flat per-worker rows shaped for Gusto entry. Hours +
  // hourly wage + regular wages + additional earnings + total gross +
  // equivalent hourly rate. Same window/cutoff treatment as the
  // reconcile/period endpoint (BUSINESS_START_DATE clamps the lower
  // bound). Service in reconcileWorkers.ts.
  app.get("/exports/payroll.csv", req_booksExportTax, async (req: any, reply: FastifyReply) => {
    let { start, end } = readDateRange(req);
    const startStr = String(req.query.start);
    const endStr = String(req.query.end);
    const cutoff = await resolveCutoff(req);
    if (cutoff && cutoff > start) start = cutoff;
    // Optional userIds narrowing. Tri-state:
    //   • param absent          → no filter (all workers, backward compat)
    //   • ?userIds=             → explicit empty subset (zero rows)
    //   • ?userIds=a,b,c        → restrict to those IDs
    // The frontend picker sends `userIds=<comma-list>` on every
    // payroll request so "unchecked everyone" produces an empty CSV
    // instead of silently reverting to all.
    const rawUserIds = req.query.userIds;
    const userIds: string[] | undefined =
      typeof rawUserIds !== "string"
        ? undefined
        : rawUserIds.split(",").map((s) => s.trim()).filter(Boolean);
    // UI-only export-shape: `?assignToOwner=<comma-list>` transfers each
    // listed userʼs hours and totals to the owner row and zeros out
    // their own row. Never mutates stored data — the current period's
    // splits and workday hours stay intact.
    const rawAssign = req.query.assignToOwner;
    const assignToOwnerIds: string[] | undefined =
      typeof rawAssign !== "string"
        ? undefined
        : rawAssign.split(",").map((s) => s.trim()).filter(Boolean);
    const { payrollCsv } = await import("../services/reconcileWorkers");
    const result = await payrollCsv(start, end, userIds, assignToOwnerIds);
    return deliverPlainCsv(req, reply, "payroll", { startStr, endStr }, result.csv);
  });
  app.get("/ledger-followups/count", req_booksView, async () => {
    const count = await ledgerFollowups.countOpenFollowups();
    return { count };
  });
  app.get("/ledger-followups", req_booksView, async (req: any) => {
    // ?includeResolved=true → history view; default is open-only.
    const includeResolved = req.query?.includeResolved === "true";
    const rows = await ledgerFollowups.listFollowups({ includeResolved });
    return { rows };
  });
  // Map of `${entityType}:${entityId}` → open followup, for the Ledger tab
  // to render flag icons per-row without an N+1.
  app.get("/ledger-followups/map", req_booksView, async () => {
    const map = await ledgerFollowups.openFollowupMap();
    return { map };
  });
  app.post("/ledger-followups", req_booksManage, async (req: any) => {
    const body = (req.body ?? {}) as { entityType?: string; entityId?: string; note?: string | null };
    if (!body.entityType || !body.entityId) {
      throw app.httpErrors.badRequest("entityType and entityId are required");
    }
    const actorId = await currentUserId(req);
    return ledgerFollowups.createFollowup({
      entityType: body.entityType,
      entityId: body.entityId,
      note: body.note ?? null,
      actorId,
    });
  });
  app.patch("/ledger-followups/:id", req_booksManage, async (req: any) => {
    const body = (req.body ?? {}) as { note?: string | null };
    const actorId = await currentUserId(req);
    return ledgerFollowups.updateFollowupNote({
      id: req.params.id,
      note: body.note ?? null,
      actorId,
    });
  });
  app.post("/ledger-followups/:id/resolve", req_booksManage, async (req: any) => {
    const body = (req.body ?? {}) as { resolutionNote?: string | null };
    const actorId = await currentUserId(req);
    return ledgerFollowups.resolveFollowup({
      id: req.params.id,
      resolutionNote: body.resolutionNote ?? null,
      actorId,
    });
  });
  app.delete("/ledger-followups/:id", req_booksManage, async (req: any) => {
    const actorId = await currentUserId(req);
    await ledgerFollowups.deleteFollowup({ id: req.params.id, actorId });
    return { ok: true };
  });
}
