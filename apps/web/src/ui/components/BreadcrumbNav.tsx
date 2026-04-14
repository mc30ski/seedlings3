"use client";

import React, { useEffect, useRef, useState } from "react";
import { Box, HStack, Icon, Text } from "@chakra-ui/react";
import { ChevronDown } from "lucide-react";

export type InnerTab = {
  value: string;
  label: string;
  icon?: React.ElementType;
  visible?: boolean | (() => boolean);
  content?: React.ReactNode;
  category?: string; // group tabs into categories
  categoryIcon?: React.ElementType; // icon for the category
  categoryHighlight?: boolean; // highlight this category in the dropdown
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
  const isSingleTabCategory = hasCategories && categoryTabs.length === 1;

  // Resolve active inner tab within the category
  const activeInnerResolved = categoryTabs.find((t) => t.value === innerValue) ?? categoryTabs[0] ?? activeInner ?? visibleInner[0];

  function renderDropdown(
    ref: React.RefObject<HTMLDivElement | null>,
    items: { value: string; label: string; icon?: React.ElementType; highlight?: boolean }[],
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
        maxH="400px"
        overflowY="auto"
        py={1}
        style={{
          top: (ref.current?.getBoundingClientRect().bottom ?? 0) + 4,
          left: Math.min(
            ref.current?.getBoundingClientRect().left ?? 0,
            (typeof window !== "undefined" ? window.innerWidth : 400) - 200
          ),
        }}
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
          </HStack>
        ))}
      </Box>
    );
  }

  return (
    <Box>
      <HStack gap={1} py={2} px={1} align="center" flexWrap="nowrap" overflowX="auto" css={{ "&::-webkit-scrollbar": { display: "none" }, scrollbarWidth: "none" }}>
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

        <Text color="fg.muted" fontSize="sm" userSelect="none">/</Text>

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

            {/* Level 3: Inner tab — only if category has multiple tabs */}
            {!isSingleTabCategory && (
              <>
                <Text color="fg.muted" fontSize="sm" userSelect="none">/</Text>
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
                    categoryTabs.map((t) => ({ value: t.value, label: t.label, icon: t.icon })),
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
              visibleInner.map((t) => ({ value: t.value, label: t.label, icon: t.icon })),
              innerValue,
              (v) => { onInnerChange(v); setInnerOpen(false); },
            )}
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
