"use client";

// ─────────────────────────────────────────────────────────────────────────────
// MyDashboard — the "self-view banners" section rendered inside a
// tab (Home tab). Groups four self-owned banners
// (compliance, workday, mileage, notifications) under one bordered
// hero-variant Dashboard frame so they read as one attention
// surface.
//
// Owned by the tab (not the shell) because on Admin scope with a
// worker selected the dashboard needs to reflect THAT worker's
// state — the section is view-as aware even if individual banner
// components still need their /api/me/* endpoints extended to
// pass viewAsUserId through (follow-up).
//
// Every banner self-hides when there's nothing to do. Ordered by
// urgency: compliance (may block work) → workday reminders →
// mileage → notifications opt-in.
// ─────────────────────────────────────────────────────────────────────────────

import { UserCircle } from "lucide-react";
import { Dashboard } from "@/src/ui/components/Dashboard";
import { WorkdayBanner, MileageBanner } from "@/src/ui/tabs/JobsTab.workday";
import {
  CompliancePromptBanner,
  NotificationOptInBanner,
} from "@/src/ui/tabs/JobsTab.parts";

export default function MyDashboard({
  storageKey = "seedlings:myDashboardOpen",
  viewAsUserId,
  viewAsDisplayName,
}: {
  /** Persist collapse state per hosting page. */
  storageKey?: string;
  /** When set, the section is scoped to this worker instead of the
   *  logged-in user — surfaces the impersonated worker's compliance
   *  / workday / mileage state so an admin can act on their behalf.
   *  Individual banners consume this prop where they support it. */
  viewAsUserId?: string | null;
  /** Display name for the impersonated worker — drives the section
   *  title so an admin can see whose dashboard they're looking at
   *  ("Dashboard: Bob"). */
  viewAsDisplayName?: string | null;
}) {
  const isViewingOther = !!viewAsUserId;
  const title = isViewingOther && viewAsDisplayName
    ? `Workday: ${viewAsDisplayName}`
    : "My workday";
  return (
    <Dashboard
      storageKey={storageKey}
      title={title}
      icon={UserCircle}
      variant="hero"
    >
      <CompliancePromptBanner viewAsUserId={viewAsUserId ?? null} />
      <WorkdayBanner viewAsUserId={viewAsUserId ?? null} />
      {/* MileageStrip and the push-notification opt-in are inherently
          self-only surfaces:
          - Mileage endpoints (/api/me/mileage/*) enforce
            `driverUserId === caller` server-side — no view-as
            override supported (see routes/worker.ts).
          - Push subscriptions are tied to THIS browser, not to any
            user model.
          Matches the shipped HomeTab behavior of suppressing
          MileageStrip when isViewingOther, and never impersonating
          the push banner. */}
      {!isViewingOther && <MileageBanner />}
      {!isViewingOther && <NotificationOptInBanner />}
    </Dashboard>
  );
}
