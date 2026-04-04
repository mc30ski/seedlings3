"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  TabsRoot,
  TabsList,
  TabsTrigger,
  TabsContent,
  TabsIndicator,
  Box,
  Flex,
  Icon,
} from "@chakra-ui/react";
import { FiMoreHorizontal } from "react-icons/fi";

export type TabItem = {
  value: string;
  label: string;
  icon?: React.ElementType;
  disabled?: boolean;
  content?: React.ReactNode;
  visible?: boolean | (() => boolean);
  /** If false, tab is hidden behind "More" menu. Default true. */
  pinned?: boolean;
};

type EdgeMode = "buttons" | "fade" | "overlay" | "none";

type Props = {
  tabs: TabItem[];
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  lazyMount?: boolean;
  unmountOnExit?: boolean;
  showIndicator?: boolean;
  ariaLabel?: string;
  headerPaddingX?: number;
  headerPaddingY?: number;
  renderHeaderOnly?: boolean;
  className?: string;
  headerClassName?: string;
  contentClassName?: string;

  /** Content rendered on the right side of the tab header */
  headerRight?: React.ReactNode;

  /** Edge presentation */
  edgeMode?: EdgeMode; // "overlay" is the compact one
  edgeSize?: number; // width of fade zones
};

function isVisible(v: TabItem["visible"]) {
  if (typeof v === "function") return !!v();
  return v ?? true;
}

export default function ScrollableUnderlineTabs({
  tabs,
  value,
  defaultValue,
  onValueChange,
  lazyMount = true,
  unmountOnExit = false,
  showIndicator = true,
  ariaLabel = "Tabs",
  headerPaddingX = 0,
  headerPaddingY = 0,
  renderHeaderOnly = false,
  className,
  headerClassName,
  contentClassName,
  headerRight,
}: Props) {
  const visibleTabs = useMemo(
    () => tabs.filter((t) => isVisible(t.visible)),
    [tabs]
  );

  // Responsive overflow: measure which tabs fit, put rest in "More"
  const containerRef = useRef<HTMLDivElement>(null);
  const tabRefsMap = useRef<Map<string, HTMLElement>>(new Map());
  const moreButtonWidth = 80; // approximate width of "⋯ More" button
  const [fittingCount, setFittingCount] = useState(visibleTabs.length);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  const moreDropdownRef = useRef<HTMLDivElement>(null);

  const measureFit = () => {
    const container = containerRef.current;
    if (!container) return;
    const containerWidth = container.clientWidth;
    let usedWidth = 0;
    let count = 0;
    for (const t of visibleTabs) {
      const el = tabRefsMap.current.get(t.value);
      const w = el ? el.offsetWidth + 8 : 80; // 8 for gap
      if (count < visibleTabs.length - 1) {
        // Not the last tab — check if it fits with room for "More"
        if (usedWidth + w + moreButtonWidth > containerWidth) break;
      } else {
        // Last tab — no need for "More" button
        if (usedWidth + w > containerWidth) break;
      }
      usedWidth += w;
      count++;
    }
    // If all tabs fit, show all. Otherwise show count that fit.
    setFittingCount(count >= visibleTabs.length ? visibleTabs.length : count);
  };

  useEffect(() => {
    measureFit();
    const ro = new ResizeObserver(measureFit);
    if (containerRef.current) ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, [visibleTabs.length, visibleTabs.map((t) => t.value).join("|")]);

  const overflowTabs = visibleTabs.slice(fittingCount);

  // Close "More" on outside click
  useEffect(() => {
    if (!moreOpen) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        moreRef.current && !moreRef.current.contains(target) &&
        moreDropdownRef.current && !moreDropdownRef.current.contains(target)
      ) {
        setMoreOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [moreOpen]);

  const initial = useMemo(() => {
    if (value !== undefined) return value;
    if (defaultValue && visibleTabs.some((t) => t.value === defaultValue))
      return defaultValue;
    return visibleTabs[0]?.value ?? "";
  }, [value, defaultValue, visibleTabs]);

  const [internal, setInternal] = useState(initial);
  const isControlled = value !== undefined;
  const current = isControlled ? (value as string) : internal;

  useEffect(() => {
    if (!visibleTabs.length) return;
    const stillVisible = visibleTabs.some((t) => t.value === current);
    if (!stillVisible) {
      const fallback = visibleTabs[0].value;
      if (isControlled) onValueChange?.(fallback);
      else setInternal(fallback);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleTabs.map((t) => t.value).join("|")]);

  const scrollRef = useRef<HTMLDivElement | null>(null);

  return (
    <>
    <TabsRoot
      value={current}
      onValueChange={(d) => {
        if (isControlled) onValueChange?.(d.value);
        else setInternal(d.value);
      }}
      activationMode="manual"
      lazyMount={lazyMount}
      unmountOnExit={unmountOnExit}
      className={className}
    >
      <Box
        borderColor="gray.200"
        bg="white"
        position="relative"
        px={headerPaddingX}
        py={headerPaddingY}
        className={headerClassName}
        display="flex"
        alignItems="center"
        gap={2}
      >
        <Box ref={containerRef} position="relative" flex="1" minW={0}>
          {/* Make TabsList the actual scroll container */}
          <TabsList asChild>
            <Box
              ref={scrollRef}
              role="tablist"
              aria-label={ariaLabel}
              position="relative"
              display="flex"
              gap={2}
              overflowX="auto"
              whiteSpace="nowrap"
              px={1}
              css={{
                scrollbarWidth: "none",
                msOverflowStyle: "none",
                "&::-webkit-scrollbar": { display: "none" },
              }}
            >
              {visibleTabs.map((t, i) => {
                const isOverflow = i >= fittingCount;
                return (
                  <TabsTrigger
                    key={t.value}
                    value={t.value}
                    disabled={t.disabled}
                    asChild
                  >
                    <Flex
                      ref={(el: HTMLElement | null) => { if (el) tabRefsMap.current.set(t.value, el); }}
                      align="center"
                      gap={2}
                      px={3}
                      py={2}
                      flex="0 0 auto"
                      borderBottom="2px solid transparent"
                      color="gray.700"
                      _hover={{ color: "gray.900", bg: "gray.50" }}
                      css={{
                        "&[data-state=active]": {
                          borderColor: "blue.600",
                          color: "blue.700",
                          fontWeight: 600,
                        },
                      }}
                      style={isOverflow ? { position: "absolute", visibility: "hidden", pointerEvents: "none" } : undefined}
                    >
                      {t.icon && <Icon as={t.icon} boxSize="1em" />}
                      <span>{t.label}</span>
                    </Flex>
                  </TabsTrigger>
                );
              })}
              {/* "More" trigger inline with tabs */}
              {overflowTabs.length > 0 && (
                <Flex
                  ref={moreRef}
                  align="center"
                  gap={2}
                  px={3}
                  py={2}
                  flex="0 0 auto"
                  cursor="pointer"
                  fontSize="sm"
                  borderBottom="2px solid transparent"
                  color={overflowTabs.some((t) => t.value === current) ? "blue.700" : "gray.700"}
                  fontWeight={overflowTabs.some((t) => t.value === current) ? 600 : undefined}
                  _hover={{ color: "gray.900", bg: "gray.50" }}
                  css={overflowTabs.some((t) => t.value === current) ? {
                    borderColor: "blue.600",
                  } : undefined}
                  onClick={() => setMoreOpen((o) => !o)}
                >
                  <Icon as={FiMoreHorizontal} boxSize="1em" />
                  <span>More</span>
                </Flex>
              )}

              {/* Keep the indicator INSIDE the scrollable list — hide when overflow tab is active */}
              {showIndicator && !overflowTabs.some((t) => t.value === current) && (
                <TabsIndicator
                  position="absolute"
                  bottom="0"
                  left="0"
                  height="2px"
                  bg="blue.600"
                  borderRadius="full"
                />
              )}
            </Box>
          </TabsList>

        </Box>
        {/* "More" dropdown rendered via portal to escape overflow clipping */}
        {headerRight && (
          <Box flexShrink={0} display="flex" alignItems="center">
            {headerRight}
          </Box>
        )}
      </Box>

      {!renderHeaderOnly && (
        <Box className={contentClassName}>
          {visibleTabs.map(
            (t) =>
              t.content !== undefined && (
                <TabsContent key={t.value} value={t.value}>
                  {t.content}
                </TabsContent>
              )
          )}
        </Box>
      )}
    </TabsRoot>
    {/* More dropdown — fixed position to escape overflow clipping */}
    {moreOpen && overflowTabs.length > 0 && (
      <div
        ref={moreDropdownRef}
        onTouchMove={(e) => e.stopPropagation()}
        style={{
          position: "fixed",
          zIndex: 99999,
          backgroundColor: "#ffffff",
          border: "1px solid #e2e8f0",
          borderRadius: "6px",
          boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
          maxHeight: "320px",
          overflowY: "auto",
          overscrollBehavior: "contain",
          WebkitOverflowScrolling: "touch",
          minWidth: "180px",
          top: (moreRef.current?.getBoundingClientRect().bottom ?? 0) + 2,
          left: Math.min(
            moreRef.current?.getBoundingClientRect().left ?? 0,
            window.innerWidth - 200,
          ),
        }}
      >
        {overflowTabs.map((t) => {
          const isActive = current === t.value;
          return (
            <div
              key={t.value}
              style={{
                padding: "8px 12px",
                cursor: "pointer",
                fontSize: "14px",
                display: "flex",
                alignItems: "center",
                gap: "8px",
                backgroundColor: isActive ? "#ebf8ff" : "#ffffff",
                color: isActive ? "#2b6cb0" : "#4a5568",
                fontWeight: isActive ? 600 : 400,
              }}
              onMouseEnter={(e) => { if (!isActive) (e.currentTarget).style.backgroundColor = "#f7fafc"; }}
              onMouseLeave={(e) => { (e.currentTarget).style.backgroundColor = isActive ? "#ebf8ff" : "#ffffff"; }}
              onClick={() => {
                if (isControlled) onValueChange?.(t.value);
                else setInternal(t.value);
                setMoreOpen(false);
              }}
            >
              {t.icon && <Icon as={t.icon} boxSize="1em" />}
              <span>{t.label}</span>
            </div>
          );
        })}
      </div>
    )}
    </>
  );
}
