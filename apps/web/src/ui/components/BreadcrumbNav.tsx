"use client";

import React, { useEffect, useRef, useState } from "react";
import { Badge, Box, HStack, Icon, Text } from "@chakra-ui/react";
import { ArrowUpRight, ChevronDown } from "lucide-react";

export type InnerTab = {
  value: string;
  label: string;
  icon?: React.ElementType;
  visible?: boolean | (() => boolean);
  content?: React.ReactNode;
  category?: string; // group tabs into categories
  categoryIcon?: React.ElementType; // icon for the category
  categoryHighlight?: boolean; // highlight this category in the dropdown
  chip?: boolean; // render this tab on a light chip in the inner dropdown
};

export type OuterTab = {
  value: string;
  label: string;
  icon?: React.ElementType;
  visible?: boolean | (() => boolean);
  innerTabs: InnerTab[];
  headerSlot?: React.ReactNode;
};

type Props = {
  outerTabs: OuterTab[];
  outerValue: string;
  onOuterChange: (value: string) => void;
  innerValue: string;
  onInnerChange: (value: string, outerValue?: string) => void;
  categoryValue?: string;
  onCategoryChange?: (value: string) => void;
  /** Content rendered before the outer tab selector (e.g., back button) */
  headerLeft?: React.ReactNode;
  /** Content rendered at the right edge of the row (e.g., share-link icon) */
  headerRight?: React.ReactNode;
};

function isVisible(v?: boolean | (() => boolean)): boolean {
  if (v === undefined) return true;
  return typeof v === "function" ? v() : v;
}

export default function BreadcrumbNav({
  outerTabs,
  outerValue,
  onOuterChange,
  innerValue,
  onInnerChange,
  categoryValue,
  onCategoryChange,
  headerLeft,
  headerRight,
}: Props) {
  const [outerOpen, setOuterOpen] = useState(false);
  const [catOpen, setCatOpen] = useState(false);
  const [innerOpen, setInnerOpen] = useState(false);
  const outerRef = useRef<HTMLDivElement>(null);
  const catRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  // Track last selected tab per category so switching back restores it
  const lastTabPerCategory = useRef<Record<string, string>>({});

  function closeAll() { setOuterOpen(false); setCatOpen(false); setInnerOpen(false); }

  // Close dropdowns on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (outerOpen && outerRef.current && !outerRef.current.contains(e.target as Node)) setOuterOpen(false);
      if (catOpen && catRef.current && !catRef.current.contains(e.target as Node)) setCatOpen(false);
      if (innerOpen && innerRef.current && !innerRef.current.contains(e.target as Node)) setInnerOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [outerOpen, catOpen, innerOpen]);

  const visibleOuter = outerTabs.filter((t) => isVisible(t.visible));
  const activeOuter = visibleOuter.find((t) => t.value === outerValue) ?? visibleOuter[0];
  const visibleInner = activeOuter?.innerTabs.filter((t) => isVisible(t.visible)) ?? [];

  // Derive categories from inner tabs
  const categories = (() => {
    const cats: { value: string; icon?: React.ElementType; highlight?: boolean }[] = [];
    const seen = new Set<string>();
    for (const t of visibleInner) {
      const cat = t.category ?? "";
      if (cat && !seen.has(cat)) { seen.add(cat); cats.push({ value: cat, icon: t.categoryIcon, highlight: t.categoryHighlight }); }
    }
    return cats;
  })();
  const hasCategories = categories.length > 0;
  const activeCatObj = categories.find((c) => c.value === ((() => {
    const ai = visibleInner.find((t) => t.value === innerValue);
    return ai?.category ?? categoryValue ?? categories[0]?.value;
  })()));

  // Determine active category — always derive from the selected inner tab
  const activeInner = visibleInner.find((t) => t.value === innerValue);
  const activeCat = hasCategories
    ? (activeInner?.category ?? categoryValue ?? categories[0]?.value)
    : undefined;

  // Track last selected tab per category
  if (activeInner?.category && innerValue) {
    lastTabPerCategory.current[activeInner.category] = innerValue;
  }

  // Tabs in active category
  const categoryTabs = hasCategories
    ? visibleInner.filter((t) => t.category === activeCat)
    : visibleInner;
  // Hide the inner level only when the category has one tab AND that tab's
  // label is the same as the category label (otherwise the inner adds info).
  const isSingleTabCategory =
    hasCategories
    && categoryTabs.length === 1
    && (categoryTabs[0]?.label ?? "").trim().toLowerCase() === (activeCat ?? "").trim().toLowerCase();

  // Resolve active inner tab within the category
  const activeInnerResolved = categoryTabs.find((t) => t.value === innerValue) ?? categoryTabs[0] ?? activeInner ?? visibleInner[0];

  // Cross-role targets: for a given inner-tab value, which OTHER outer
  // tabs (Worker/Admin/Super) contain the same tab AND are visible to
  // this user. Drives the small role-jump chips inside the inner-tab
  // dropdown so the user can hop from e.g. Worker→Pricing straight to
  // Admin→Pricing without rebuilding their navigation path.
  //
  // Equivalence is the inner value string — same value across roles =
  // same conceptual tab. No per-tab annotation needed; new shared tabs
  // become role-jumpable automatically the moment they're registered
  // under the same value in multiple outer entries.
  function computeCrossRoleTargets(innerVal: string): {
    outerValue: string;
    label: string;
    icon?: React.ElementType;
  }[] {
    const targets: { outerValue: string; label: string; icon?: React.ElementType }[] = [];
    for (const o of outerTabs) {
      if (o.value === outerValue) continue; // skip current
      if (!isVisible(o.visible)) continue;   // skip roles the user can't access
      const match = o.innerTabs.find((t) => t.value === innerVal && isVisible(t.visible));
      if (match) targets.push({ outerValue: o.value, label: o.label, icon: o.icon });
    }
    return targets;
  }

  function jumpToCrossRole(innerVal: string, targetOuter: string) {
    onOuterChange(targetOuter);
    onInnerChange(innerVal, targetOuter);
    closeAll();
  }

  function renderDropdown(
    ref: React.RefObject<HTMLDivElement | null>,
    items: {
      value: string;
      label: string;
      icon?: React.ElementType;
      highlight?: boolean;
      chip?: boolean;
      /** When set, render small role-jump badges on the right of the
       *  dropdown row. Each badge navigates to the same inner tab under
       *  a different outer role. Empty/undefined → no badges shown. */
      crossRoleTargets?: { outerValue: string; label: string; icon?: React.ElementType }[];
    }[],
    activeValue: string,
    onSelect: (value: string) => void,
  ) {
    return (
      <Box
        position="fixed"
        zIndex={1000}
        bg="white"
        borderWidth="1px"
        borderColor="gray.200"
        rounded="lg"
        shadow="lg"
        mt={1}
        minW="180px"
        maxW="calc(100vw - 16px)"
        maxH="400px"
        overflowY="auto"
        py={1}
        style={(() => {
          // Position computed below the trigger, then clamped horizontally so
          // the right edge of the dropdown stays inside the viewport — needed
          // on narrow mobile screens where the inner-tab trigger sits well
          // past the midpoint AND the cross-role chips can push content past
          // the old 200px-budget clamp. We over-estimate at 320px to leave
          // headroom; maxW on the Box clamps the visible width as a safety
          // net so the chip column never spills past the right edge.
          const rect = ref.current?.getBoundingClientRect();
          const viewportW = typeof window !== "undefined" ? window.innerWidth : 400;
          const margin = 8;
          const estimatedW = 320;
          const left = Math.max(
            margin,
            Math.min(rect?.left ?? 0, viewportW - estimatedW - margin),
          );
          return {
            top: (rect?.bottom ?? 0) + 4,
            left,
          };
        })()}
      >
        {items.map((t) => (
          <HStack
            key={t.value}
            as="button"
            w="full"
            px={3}
            py={2}
            gap={2}
            cursor="pointer"
            bg={t.value === activeValue ? "blue.50" : undefined}
            _hover={{ bg: t.value === activeValue ? "blue.100" : "gray.50" }}
            onClick={() => onSelect(t.value)}
          >
            {t.highlight ? (
              <HStack
                px={2}
                py={0.5}
                bg={t.value === activeValue ? "blue.100" : "green.100"}
                color={t.value === activeValue ? "blue.700" : "green.700"}
                borderWidth="1px"
                borderColor={t.value === activeValue ? "blue.300" : "green.300"}
                fontSize="sm"
                fontWeight="bold"
                borderRadius="full"
                lineHeight="1.2"
                gap={1}
              >
                {t.icon && <Icon as={t.icon} boxSize={3.5} />}
                <Text>{t.label}</Text>
              </HStack>
            ) : t.chip ? (
              <HStack
                px={2}
                py={0.5}
                bg={t.value === activeValue ? "blue.100" : "gray.100"}
                borderWidth="1px"
                borderColor={t.value === activeValue ? "blue.300" : "gray.200"}
                borderRadius="full"
                lineHeight="1.2"
                gap={1.5}
              >
                {t.icon && <Icon as={t.icon} boxSize={3.5} color={t.value === activeValue ? "blue.600" : "fg.muted"} />}
                <Text
                  fontSize="sm"
                  fontWeight={t.value === activeValue ? "semibold" : "medium"}
                  color={t.value === activeValue ? "blue.700" : undefined}
                >
                  {t.label}
                </Text>
              </HStack>
            ) : (
              <>
                {t.icon && <Icon as={t.icon} boxSize={4} color={t.value === activeValue ? "blue.600" : "fg.muted"} />}
                <Text
                  fontSize="sm"
                  fontWeight={t.value === activeValue ? "semibold" : "normal"}
                  color={t.value === activeValue ? "blue.700" : undefined}
                >
                  {t.label}
                </Text>
              </>
            )}
            {/* Cross-role jump badges — render only when this inner tab
                exists under another outer role the user can access. Each
                badge skips the parent row's onClick via stopPropagation
                so tapping the chip doesn't ALSO select the tab within
                the current role first. */}
            {t.crossRoleTargets && t.crossRoleTargets.length > 0 && (
              <HStack gap={1} ml="auto" flexShrink={0}>
                {t.crossRoleTargets.map((target) => (
                  <Badge
                    key={target.outerValue}
                    as="button"
                    size="xs"
                    variant="outline"
                    colorPalette="gray"
                    borderRadius="full"
                    px="1.5"
                    cursor="pointer"
                    title={`Open ${t.label} in ${target.label}`}
                    aria-label={`Open ${t.label} in ${target.label}`}
                    onClick={(e: any) => {
                      e.stopPropagation();
                      jumpToCrossRole(t.value, target.outerValue);
                    }}
                    _hover={{ bg: "gray.100", borderColor: "gray.400" }}
                  >
                    <HStack gap={1} align="center">
                      {target.icon && <Icon as={target.icon} boxSize={3} />}
                      <Text fontSize="2xs" lineHeight="1">
                        {target.label.charAt(0).toUpperCase()}
                      </Text>
                      <ArrowUpRight size={10} />
                    </HStack>
                  </Badge>
                ))}
              </HStack>
            )}
          </HStack>
        ))}
      </Box>
    );
  }

  return (
    <Box>
      <HStack gap={1} pt={1} pb={2} pl={0} pr={1} align="center" flexWrap="nowrap" overflowX="auto" css={{ "&::-webkit-scrollbar": { display: "none" }, scrollbarWidth: "none" }}>
        {headerLeft}
        {/* Level 1: Outer (Client/Worker/Admin/Super) */}
        <Box position="relative" ref={outerRef}>
          <HStack
            as="button"
            gap={1}
            px={2}
            py={1}
            rounded="full"
            bg={outerOpen ? "gray.200" : "gray.100"}
            _hover={{ bg: "gray.200" }}
            cursor="pointer"
            onClick={() => { setOuterOpen(!outerOpen); setCatOpen(false); setInnerOpen(false); }}
            transition="all 0.1s"
            flexShrink={0}
          >
            {activeOuter?.icon && <Icon as={activeOuter.icon} boxSize={3.5} />}
            <Text fontSize="sm" fontWeight="semibold" lineHeight="1">{activeOuter?.label ?? "—"}</Text>
            <ChevronDown size={14} />
          </HStack>
          {outerOpen && renderDropdown(
            outerRef,
            visibleOuter.map((t) => ({ value: t.value, label: t.label, icon: t.icon })),
            outerValue,
            (v) => { onOuterChange(v); setOuterOpen(false); },
          )}
        </Box>


        {hasCategories ? (
          <>
            {/* Level 2: Category */}
            <Box position="relative" ref={catRef}>
              <HStack
                as="button"
                gap={1}
                px={3}
                py={1.5}
                rounded="full"
                bg={catOpen ? "teal.100" : "teal.50"}
                _hover={{ bg: "teal.100" }}
                cursor="pointer"
                onClick={() => { setCatOpen(!catOpen); setOuterOpen(false); setInnerOpen(false); }}
                transition="all 0.1s"
              >
                {activeCatObj?.icon && <Icon as={activeCatObj.icon} boxSize={3.5} color="teal.600" />}
                <Text fontSize="sm" fontWeight="semibold" color="teal.700" lineHeight="1">{activeCat ?? "—"}</Text>
                <ChevronDown size={14} style={{ color: "var(--chakra-colors-teal-500)" }} />
              </HStack>
              {catOpen && renderDropdown(
                catRef,
                categories.map((c) => ({ value: c.value, label: c.value, icon: c.icon, highlight: c.highlight })),
                activeCat ?? "",
                (v) => {
                  onCategoryChange?.(v);
                  setCatOpen(false);
                  const tabsInCat = visibleInner.filter((t) => t.category === v);
                  // Restore last selected tab in this category if available
                  const lastTab = lastTabPerCategory.current[v];
                  const remembered = lastTab ? tabsInCat.find((t) => t.value === lastTab) : null;
                  if (remembered) { onInnerChange(remembered.value); return; }
                  // Otherwise select the first tab in the category
                  if (tabsInCat[0]) onInnerChange(tabsInCat[0].value);
                },
              )}
            </Box>

            {/* Level 3: Inner tab — hidden when the current category has only one tab,
                since the inner level would just repeat the category label. */}
            {!isSingleTabCategory && (
              <>
                        <Box position="relative" ref={innerRef}>
                  <HStack
                    as="button"
                    gap={1}
                    px={3}
                    py={1.5}
                    rounded="full"
                    bg={innerOpen ? "blue.100" : "blue.50"}
                    _hover={{ bg: "blue.100" }}
                    cursor="pointer"
                    onClick={() => { setInnerOpen(!innerOpen); setOuterOpen(false); setCatOpen(false); }}
                    transition="all 0.1s"
                  >
                    {activeInnerResolved?.icon && <Icon as={activeInnerResolved.icon} boxSize={3.5} color="blue.600" />}
                    <Text fontSize="sm" fontWeight="semibold" color="blue.700" lineHeight="1">{activeInnerResolved?.label ?? "—"}</Text>
                    <ChevronDown size={14} style={{ color: "var(--chakra-colors-blue-500)" }} />
                  </HStack>
                  {innerOpen && renderDropdown(
                    innerRef,
                    categoryTabs.map((t) => ({
                      value: t.value,
                      label: t.label,
                      icon: t.icon,
                      chip: t.chip,
                      crossRoleTargets: computeCrossRoleTargets(t.value),
                    })),
                    innerValue,
                    (v) => { onInnerChange(v); setInnerOpen(false); },
                  )}
                </Box>
              </>
            )}
          </>
        ) : (
          /* No categories — show inner tabs directly as level 2 */
          <Box position="relative" ref={innerRef}>
            <HStack
              as="button"
              gap={1}
              px={3}
              py={1.5}
              rounded="full"
              bg={innerOpen ? "blue.100" : "blue.50"}
              _hover={{ bg: "blue.100" }}
              cursor="pointer"
              onClick={() => { setInnerOpen(!innerOpen); setOuterOpen(false); }}
              transition="all 0.1s"
            >
              {activeInnerResolved?.icon && <Icon as={activeInnerResolved.icon} boxSize={3.5} color="blue.600" />}
              <Text fontSize="sm" fontWeight="semibold" color="blue.700" lineHeight="1">{activeInnerResolved?.label ?? "—"}</Text>
              <ChevronDown size={14} style={{ color: "var(--chakra-colors-blue-500)" }} />
            </HStack>
            {innerOpen && renderDropdown(
              innerRef,
              visibleInner.map((t) => ({
                value: t.value,
                label: t.label,
                icon: t.icon,
                chip: t.chip,
                crossRoleTargets: computeCrossRoleTargets(t.value),
              })),
              innerValue,
              (v) => { onInnerChange(v); setInnerOpen(false); },
            )}
          </Box>
        )}
        {headerRight && (
          <Box flexShrink={0}>
            {headerRight}
          </Box>
        )}
      </HStack>

      {/* Header slot (alerts, workflows) */}
      {activeOuter?.headerSlot}

      {/* Active tab content — key forces remount on tab switch */}
      <Box key={`${activeOuter?.value}-${activeInnerResolved?.value}`}>
        {activeInnerResolved?.content}
      </Box>
    </Box>
  );
}
