"use client";

// "DURHAM ONLY" — the one place the app admits your view is narrowed.
//
// WHY THIS IS APP-WIDE AND NOT PER TAB. Portfolio scoping runs through about
// thirty query sites across eleven files; for a long time exactly two of
// them said so. A district lead therefore saw shorter lists on Jobs,
// Clients, Payments, Collections and the schedule all day with nothing
// anywhere naming the territory — and that is the precise failure the portfolio
// design exists to prevent: a territory's rows vanishing looks identical to
// that territory being empty. Putting the notice in each tab would repeat
// the mistake that made the filter safe only once it moved to the
// principal — it becomes a thing every new view must remember, and
// forgetting it is invisible.
//
// THE HEADER CHIP DOES NOT COVER THIS. The chip announces a LENS somebody
// chose, and it hides itself when there is nothing to choose between —
// which is exactly the grant-limited case. The person with the least choice
// about being narrowed was the one person getting no indication of it.
//
// TWO WAYS TO BE NARROWED, and they are not equally strong:
//   a LENS the viewer picked narrows everything, so the wording is flat;
//   a GRANT may be partial — somebody holding one role company-wide and
//   another inside a portfolio is narrowed on some views and not others — so
//   `mixed` softens the claim rather than overstating it.
// Overstating would be its own bug: a reader who finds the notice wrong
// once stops believing it when it matters.

import { useEffect, useState } from "react";
import { Box, HStack, Text } from "@chakra-ui/react";
import { Info, Layers, X } from "lucide-react";
import { apiGet } from "@/src/lib/api";
import {
  applyDefaultAreaLens,
  getAreaLens,
  setAreaLens,
  getAreaLensName,
  AREA_LENS_CHANGED_EVENT,
  type AreaLensOption,
} from "@/src/lib/impersonation";

export default function PortfolioScopeNotice({
  portfolioScope,
}: {
  /** From `/api/me`. Null when this person's access is not confined. Each
   *  trail is the chain from the top of the tree down to the granted portfolio,
   *  root excluded — ["Chapel Hill", "Carrboro"]. */
  portfolioScope?: {
    trails: string[][];
    grants?: Array<{ id: string; trail: string[]; role: string }>;
    /** False when every capability the grant carries is also held
     *  company-wide — the holder leads it on paper and sees everything. */
    narrows?: boolean;
    /** The company-wide roles covering it, when `narrows` is false. */
    coveredBy?: string[];
    mixed: boolean;
  } | null;
}) {
  // The lens lives in localStorage, so it is read after mount — reading it
  // during render would make the server and the client disagree on the
  // first pass.
  const [lensId, setLensId] = useState<string | null>(null);
  const [lensName, setLensName] = useState<string | null>(null);
  const [lensTrail, setLensTrail] = useState<string[] | null>(null);
  const [showDetail, setShowDetail] = useState(false);

  // Seed the lens from a single portfolio grant, once per browser. Mounted
  // app-wide, so it runs wherever somebody lands first.
  useEffect(() => {
    applyDefaultAreaLens(portfolioScope?.grants);
  }, [portfolioScope]);
  useEffect(() => {
    const read = () => {
      setLensId(getAreaLens());
      setLensName(getAreaLensName());
    };
    read();
    window.addEventListener(AREA_LENS_CHANGED_EVENT, read);
    return () => window.removeEventListener(AREA_LENS_CHANGED_EVENT, read);
  }, []);

  // THE CACHED NAME CAN BE MISSING while the id is set — storage cleared,
  // a value written before the name was cached, or a hand-set key. The
  // fallback for that used to be the words "One portfolio", which is a notice
  // that tells you the one thing you already knew and not the thing you
  // need. Resolve it properly; this fires only in that gap, so the ordinary
  // path still costs nothing.
  //
  // It also fetches the ANCESTOR TRAIL, which the cache never holds — only
  // the server can name an ancestor the viewer may not be allowed to pick.
  // So this runs whenever a lens is set, not only when the name is missing.
  useEffect(() => {
    if (!lensId) { setLensTrail(null); return; }
    let cancelled = false;
    (async () => {
      try {
        const res = await apiGet<{ portfolios: AreaLensOption[] }>("/api/me/portfolios");
        const hit = res.portfolios?.find((a) => a.id === lensId);
        if (cancelled || !hit) return;
        setLensTrail(hit.trail?.length ? hit.trail : [hit.name]);
        setLensName((n) => n ?? hit.name);
      } catch {
        // Leave the trail unresolved rather than break the page — the
        // notice still warns, falling back to the cached name below.
      }
    })();
    return () => { cancelled = true; };
  }, [lensId]);

  const lensSet = !!lensId;

  const grantTrails = portfolioScope?.trails ?? [];
  const roleNames = [
    ...new Set((portfolioScope?.grants ?? []).map((g) => g.role).filter(Boolean)),
  ];
  if (!lensSet && grantTrails.length === 0) return null;

  // The lens wins the wording when both are in force: it is the narrower of
  // the two by construction (it can only ever subtract from the grant), and
  // it is the one the reader just chose, so it is what they are asking
  // about.
  // The chains to render. A lens has one; a grant may have several.
  // Until the trail resolves, fall back to the cached name — the warning
  // matters more than the breadcrumb.
  const trails: string[][] = lensSet
    ? [lensTrail ?? [lensName ?? "One portfolio"]]
    : grantTrails;
  const plural = !lensSet && grantTrails.length > 1;
  // THREE TRUE SENTENCES, not one hedged one.
  //
  //   leadsOnly  — the grant filters nothing; they hold it all company-wide
  //                and are merely recorded as leading this portfolio
  //   partial    — some tabs are filtered and others are not
  //   (neither)  — everything they see is this portfolio
  const narrows = portfolioScope?.narrows !== false;
  const leadsOnly = !lensSet && grantTrails.length > 0 && !narrows;
  const partial = !lensSet && !leadsOnly && portfolioScope?.mixed;
  const coveredBy = portfolioScope?.coveredBy ?? [];

  return (
    <Box
      mb={1}
      px={{ base: 2, md: 3 }}
      py={{ base: 1, md: 1.5 }}
      // PURPLE, to match the lens pin in the title bar. The two are the
      // same fact stated twice — the chip says it in an icon, this says it
      // in words — and a reader should not have to work out that an orange
      // strip and a purple pin are about the same thing. Purple is also
      // already this app's colour for "what you are looking at is not the
      // default view" (BusinessStartRevealBanner), so the strip joins that
      // family rather than reading as a warning, which orange did.
      bg="purple.faint"
      borderWidth="1px"
      borderColor="purple.emphasized"
      borderLeftWidth="4px"
      rounded="md"
      data-testid="portfolio-scope-notice"
      // THE NUANCE LIVES IN THE TOOLTIP, not the line. `mixed` means this
      // person also holds something company-wide, so only SOME views are
      // narrowed — true, and too long to say in a strip that is on screen
      // all session. The visible text stays one short sentence; the hover
      // carries the qualification for anybody who wonders.
      title={
        partial
          ? `Some of your access is limited to ${plural ? "these portfolios" : "this portfolio"} — those lists and totals leave out everywhere else.`
          : `Lists and totals leave out other portfolios.`
      }
    >
      {/* ONE ROW, ALWAYS. This is a standing condition — somebody limited
          to one territory sees it on every screen of every session — so it
          costs a line, not a paragraph. It ran to three lines on a phone
          before it was cut to this. */}
      <HStack gap={2} align="center">
        <Box flexShrink={0} color="purple.fg" lineHeight="0">
          <Layers size={13} />
        </Box>
        <Text fontSize="xs" color="purple.fg" truncate flex="1" minW={0}>
          {/* NAME THE THING. "Showing Chapel Hill only" left the reader to
              infer what kind of thing Chapel Hill was and why it was
              filtering them — the word "portfolio" is the whole context
              and costs eight characters.

              KEYED ON WHETHER YOU HOLD A ROLE HERE, not on lens-vs-grant.
              The first cut said "Portfolio filter" whenever a lens was
              set, which is right for somebody who holds everything and
                is just looking at a slice — and wrong for a lead with TWO
              portfolios who picks one of them from the chip. They are
              still District Lead in Durham; choosing to look at one of
              your own portfolios does not stop the role applying. */}
          {leadsOnly
            ? "You lead "
            : partial
              ? "Parts of your view are limited to "
              : roleNames.length > 0
                ? "Your portfolio: showing "
                : "Portfolio filter: showing "}
          {trails.map((trail, ti) => (
            <Text as="span" key={trail.join("/")}>
              {ti > 0 && ", "}
              {/* THE CHAIN, WITH ONLY THE LAST LINK BOLD. The ancestors
                  place the portfolio — "Chapel Hill → Carrboro" says how much of
                  the business is out of view in a way "Carrboro" alone
                  cannot, and two districts may each have a route called
                  North. Bolding the whole chain would give the ancestors
                  equal weight to where you actually are. */}
              {trail.map((part, i) => (
                <Text as="span" key={part + i}>
                  {i > 0 && <Text as="span" opacity={0.6}>{" → "}</Text>}
                  <Text as="span" fontWeight={i === trail.length - 1 ? "bold" : "normal"}>
                    {part}
                  </Text>
                </Text>
              ))}
            </Text>
          ))}
          {/* "only" IS A CLAIM ABOUT THE WHOLE SCREEN, and it is false
              when somebody holds a portfolio grant AND a company-wide
              role. Measured: a Durham lead who also holds Coordinator
              globally sees 130 visits and 22 properties — everything —
              while their Ledger stays at Durham's 4, because Coordinator
              carries schedule.view and clients.view and no money.view.
              The qualification used to live only in the tooltip, which is
              to say nowhere: the visible line said "showing Durham only"
              over a list of the whole company. */}
          {leadsOnly || partial ? "" : " only"}
          {/* AND THE ROLE, whenever one is scoped here. Somebody who holds
              everything company-wide has no role to name — they are using
              their own powers and merely looking at a slice, so saying
              "as X" would invent a fact. Anyone whose access to this
              portfolio comes from a grant is acting under that grant's
              role whether or not a lens is also narrowing them. */}
          {roleNames.length > 0 && (
            <Text as="span">
              {" as "}
              <Text as="span" fontWeight="bold">{roleNames.join(" / ")}</Text>
            </Text>
          )}
          {/* AND SAY WHY NOTHING IS FILTERED, when nothing is. Without this
              the line reads as a restriction the reader cannot find, and
              they go looking for missing rows that are all present. */}
          {leadsOnly && (
            <Text as="span">
              {" — your view is not limited"}
              {coveredBy.length > 0 && `, you hold these powers everywhere through ${coveredBy.join(" / ")}`}
            </Text>
          )}
        </Text>

        {/* WHAT IS AND IS NOT FILTERED, on demand.
            The strip says a portfolio is in force and not what that does,
            which leaves the reader to work out whether the 28 pieces of
            equipment in front of them are the portfolio's or the
            company's. They are the company's. That asymmetry is not
            guessable, and getting it wrong means reading a company-wide
            number as a portfolio one.

            The two lists below were MEASURED, by calling each endpoint
            with and without the filter — not read off the code, which is
            how a 500 on the job list went unnoticed. Re-measure before
            editing them. */}
        <Box position="relative" flexShrink={0}>
          {/* A LABELLED CONTROL, not a lone glyph. As a bare 13px icon this
              read as decoration on a strip that is already purple and
              already iconed — nobody clicks a second small symbol next to
              the first one. The asymmetry it explains (work and money are
              filtered, equipment and people are not) is the single most
              misreadable thing on the screen, so the way in has to look
              like a way in. */}
          <HStack
            as="button"
            data-testid="portfolio-scope-info"
            aria-label="What does this filter change?"
            aria-expanded={showDetail}
            onClick={() => setShowDetail((v) => !v)}
            gap={1}
            px={2}
            py={0.5}
            rounded="full"
            borderWidth="1px"
            borderColor="purple.emphasized"
            bg={showDetail ? "purple.subtle" : "bg.panel"}
            color="purple.fg"
            cursor="pointer"
            flexShrink={0}
            _hover={{ bg: "purple.subtle" }}
          >
            <Info size={12} />
            <Text fontSize="2xs" fontWeight="medium" whiteSpace="nowrap">
              What&rsquo;s filtered?
            </Text>
          </HStack>
          {showDetail && (
            <Box
              position="absolute"
              right={0}
              top="22px"
              zIndex={30}
              w={{ base: "17rem", md: "22rem" }}
              p={3}
              bg="bg.panel"
              borderWidth="1px"
              borderColor="border.emphasis"
              rounded="md"
              shadow="md"
            >
              <Text fontSize="xs" fontWeight="semibold" mb={1}>Narrowed to this portfolio</Text>
              <Text fontSize="xs" color="fg.muted" mb={2}>
                Jobs and visits · Services · Clients · Properties · the Ledger ·
                and every Insights total that comes from them (revenue, completed,
                scheduled, unclaimed, team).
              </Text>
              <Text fontSize="xs" fontWeight="semibold" mb={1}>Still company-wide</Text>
              <Text fontSize="xs" color="fg.muted">
                Equipment · Supplies · Vehicles · Crews · Users · Documents.
                These are shared across the business, so their counts are the
                whole company&rsquo;s even while this filter is on.
              </Text>
            </Box>
          )}
        </Box>

        {/* DISMISS CLEARS THE LENS — and is therefore offered ONLY when
            there is a lens to clear.
            A grant-limited reader (a district lead) gets no ×, on purpose.
            Their view is not narrowed by a choice they made; it is what
            their access IS. A dismiss there could only do nothing or lie,
            and a control that does nothing is worse than no control: the
            next thing they distrust is the notice itself. */}
        {lensSet && (
          <Box
            as="button"
            aria-label="Show all portfolios"
            title="Show all portfolios"
            data-testid="portfolio-scope-dismiss"
            onClick={() => { void setAreaLens(null); }}
            flexShrink={0}
            display="inline-flex"
            alignItems="center"
            justifyContent="center"
            w="18px"
            h="18px"
            rounded="full"
            color="purple.fg"
            opacity={0.7}
            cursor="pointer"
            _hover={{ opacity: 1, bg: "purple.subtle" }}
            transition="opacity 0.1s, background 0.1s"
          >
            <X size={12} />
          </Box>
        )}
      </HStack>
    </Box>
  );
}
