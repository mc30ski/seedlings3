"use client";

// THE PERSPECTIVE PICKER, in the title bar.
//
// This was a shell switcher listing Client / Worker / Admin / Super, which
// looked like a role switcher because it WAS one: those were roles, and
// picking one changed which build of every tab you saw. There is one staff
// tab list now, so there are no shells to switch between — and the control
// that belongs in this spot is the one people reach for here: pick a role,
// see the app as somebody holding it.
//
// A perspective is a named SUBSET of what you already hold, offered only if
// you hold that role or one inheriting it, so no choice here can grant
// anything — it can only narrow. The server applies it from the
// `X-Perspective` header and returns a narrowed capability set, which is
// why the tab list AND the contents of each tab both shrink.
//
// Renders nothing when there is nothing to switch to.

import { useEffect, useRef, useState } from "react";
import { Box, HStack, Icon, Text } from "@chakra-ui/react";
import { Check, ChevronDown, Eye, Home } from "lucide-react";
import { PerspectiveGlyph, useIconComponent } from "@/src/lib/perspectiveIcons";

/** The two shells. Was four — three of them the same staff app. */
export type RoleValue = "client" | "staff";

/** One perspective on offer — a row of `me.perspectives`. */
export type PerspectiveOption = {
  roleId: string;
  name: string;
  /** A `PERSPECTIVE_ICONS` key, chosen by the operator on the Roles tab. */
  icon?: string | null;
};

type Props = {
  /** The perspectives this person may take, lowest access first. */
  perspectives: PerspectiveOption[];
  /** The one in force, per the SERVER. Null means full access. */
  activeRoleId: string | null;
  /** Take a perspective, or null to return to full access. */
  onPick: (roleId: string | null, name: string | null) => void;
  /**
   * The OTHER audience, when this person belongs to both.
   *
   * Somebody can be staff and a customer at once — an employee who is also
   * a client. Rare (nobody is, in the current data) but real, and with the
   * shell switcher gone this is their only way between the two. Absent for
   * everybody else, which is almost everybody.
   */
  otherShell?: { label: string; onSwitch: () => void };
  /** True while a staff account is standing in the customer shell.
   *  The chip then names THAT, and "Client" is the row carrying the check.
   *  Every other row is still offered — picking one returns to the staff
   *  app and applies it, which the call site handles. */
  inClientShell?: boolean;
};

export default function RoleChip({ perspectives, activeRoleId, onPick, otherShell, inClientShell }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (open && ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  // Nothing to offer, nothing to render. Somebody holding one role has no
  // narrower view of themselves to take.
  if (perspectives.length === 0 && !otherShell) return null;
  const active = perspectives.find((p) => p.roleId === activeRoleId) ?? null;
  const activeName = active?.name ?? null;
  // THE CHIP CARRIES AN ICON TOO, as it did before the roles refactor —
  // the badge and the dropdown row for the same view should look like the
  // same thing. The two states that are not roles borrow the icon their
  // own title bar uses, so the chip is never iconless and never changes
  // width as you switch:
  //   a lens  → that role's chosen icon
  //   Client  → a house, the customer-facing pages
  //   My Roles → an eye, matching its bar
  // `useIconComponent` so a role wearing any of the ~1,850 icons draws its
  // own glyph, not the generic eye. Common icons resolve on the first
  // frame; anything else appears once the lazy catalogue lands, and `Eye`
  // holds the space until then — which is also what an unset icon gets.
  const resolvedChipIcon = useIconComponent(inClientShell ? null : active?.icon);
  const ChipIcon = inClientShell ? Home : (resolvedChipIcon ?? Eye);
  // In the customer shell the chip names the SHELL, not the lens. A
  // perspective narrows staff capabilities and none of them is what is on
  // screen, so naming the lens there would describe a view you had left.
  const label = inClientShell ? "Client" : (activeName ?? "My Roles");

  return (
    <Box position="relative" ref={ref} flexShrink={0}>
      {/* THE BRAND FILL, which is per-theme and is GREEN on Light.
          This was `green.600` / `green.700` with white ink — raw ramp
          values, which are one colour forever. The comment that justified
          them reasoned entirely about Light: "matches the leaf logo",
          "doesn't blend into the header's soft-green gradient". Light is
          the only theme with a sage header, so on Funkadelic this chip sat
          green inside magenta chrome and on Espresso green on brown.

          `accent.solid` was the obvious fix and it is the WRONG one here:
          Light's accent is blue, so the chip stopped being green in the one
          theme whose logo and title bar are. Identity and action are two
          different jobs that happen to share a colour in thirteen themes.
          `chrome.identity` is the brand one — see its doc comment in
          themeTokens.ts.

          Light keeps the EXACT green that shipped, #16a34a with white ink.
          Worth knowing: that pairing is 3.3:1, under AA for a label this
          size, and the pill is 2.54:1 against the sage bar, under the 3:1
          WCAG asks of a non-text element. Both are inherited, not new.
          Either is a one-line fix in themeTokens.ts — darken the fill to
          #116932 (white ink 6.8:1) or keep the fill and switch the ink to
          #111111 (5.7:1) — but changing it changes the look of the single
          most recognisable control in the app, so it is the operator's
          call, not a silent correction. */}
      <HStack
        as="button"
        gap={1}
        px={2.5}
        py={1}
        rounded="full"
        bg={open ? "chrome.identityEmphasis" : "chrome.identity"}
        color="chrome.identityFg"
        _hover={{ bg: "chrome.identityEmphasis" }}
        shadow="sm"
        cursor="pointer"
        onClick={() => setOpen((v) => !v)}
        transition="all 0.1s"
        // A STABLE ACCESSIBLE NAME, deliberately not mirroring the menu's
        // "Acting as" / "Viewing as" split. I changed it to follow that
        // vocabulary and broke the one thing an accessible name is for:
        // being a reliable handle. A screen-reader user — and the spec
        // that finds this control by role and name — both want it to say
        // the same thing every time, not to track which kind of view is
        // in force. The menu already draws that distinction visually.
        aria-label={`Viewing as ${label} — click to change perspective`}
        title={`Viewing as ${label}`}
      >
        <Icon as={ChipIcon} boxSize={3.5} />
        <Text fontSize="sm" fontWeight="semibold" lineHeight="1">
          {label}
        </Text>
        <ChevronDown size={13} />
      </HStack>
      {open && (
        <Box
          position="absolute"
          zIndex={1000}
          right={0}
          top="100%"
          mt={1}
          bg="bg.panel"
          // EXPLICIT INK. This panel renders inside the title bar, which sets
          // `color="chrome.headerFg"` — white in High contrast, pale green in
          // Spring, cream in Fall. Inheriting that put near-white labels on a
          // white panel: the rows were there, with only their icons visible.
          color="fg"
          // RESTORE A LINE HEIGHT. The header's right-hand control strip
          // sets `lineHeight: 0` inline to kill the whitespace between its
          // icons, and this panel renders inside it, so every label
          // inherited a zero line height: each row collapsed to its padding
          // (16px for `py={2}`) and the text overflowed its own row. Only
          // the active row looked right, because the check icon gave it a
          // height the text could not.
          lineHeight="normal"
          borderWidth="1px"
          borderColor="border.emphasis"
          rounded="lg"
          shadow="lg"
          // THE CONTENT SETS THE WIDTH. Copying `ThemeChip`'s fixed 240px
          // made the two menus match each other and neither match itself:
          // ThemeChip lists theme names, this lists four short role names,
          // so the same number left a band of empty panel to the right of
          // every label. `max-content` fits the longest row; the floor
          // keeps a one-word list from drawing a sliver, and the clamp
          // keeps a long custom role name from running off a phone screen,
          // which matters because the menu is anchored to the right edge.
          w="max-content"
          minW="168px"
          maxW="calc(100vw - 16px)"
          maxH="calc(100vh - 120px)"
          overflowY="auto"
          py={1}
          role="menu"
        >
          {/* TWO HEADINGS, because the menu holds two different questions.
              Above the rule: which single role you are ACTING AS, which
              narrows what you can do. Below it: which app you are VIEWING,
              which does not. One heading over both made the shell switch
              look like a third role.
              Shown in BOTH shells. An earlier cut hid the whole list in the
              customer shell and left a single "Switch to staff view", on
              the reasoning that a lens changes nothing you can see from
              there. True, but it made the control a different control
              depending on where you stood, so the way back was somewhere
              new each time. It is one menu with one shape now, and Client
              is simply the row that happens to be selected. */}
          {/* ONLY WHEN THERE IS SOMETHING UNDER IT. A heading over an empty
              list is a promise of options that do not exist — somebody
              holding one off-ladder role (a bookkeeper) has no perspective
              to take, and saw "ACTING AS" with nothing beneath it. The
              VIEWING AS half below always has rows, so it is unconditional. */}
          {perspectives.length > 0 && (
            <Box px={3} py={1.5}>
              <Text fontSize="2xs" color="fg.muted" textTransform="uppercase" letterSpacing="wide">
                Acting as
              </Text>
            </Box>
          )}
          {/* THE LENSES. "My Roles" used to head this list as though it
              were one of them; it is not — it is the absence of one, and
              the union of every role you hold. It sits below the divider
              with Client, the other answer to "what am I looking at".
              Picking a lens FROM the customer shell returns to the staff
              app and applies it, because that is the only place it means
              anything — see `onPick` at the call site. */}
          {perspectives.map((o) => {
            const isActive = !inClientShell && o.roleId === activeRoleId;
            return (
              <HStack
                key={o.roleId}
                as="button"
                role="menuitemradio"
                aria-checked={isActive}
                w="full"
                px={3}
                py={2}
                gap={2}
                textAlign="left"
                cursor="pointer"
                bg={isActive ? "blue.faint" : undefined}
                _hover={{ bg: isActive ? "blue.subtle" : "gray.faint" }}
                onClick={() => {
                  setOpen(false);
                  if (!isActive) onPick(o.roleId, o.name);
                }}
              >
                {/* A FIXED SLOT, drawn empty when inactive. Showing the
                    check only on the active row shifted every other label
                    left by its width, so the list did not read as a
                    column. ThemeChip reserves the same gutter for its
                    swatches. */}
                {/* TWO GUTTERS, both always drawn. The check says which
                    is in force and the icon says which role it is; if
                    either collapsed when absent the labels would not line
                    up down the column. */}
                <Box w="14px" flexShrink={0} display="inline-flex" alignItems="center">
                  {isActive && <Check size={14} />}
                </Box>
                <Box w="16px" flexShrink={0} display="inline-flex" alignItems="center">
                  <PerspectiveGlyph
                    iconKey={o.icon}
                    boxSize={4}
                    color={isActive ? "blue.fg" : "fg.muted"}
                  />
                </Box>
                <Text
                  fontSize="sm"
                  fontWeight={isActive ? "semibold" : "normal"}
                  color={isActive ? "blue.fg" : undefined}
                >
                  {o.name}
                </Text>
              </HStack>
            );
          })}
          {/* `border.emphasis`, not `border` — the lighter token is the
              one used for a hairline BETWEEN rows of the same list, and
              here the rule is the whole reason the two halves read as
              two groups. It is also the token this panel's own outer
              border uses, so the rule can never be fainter than the box
              it divides, in any of the 14 themes. */}
          {/* The rule SEPARATES the two halves, so it needs both of them. */}
          {perspectives.length > 0 && (
            <Box borderTopWidth="1px" borderColor="border.emphasis" my={1} />
          )}
          <Box px={3} py={1.5}>
            <Text fontSize="2xs" color="fg.muted" textTransform="uppercase" letterSpacing="wide">
              Viewing as
            </Text>
          </Box>
          {/* BACK TO EVERYTHING. Below the divider because it is not a lens
              — it is the one that takes a view OFF. It is also the state
              the title bar marks, so somebody who has lost track of which
              view they are in has two places that agree.
              Offered from the customer shell too, where picking it both
              returns to the staff app and clears any lens. */}
          <HStack
            as="button"
            role="menuitemradio"
            aria-checked={!inClientShell && activeRoleId === null}
            w="full"
            px={3}
            py={2}
            gap={2}
            textAlign="left"
            cursor="pointer"
            bg={!inClientShell && activeRoleId === null ? "blue.faint" : undefined}
            _hover={{ bg: !inClientShell && activeRoleId === null ? "blue.subtle" : "gray.faint" }}
            onClick={() => {
              setOpen(false);
              if (inClientShell || activeRoleId !== null) onPick(null, null);
            }}
          >
            <Box w="14px" flexShrink={0} display="inline-flex" alignItems="center">
              {!inClientShell && activeRoleId === null && <Check size={14} />}
            </Box>
            {/* The eye its own title bar uses, so the two agree. */}
            <Box w="16px" flexShrink={0} display="inline-flex" alignItems="center">
              <Icon as={Eye} boxSize={4} color={!inClientShell && activeRoleId === null ? "blue.fg" : "fg.muted"} />
            </Box>
            <Text
              fontSize="sm"
              fontWeight={!inClientShell && activeRoleId === null ? "semibold" : "normal"}
              color={!inClientShell && activeRoleId === null ? "blue.fg" : undefined}
            >
              My Roles
            </Text>
          </HStack>
          {/* NO SECOND DIVIDER. "My Roles" and Client are the same kind of
              thing — both answer "what am I looking at" rather than "which
              role am I acting as" — so they are one group, not two groups
              of one.
              A ROW LIKE ANY OTHER, not an action. It was a bare button
              reading "Switch to staff view" when you were already in the
              customer shell, which made it the only item in the menu that
              described a journey instead of a destination. It now names
              the destination in both shells and carries the check when you
              are there, so the menu reads as one set of choices with one
              of them current. Picking it while already there does nothing
              but close. */}
          {otherShell && (
            <>
              <HStack
                as="button"
                role="menuitemradio"
                aria-checked={!!inClientShell}
                w="full"
                px={3}
                py={2}
                gap={2}
                cursor="pointer"
                textAlign="left"
                bg={inClientShell ? "blue.faint" : undefined}
                _hover={{ bg: inClientShell ? "blue.subtle" : "gray.faint" }}
                onClick={() => {
                  setOpen(false);
                  if (!inClientShell) otherShell.onSwitch();
                }}
              >
                <Box w="14px" flexShrink={0} display="inline-flex" alignItems="center">
                  {inClientShell && <Check size={14} />}
                </Box>
                <Box w="16px" flexShrink={0} display="inline-flex" alignItems="center">
                  <Icon as={Home} boxSize={4} color={inClientShell ? "blue.fg" : "fg.muted"} />
                </Box>
                {/* FULL INK. This was `fg.muted`, which is the colour this
                    menu uses for a thing you cannot pick — and it sat
                    directly under "My Roles" in full ink, so the shell
                    switch read as disabled. It is an ordinary choice. */}
                <Text
                  fontSize="sm"
                  fontWeight={inClientShell ? "semibold" : "normal"}
                  color={inClientShell ? "blue.fg" : undefined}
                >
                  {otherShell.label}
                </Text>
              </HStack>
            </>
          )}
        </Box>
      )}
    </Box>
  );
}
