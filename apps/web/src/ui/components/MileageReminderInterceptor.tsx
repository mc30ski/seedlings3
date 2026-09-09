"use client";

// ─────────────────────────────────────────────────────────────────────────────
// MileageReminderInterceptor — the post-clock-in / post-clock-out driving-log
// nudge. Mounted ONCE at the app root, next to PolicyGateInterceptor, and
// driven entirely by the `seedlings:mileage-reminder` event that
// lib/workday.ts fires after a successful start/end.
//
// Why global rather than inside the strip: a workday can be started or ended
// from at least four places (WorkdayStrip on Tasks, WorkdayBanner in MY
// ACTIVITIES, the start-job gate dialog, the Prepare-for-Work-Day workflow),
// and MileageStrip is not mounted on all of them. One listener at the root
// gives every one of those the same behavior, and there is nothing to keep in
// sync when a fifth surface appears.
//
// It is a REMINDER, not a gate. Both directions are dismissible in one tap
// and dismissing writes nothing:
//   • start — you clocked in, a vehicle is assigned, no session is open.
//   • stop  — you clocked out with a session still running.
// Nothing here blocks the workday transition; by the time this renders, the
// clock has already moved.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useRef, useState } from "react";
import { apiGet } from "@/src/lib/api";
import { bumpWorkday } from "@/src/lib/bus";
import { CompactMileageDialog } from "@/src/ui/components/MileageStrip";

type Vehicle = {
  id: string;
  displayName: string;
  make?: string | null;
  vehicleModel?: string | null;
  year?: number | null;
  currentOdometer?: number | null;
};

type OpenEntry = {
  id: string;
  vehicleId: string;
  startedAt: string;
  startOdometer: number;
  vehicle: Vehicle;
};

type Pending = {
  mode: "start" | "stop";
  vehicles: Vehicle[];
  openEntries: OpenEntry[];
};

export default function MileageReminderInterceptor() {
  const [pending, setPending] = useState<Pending | null>(null);
  // Guards against a second event landing while a prompt is already open
  // (double-tap on End, or two surfaces both reacting). The open dialog
  // wins; a queued second copy would be a dialog the worker never asked
  // for twice.
  const busyRef = useRef(false);

  const consider = useCallback(async (mode: "start" | "stop") => {
    if (busyRef.current) return;
    busyRef.current = true;
    // Set the moment we decide to open, so the `finally` below knows
    // whether to hold the latch for the dialog's lifetime or release it
    // now. Reading it off a ref that a useEffect maintains would race —
    // setPending has not committed by the time `finally` runs.
    let opened = false;
    try {
      // Read the CURRENT truth rather than trusting whatever the caller
      // had in hand — the End Workday dialog can close mileage sessions
      // inline on its way out, and prompting about a session that was
      // just closed there is exactly the kind of stale nag that teaches
      // people to dismiss without reading.
      const [vehicles, openEntries] = await Promise.all([
        mode === "start"
          ? apiGet<Vehicle[]>("/api/me/vehicles").catch(() => [] as Vehicle[])
          : Promise.resolve([] as Vehicle[]),
        apiGet<OpenEntry[]>("/api/me/mileage/open").catch(() => [] as OpenEntry[]),
      ]);
      const opens = Array.isArray(openEntries) ? openEntries : [];
      const vs = Array.isArray(vehicles) ? vehicles : [];

      if (mode === "stop") {
        // Nothing running — nothing to say.
        if (opens.length === 0) return;
        opened = true;
        setPending({ mode, vehicles: [], openEntries: opens });
        return;
      }

      // start: only worth asking when there is a vehicle they could be
      // driving and no session already open on it.
      const withoutSession = vs.filter((v) => !opens.some((o) => o.vehicleId === v.id));
      if (opens.length > 0 || withoutSession.length === 0) return;
      opened = true;
      setPending({ mode, vehicles: withoutSession, openEntries: [] });
    } finally {
      // Released here only when we decided NOT to prompt. When a prompt
      // opened, the latch is held until it closes (the effect below).
      if (!opened) busyRef.current = false;
    }
  }, []);

  useEffect(() => {
    if (pending == null) busyRef.current = false;
  }, [pending]);

  useEffect(() => {
    const onPrompt = (ev: Event) => {
      const mode = (ev as CustomEvent<{ mode?: "start" | "stop" }>).detail?.mode;
      if (mode !== "start" && mode !== "stop") return;
      void consider(mode);
    };
    window.addEventListener("seedlings:mileage-reminder", onPrompt);
    return () => window.removeEventListener("seedlings:mileage-reminder", onPrompt);
  }, [consider]);

  if (!pending) return null;

  return (
    <CompactMileageDialog
      remind={pending.mode}
      openEntries={pending.openEntries}
      vehiclesWithoutOpenSession={pending.vehicles}
      onClose={() => setPending(null)}
      onDone={() => {
        // The session actually changed — tell every strip and banner so
        // the one the worker is looking at reflects it without a reload.
        // Same broadcast the MileageBanner's own start/stop fires.
        bumpWorkday();
        setPending(null);
      }}
    />
  );
}
