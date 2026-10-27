"use client";

// "DURHAM ONLY" — the one place the app admits your view is narrowed.
//
// WHY THIS IS APP-WIDE AND NOT PER TAB. Area scoping runs through about
// thirty query sites across eleven files; for a long time exactly two of
// them said so. A district lead therefore saw shorter lists on Jobs,
// Clients, Payments, Collections and the schedule all day with nothing
// anywhere naming the territory — and that is the precise failure the area
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
//   another inside an area is narrowed on some views and not others — so
//   `mixed` softens the claim rather than overstating it.
// Overstating would be its own bug: a reader who finds the notice wrong
// once stops believing it when it matters.

import { useEffect, useState } from "react";
import { Box, HStack, Text } from "@chakra-ui/react";
import { MapPin, X } from "lucide-react";
import { apiGet } from "@/src/lib/api";
import {
  getAreaLens,
  setAreaLens,
  getAreaLensName,
  AREA_LENS_CHANGED_EVENT,
  type AreaLensOption,
} from "@/src/lib/impersonation";

export default function AreaScopeNotice({
  areaScope,
}: {
  /** From `/api/me`. Null when this person's access is not confined. Each
   *  trail is the chain from the top of the tree down to the granted area,
   *  root excluded — ["Chapel Hill", "Carrboro"]. */
  areaScope?: { trails: string[][]; mixed: boolean } | null;
}) {
  // The lens lives in localStorage, so it is read after mount — reading it
  // during render would make the server and the client disagree on the
  // first pass.
  const [lensId, setLensId] = useState<string | null>(null);
  const [lensName, setLensName] = useState<string | null>(null);
  const [lensTrail, setLensTrail] = useState<string[] | null>(null);
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
  // fallback for that used to be the words "One area", which is a notice
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
        const res = await apiGet<{ areas: AreaLensOption[] }>("/api/me/areas");
        const hit = res.areas?.find((a) => a.id === lensId);
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

  const grantTrails = areaScope?.trails ?? [];
  if (!lensSet && grantTrails.length === 0) return null;

  // The lens wins the wording when both are in force: it is the narrower of
  // the two by construction (it can only ever subtract from the grant), and
  // it is the one the reader just chose, so it is what they are asking
  // about.
  // The chains to render. A lens has one; a grant may have several.
  // Until the trail resolves, fall back to the cached name — the warning
  // matters more than the breadcrumb.
  const trails: string[][] = lensSet
    ? [lensTrail ?? [lensName ?? "One area"]]
    : grantTrails;
  const plural = !lensSet && grantTrails.length > 1;
  const partial = !lensSet && areaScope?.mixed;

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
      data-testid="area-scope-notice"
      // THE NUANCE LIVES IN THE TOOLTIP, not the line. `mixed` means this
      // person also holds something company-wide, so only SOME views are
      // narrowed — true, and too long to say in a strip that is on screen
      // all session. The visible text stays one short sentence; the hover
      // carries the qualification for anybody who wonders.
      title={
        partial
          ? `Some of your access is limited to ${plural ? "these areas" : "this area"} — those lists and totals leave out everywhere else.`
          : `Lists and totals leave out other areas.`
      }
    >
      {/* ONE ROW, ALWAYS. This is a standing condition — somebody limited
          to one territory sees it on every screen of every session — so it
          costs a line, not a paragraph. It ran to three lines on a phone
          before it was cut to this. */}
      <HStack gap={2} align="center">
        <Box flexShrink={0} color="purple.fg" lineHeight="0">
          <MapPin size={13} />
        </Box>
        <Text fontSize="xs" color="purple.fg" truncate>
          Showing{" "}
          {trails.map((trail, ti) => (
            <Text as="span" key={trail.join("/")}>
              {ti > 0 && ", "}
              {/* THE CHAIN, WITH ONLY THE LAST LINK BOLD. The ancestors
                  place the area — "Chapel Hill → Carrboro" says how much of
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
          ))}{" "}
          only
        </Text>

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
            aria-label="Show all areas"
            title="Show all areas"
            data-testid="area-scope-dismiss"
            onClick={() => { void setAreaLens(null); }}
            ml="auto"
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
