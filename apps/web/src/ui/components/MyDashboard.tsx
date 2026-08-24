"use client";

// ─────────────────────────────────────────────────────────────────────────────
// MyDashboard — the "MY ACTIVITIES" section rendered inside a tab
// (Home tab). Groups the day's hero card with four self-owned banners
// (compliance, workday, mileage, notifications) under one bordered
// hero-variant Dashboard frame so they read as one attention surface.
//
// The hero arrives via `leadContent` rather than being built here: it
// needs the tab's summary fetch, greeting, money strip and workflow
// launcher, none of which belong in a banner-grouping component. This
// component just owns WHERE it sits — pinned under the header, above
// the banners, and OUTSIDE the collapse: folding the section away hides
// the activity rows, never the hero and its CTA.
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

import type { ReactNode } from "react";
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
  leadContent,
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
  /** The tab's hero card. Rendered inside the frame directly under the
   *  header and PINNED — the collapse toggle folds away the banner rows
   *  only, never the hero. Optional so the section still stands alone. */
  leadContent?: ReactNode;
}) {
  const isViewingOther = !!viewAsUserId;
  const title = isViewingOther && viewAsDisplayName
    ? `Activities: ${viewAsDisplayName}`
    : "My activities";
  return (
    <Dashboard
      storageKey={storageKey}
      title={title}
      icon={UserCircle}
      variant="hero"
      pinnedContent={leadContent}
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
