"use client";

// Header-mounted theme switcher — a small swatch button that opens the same
// five themes offered on the Profile tab.
//
// SYNC IS FREE, and deliberately so. Both this and the Profile picker call
// `useAppTheme`, whose `setTheme` writes localStorage, applies the attribute,
// and dispatches `seedlings:theme-changed`; every mounted instance listens for
// that event and re-reads. So changing the theme in either place updates the
// other with no shared state between them, and the choice is persisted once,
// in one place. Do not add a second source of truth here.
//
// Mirrors RoleChip's structure (relative box, click-outside, absolute panel)
// so the header's two dropdowns behave identically.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Box, HStack, Text } from "@chakra-ui/react";
import { Check, Contrast } from "lucide-react";
import { useAppTheme } from "@/src/lib/useAppTheme";
import {
  SURFACES, THEME_IDS, THEME_LABELS, THEME_DESCRIPTIONS,
} from "@/src/styles/themeTokens";

export default function ThemeChip() {
  const { theme, setTheme } = useAppTheme();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // Nudge the panel back on-screen when anchoring it to the chip would put it
  // past the left edge. Capping the WIDTH is not enough: the chip has the
  // alert badge and avatar to its right, so its own right edge is ~90px in
  // from the screen, and on a 320px phone a 272px panel still landed at -40.
  const [shiftX, setShiftX] = useState(0);
  useLayoutEffect(() => {
    if (!open) { setShiftX(0); return; }
    const el = panelRef.current;
    if (!el) return;
    const overflowLeft = 8 - el.getBoundingClientRect().left;
    if (overflowLeft > 0) setShiftX(overflowLeft);
  }, [open]);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (open && ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  return (
    <Box position="relative" ref={ref} flexShrink={0}>
      <HStack
        as="button"
        gap={0}
        p={1.5}
        rounded="full"
        // Quiet by design: this sits beside the role chip, which is the
        // header's one loud control. A theme switch is a preference, not an
        // identity, so it reads as chrome until you reach for it.
        bg={open ? "blackAlpha.200" : "transparent"}
        color="chrome.headerFg"
        _hover={{ bg: "blackAlpha.200" }}
        cursor="pointer"
        transition="all 0.1s"
        onClick={() => setOpen((v) => !v)}
        aria-label={`Appearance: ${THEME_LABELS[theme]} — click to change theme`}
        aria-haspopup="menu"
        aria-expanded={open}
        title={`Appearance: ${THEME_LABELS[theme]}`}
        data-testid="theme-chip"
      >
        <Contrast size={20} />
      </HStack>

      {open && (
        <Box
          ref={panelRef}
          position="absolute"
          zIndex={1000}
          right={0}
          top="100%"
          mt={1}
          transform={shiftX ? `translateX(${shiftX}px)` : undefined}
          bg="bg.panel"
          color="fg"
          borderWidth="1px"
          borderColor="border.emphasis"
          rounded="lg"
          shadow="lg"
          // WIDTH IS CAPPED, not just suggested. With only a `minW` the
          // descriptions set the width and the panel grew past 600px, which on
          // a phone runs off the left edge of the screen (it is anchored to
          // the chip on the right). The clamp keeps it inside the viewport at
          // any width.
          w="272px"
          maxW="calc(100vw - 16px)"
          // Nine themes is taller than a phone. Cap the list and let it
          // scroll rather than run off the bottom of the screen.
          maxH="calc(100vh - 120px)"
          overflowY="auto"
          py={1}
          role="menu"
        >
          <Box px={3} py={1.5}>
            <Text fontSize="2xs" color="fg.muted" textTransform="uppercase" letterSpacing="wide">
              Appearance
            </Text>
          </Box>
          {THEME_IDS.map((id) => {
            const active = id === theme;
            return (
              <HStack
                key={id}
                as="button"
                role="menuitemradio"
                aria-checked={active}
                data-testid={`theme-chip-option-${id}`}
                w="full"
                px={3}
                py={2}
                gap={2}
                textAlign="left"
                cursor="pointer"
                bg={active ? "blue.faint" : undefined}
                _hover={{ bg: active ? "blue.subtle" : "gray.faint" }}
                onClick={() => {
                  setOpen(false);
                  if (!active) setTheme(id);
                }}
              >
                {/* Same three-swatch preview as the Profile picker, so the two
                    surfaces are recognisably the same control. */}
                <HStack gap={0.5} flexShrink={0}>
                  {(["surface.page", "chrome.header", "accent.solid"] as const).map((k) => (
                    <Box
                      key={k}
                      w="12px"
                      h="12px"
                      borderRadius="3px"
                      borderWidth="1px"
                      borderColor="border.emphasis"
                      style={{ background: SURFACES[id][k] }}
                    />
                  ))}
                </HStack>
                <Box flex="1" minW={0}>
                  <Text
                    fontSize="sm"
                    fontWeight={active ? "semibold" : "normal"}
                    color={active ? "blue.fg" : undefined}
                    lineHeight="1.2"
                  >
                    {THEME_LABELS[id]}
                  </Text>
                  {/* The description is the first thing to go on a narrow
                      screen — the swatches and the name already identify the
                      theme, and the full text lives on the Profile tab. */}
                  <Text
                    fontSize="2xs"
                    color="fg.muted"
                    truncate
                    display={{ base: "none", sm: "block" }}
                  >
                    {THEME_DESCRIPTIONS[id]}
                  </Text>
                </Box>
                {active && <Check size={14} />}
              </HStack>
            );
          })}
        </Box>
      )}
    </Box>
  );
}
