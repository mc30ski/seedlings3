"use client";

// ─────────────────────────────────────────────────────────────────────────────
// The Jobs tab's standing reference — what every card type is, what the
// colours mean, and who is allowed to do what.
//
// This replaces the (i) → "How Jobs Work" modal that used to live inside
// JobsTab. Same material, moved into the collapsed TabExplainer every other
// tab uses, and corrected against the code in the same pass. What changed
// and why, so a future reader can tell drift from a deliberate choice:
//
//   • "When payment is accepted, the next occurrence is created" — it is
//     created when the payment is APPROVED, dated from the visit's own
//     startAt + frequency (not from the approval), and skipped outright when
//     the job is paused, archived, one-off, or a next visit already exists.
//   • "the Job Service's default team" — a default CREW wins over the
//     per-user defaults, and an archived default crew leaves it unassigned.
//   • "Only the claimer can start, complete, accept payment" — or an admin.
//     And a TRAINEE never can, claimer or not.
//   • Claim eligibility was not covered at all: trainees cannot claim,
//     contractors cannot claim more than 2 days out, a crew lead claims for
//     the crew, and a high-value job needs the signed policies that gate it.
//   • "Insured Only" is not a hardcoded insurance check any more. It is the
//     compliance policies that gate JOB_CLAIM above HIGH_VALUE_JOB_THRESHOLD
//     — the seeded one happens to be Insurance.
//   • Reschedule: admins are exempt from the 2-day window but the reason is
//     still required of everyone, and it happens right here, not on Services.
//   • Card colours: closed Events and Followups have their own paler fills,
//     "assigned to someone else" is gray.100 (the legend swatch said
//     gray.50), and high priority is a REMINDER-only flag.
//   • A paused repeating SERVICE is not the deep-orange paused card — it
//     keeps its normal colour and shows a purple pause circle.
//   • Overdue was never explained despite being a chip on the toolbar.
//
// Colours below are the same tokens JobsTab resolves in `cardBg` /
// `cardBorderColor`. If you change one there, change it here — the legend
// swatch is the thing people trust.
// ─────────────────────────────────────────────────────────────────────────────

import { Badge, Box, HStack, Text, VStack } from "@chakra-ui/react";
import TabExplainer, { Em, ExplainerText } from "@/src/ui/components/TabExplainer";

/** Ghost-card fill — mirrors GHOST_CARD_BG in JobsTab. */
const GHOST_BG = "#7c8698";

function SectionTitle({ children, note }: { children: React.ReactNode; note?: string }) {
  return (
    <Box mt={1}>
      <Text fontSize="xs" fontWeight="bold" color="blue.900" textTransform="uppercase" letterSpacing="wide">
        {children}
      </Text>
      {note && <Text fontSize="xs" color="blue.700" mt={0.5}>{note}</Text>}
    </Box>
  );
}

/** One card type, rendered in its own card colour so the legend and the feed
 *  are visibly the same thing. */
function TypeCard({
  label, palette, variant = "solid", bg, borderColor, children, flow,
}: {
  label: string;
  palette: string;
  variant?: "solid" | "subtle" | "outline";
  bg: string;
  borderColor: string;
  children: React.ReactNode;
  flow?: string;
}) {
  return (
    <Box p={2.5} borderWidth="1px" rounded="md" borderColor={borderColor} bg={bg}>
      <Badge colorPalette={palette} variant={variant} mb={1} fontSize="2xs">{label}</Badge>
      <Text fontSize="xs" color="gray.800">{children}</Text>
      {flow && <Text fontSize="2xs" color="gray.600" mt={1}>Flow: {flow}</Text>}
    </Box>
  );
}

/** A key-concept panel — no card colour, just a bordered block. */
function Concept({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Box p={2.5} borderWidth="1px" rounded="md" borderColor="blue.300" bg="white">
      <Text fontSize="xs" fontWeight="semibold" mb={0.5}>{title}</Text>
      <Text fontSize="xs" color="gray.800">{children}</Text>
    </Box>
  );
}

/** Card-colour legend. Kept in one array so a colour and its meaning cannot
 *  drift apart, and so the swatch is literally the card's own fill. */
const COLORS: Array<{ name: string; bg: string; border: string; palette: string; means: string }> = [
  { name: "Teal", bg: "teal.50", border: "teal.300", palette: "teal", means: "Assigned to you — or someone else has it actively in progress" },
  { name: "Yellow", bg: "yellow.50", border: "yellow.300", palette: "yellow", means: "Unassigned — available to claim" },
  { name: "Green", bg: "green.100", border: "green.400", palette: "green", means: "Pending payment — work done, money not in yet" },
  { name: "Orange", bg: "orange.50", border: "orange.300", palette: "orange", means: "Tentative — not yet confirmed by an admin" },
  { name: "Deep orange", bg: "orange.100", border: "orange.400", palette: "orange", means: "Paused — this visit was started and then stopped. Thicker border, like in-progress" },
  { name: "Pink", bg: "pink.50", border: "pink.300", palette: "pink", means: "Estimate" },
  { name: "Blue", bg: "blue.50", border: "blue.300", palette: "blue", means: "Task — yours only" },
  { name: "Purple", bg: "purple.50", border: "purple.300", palette: "purple", means: "Reminder — yours only" },
  { name: "Violet", bg: "purple.200", border: "purple.400", palette: "purple", means: "Announcement — everyone sees it" },
  { name: "Rose", bg: "red.200", border: "red.400", palette: "red", means: "Followup — team-scoped (pale red once completed)" },
  { name: "Amber", bg: "yellow.200", border: "yellow.400", palette: "yellow", means: "Event — team-scoped (pale yellow once completed)" },
  { name: "Gray", bg: "gray.100", border: "gray.300", palette: "gray", means: "Assigned to someone else — waiting on their action" },
  { name: "White", bg: "white", border: "gray.200", palette: "gray", means: "Closed or completed, or an estimate that was accepted or rejected — done, moved on" },
  { name: "Bright purple", bg: "purple.100", border: "purple.500", palette: "purple", means: "High priority. Only a reminder can carry this flag, and it overrides every colour above" },
];

export default function JobsExplainer({
  isAdminView,
  isSuperView,
  workerType,
}: {
  /** Admin-or-super scope — the tab is mounted with purpose="ADMIN" for both. */
  isAdminView: boolean;
  /** True only on the Super tab with a real SUPER role. */
  isSuperView: boolean;
  /** Drives the claim-eligibility paragraph. Trainees and contractors each
   *  have a hard rule the other does not. */
  workerType?: string | null;
}) {
  const role = isSuperView ? "super" : isAdminView ? "admin" : "worker";
  const isTrainee = workerType === "TRAINEE";
  const isContractor = workerType === "CONTRACTOR";

  return (
    <TabExplainer storageKey={`seedlings:jobsTab:guideOpen:${role}`} title="How Jobs work">
      {/* ── Who this feed is, per role ── */}
      {isSuperView ? (
        <>
          <ExplainerText>
            Every occurrence in the business, on one timeline: service visits, estimates,
            your own tasks and reminders, and the team-wide events, followups and
            announcements. You can assign anyone, confirm and reschedule without the
            worker&rsquo;s date window, and create every card type below.
          </ExplainerText>
          <ExplainerText>
            Yours alone, on the elevated row at the bottom of a fully-expanded card:{" "}
            <Em>Reopen</Em> a closed, completed, cancelled or awaiting-payment visit back to
            scheduled, <Em>Force next</Em> on a repeating job stuck in pending payment, and{" "}
            <Em>Archive</Em>. Admins get Cancel there. That row is hidden at the compact card
            densities — tap a card up to full size to reach it.
          </ExplainerText>
        </>
      ) : isAdminView ? (
        <>
          <ExplainerText>
            Every occurrence on one timeline: service visits, estimates, your own tasks and
            reminders, and the team-wide events, followups and announcements. Team events are
            admin-visible only — a worker never sees one in their feed unless they are on it.
          </ExplainerText>
          <ExplainerText>
            You can assign a team, confirm a tentative visit, reschedule without the
            two-day window a worker has, and <Em>Cancel</Em> from the elevated row at the
            bottom of a fully-expanded card. Reopen, Force next and Archive on that row are
            Super-only.
          </ExplainerText>
        </>
      ) : (
        <>
          <ExplainerText>
            Everything scheduled for you, everything still unclaimed, your own tasks and
            reminders, and whatever the office has posted for the team. Card colour tells you
            the state at a glance — the legend is at the bottom.
          </ExplainerText>
          {isTrainee ? (
            <ExplainerText>
              As a trainee you can see and comment, but you cannot <Em>claim</Em> a job, and
              you cannot start, complete or manage one even when you are on the team — a team
              lead takes those actions. Ask to be added to an occurrence rather than claiming
              it.
            </ExplainerText>
          ) : isContractor ? (
            <ExplainerText>
              As a contractor you can only claim a job <Em>within two days</Em> of today —
              anything further out has to wait, or be assigned to you by an admin. A job
              priced above the high-value threshold also needs the policies that gate
              claiming to be signed and current.
            </ExplainerText>
          ) : (
            <ExplainerText>
              You can claim any unclaimed visit that is not tentative or administered, with no
              date window. A job priced above the high-value threshold also needs the policies
              that gate claiming to be signed and current.
            </ExplainerText>
          )}
          {!isTrainee && (
            <ExplainerText>
              If you lead a crew, <Em>Claim for [crew]</Em> takes the whole crew onto the job
              instead of just you. Only the crew&rsquo;s lead can do that, and a job already
              attached to a crew cannot be claimed solo.
            </ExplainerText>
          )}
        </>
      )}

      {/* ── Job types ── */}
      <SectionTitle note="Each type has its own workflow and its own audience.">Service cards</SectionTitle>

      <TypeCard
        label="Repeating" palette="blue" variant="subtle" bg="blue.50" borderColor="blue.300"
        flow="Scheduled → Claim or assign → Start → Complete → Payment approved → next visit created"
      >
        A recurring visit on a cadence (every 14 days, say). The next visit is created when
        the payment is <Em>approved</Em>, and it is dated from this visit&rsquo;s own date plus
        the cadence — not from the day approval landed, so a late approval does not push the
        schedule. If that date has already passed it snaps forward to today. The job&rsquo;s
        default crew is put on it; failing that, its default assignees; failing both, it is
        left unassigned for someone to claim. No next visit is created if the job is paused or
        archived, or if one is already on the books.
      </TypeCard>

      <TypeCard
        label="One-Off" palette="cyan" bg="cyan.50" borderColor="cyan.300"
        flow="Scheduled → Claim or assign → Start → Complete → Payment approved → done"
      >
        A single visit that does not repeat. Nothing is created after payment.
      </TypeCard>

      <TypeCard
        label="Estimate" palette="pink" bg="pink.50" borderColor="pink.300"
        flow="Assign → Start → Complete → Accept or Reject"
      >
        A site visit to price work. Estimates are administered by default, so an admin assigns
        them. After completing, the claimer or an admin accepts or rejects with comments —
        accepting an estimate opens the workflow that creates the client, property and job from
        it. An estimate can stand alone or hang off an existing job.
      </TypeCard>

      <SectionTitle note="Only you can see these. Nobody else has them in their feed.">Personal</SectionTitle>

      <TypeCard label="Task" palette="blue" bg="blue.50" borderColor="blue.300" flow="Scheduled → Complete">
        A personal to-do (&ldquo;call the client about pricing&rdquo;). Completed in one tap —
        there is no start/complete cycle — and reopened the same way if you tap it by mistake.
        It can be linked to a job occurrence for context. Tasks cannot be claimed or
        rescheduled; the person who creates one is on it.
      </TypeCard>

      <TypeCard label="Reminder" palette="purple" bg="purple.50" borderColor="purple.300">
        A personal nudge (&ldquo;pick up supplies&rdquo;) that surfaces in the feed when due, and
        can be dismissed and reopened. Flag one <Em>high priority</Em> and its card outranks
        every other colour. Reminders cannot be rescheduled — move the reminder itself.
      </TypeCard>

      <SectionTitle note="Visible to the people added via Manage Team. Admins see them all.">Team</SectionTitle>

      <TypeCard
        label="Event" palette="yellow" bg="yellow.200" borderColor="yellow.400"
        flow="Scheduled → Complete (admin) → next created if it repeats"
      >
        A team-scoped occurrence — a weekly meeting, an equipment inspection. Created by admins
        only, with an optional exact time, one-off or repeating. Only an admin edits or
        completes one. A monthly cadence lands on the same day of the month and a yearly one on
        the same date, rather than counting days.
      </TypeCard>

      <TypeCard
        label="Followup" palette="red" bg="red.200" borderColor="red.400"
        flow="Scheduled → Complete (admin) → next created if it repeats"
      >
        A team-scoped follow-up (&ldquo;follow up on Thompson pricing&rdquo;). Created by admins
        only. Attach clients and job services to it and the chips navigate straight to them.
        One-off or repeating, and only an admin edits or completes one.
      </TypeCard>

      <SectionTitle note="Every worker and admin sees these.">Everyone</SectionTitle>

      <TypeCard label="Announcement" palette="purple" bg="purple.200" borderColor="purple.400">
        A company-wide notice (&ldquo;office closed Friday&rdquo;). Created by admins only. There
        is no Complete on an announcement — an admin edits or deletes it, and otherwise it just
        falls back down the timeline as newer cards arrive. No team, and it is never counted
        overdue.
      </TypeCard>

      {/* ── Key concepts ── */}
      <SectionTitle>Key concepts</SectionTitle>

      <Concept title="Claimer">
        The first person onto an occurrence becomes its claimer; anyone added afterwards is a
        worker or an observer. Only the claimer <Em>or an admin</Em> can start, complete, and
        accept payment, and only the claimer or an admin can add or remove team members. Use
        Manage Team to hand the claim to someone else. A trainee cannot take these actions
        under any circumstances.
      </Concept>

      <Concept title="Default team">
        A job can carry a default crew or a default list of people. Whichever it has is put
        onto the next visit when that visit is auto-created. A one-time swap on a single
        occurrence does not change the default; an archived default crew is skipped and the
        visit arrives unassigned.
      </Concept>

      <Concept title="Reschedule">
        Only the claimer or an admin can reschedule, only while the visit is still scheduled,
        and never for a task or reminder. A written reason is required from everyone and is
        posted to the card as a comment. Workers are held to <Em>two days</Em> either side of
        today; admins have no window. The new date keeps the original time of day, and you are
        offered a message to send the client.
      </Concept>

      <Concept title="Overdue">
        A card is overdue once its day has passed and it has not reached a finished state.
        Awaiting-payment visits get a grace period: they only count as overdue once the
        client&rsquo;s pay link has expired, since until then the client can still pay.
        Paused repeating services and announcements are never overdue.
      </Concept>

      {/* ── Flags ── */}
      <SectionTitle note="These modify any card type they are put on.">Flags</SectionTitle>

      <Concept title="Administered">
        Cannot be claimed — an admin has to assign the team. Once assigned, the claimer runs it
        normally. Estimates are administered by default.
      </Concept>

      <Concept title="Tentative">
        Cannot be claimed or started until an admin confirms it. For scheduling that is not
        settled, or that is waiting on the client.
      </Concept>

      <Concept title="Unconfirmed">
        The client has not confirmed the appointment. Work can still be claimed and started —
        the orange badge is a heads-up, not a block — and the claimer or an admin can mark it
        confirmed. Auto-created visits start unconfirmed.
      </Concept>

      <Concept title="Insured Only">
        Shown on any job priced at or above the high-value threshold. Claiming one requires
        every compliance policy that gates claiming above that price to be signed and current
        — the seeded one is Insurance — and requires the claimer to have a worker type set.
      </Concept>

      {/* ── Colours ── */}
      <SectionTitle note="The card's fill is its state. Read top to bottom — the first that applies wins.">
        Card colours
      </SectionTitle>

      <VStack align="stretch" gap={1}>
        {COLORS.map((c) => (
          <HStack key={c.name} p={2} bg={c.bg} borderWidth="1px" borderColor={c.border} rounded="md" gap={2} align="flex-start">
            <Badge colorPalette={c.palette} variant="solid" fontSize="2xs" flexShrink={0}>{c.name}</Badge>
            <Text fontSize="xs" color="gray.800">{c.means}</Text>
          </HStack>
        ))}
      </VStack>

      <ExplainerText>
        A repeating service that has been <Em>paused</Em> as a whole is a different thing from
        the deep-orange paused card above: it keeps its normal colour and shows a purple pause
        circle where the action button would be. Tap it for the details.
      </ExplainerText>

      {/* ── Ghosts ── */}
      <SectionTitle note="Not real occurrences — reference cards the app draws so something you need to know about does not leave a silent gap. They cannot be started, claimed or edited.">
        Placeholder cards
      </SectionTitle>

      <Box p={2.5} borderWidth="1px" rounded="md" borderColor="gray.400" bg={GHOST_BG}>
        <Badge variant="solid" colorPalette="gray" bg="gray.100" color="gray.900" mb={1} fontSize="2xs">Expires in 5d</Badge>
        <Text fontSize="xs" fontWeight="semibold" color="white">Next visit not scheduled</Text>
        <Text fontSize="xs" color="gray.100" mt={1}>
          A repeating job whose next visit has not posted, because the previous one is not
          closed out — most often it is <Em>waiting on payment</Em>. The card names the blocker
          and the date the visit was due, and disappears by itself once the previous visit
          closes and the real occurrence is generated. Tap it to open the visit that needs
          chasing.
        </Text>
        <Text fontSize="xs" color="gray.100" mt={2}>
          <Em>Expiry.</Em> The chip counts down to the day the visit was due; inside three days
          the card pulses. Past that day it reads &ldquo;Expired N ago&rdquo; and stays for one
          more week before fading away on its own — the <Em>Expired N</Em> chip on the Today
          header counts those and filters to them. To look further back, use the status filter
          (Expiring / Expired next visits) with any date range.
        </Text>
        <Text fontSize="xs" color="gray.200" mt={2}>
          Only repeating, accepted jobs with no future visit already booked get one. One-offs,
          estimates, cancelled and archived visits, and paused repeating services never do —
          a paused stream is a deliberate stop, not a gap, and it is already listed in its own
          queue.
        </Text>
      </Box>

      <Box p={2.5} borderWidth="1px" rounded="md" borderColor="gray.400" borderStyle="dashed" bg="white">
        <Text fontSize="xs" fontWeight="semibold" mb={0.5}>Reminder &amp; pinned ghosts</Text>
        <Text fontSize="xs" color="gray.800">
          A second, dashed copy of a card shown on a future date — where a reminder falls due,
          or where a pinned job sits in the regular feed. Same colour as the original so it
          reads as the same card, not a new one.
        </Text>
      </Box>
    </TabExplainer>
  );
}
