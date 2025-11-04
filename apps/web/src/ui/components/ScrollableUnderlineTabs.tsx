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
  Button,
} from "@chakra-ui/react";
import { FiChevronLeft, FiChevronRight } from "react-icons/fi";

export type TabItem = {
  value: string;
  label: string;
  icon?: React.ElementType;
  disabled?: boolean;
  content?: React.ReactNode;
  visible?: boolean | (() => boolean);
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
  edgeMode = "overlay",
  edgeSize = 18,
}: Props) {
  const visibleTabs = useMemo(
    () => tabs.filter((t) => isVisible(t.visible)),
    [tabs]
  );

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

  // scroll indicators
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [canLeft, setCanLeft] = useState(false);
  const [canRight, setCanRight] = useState(false);

  const updateIndicators = () => {
    const el = scrollRef.current;
    if (!el) return;
    const { scrollLeft, scrollWidth, clientWidth } = el;
    setCanLeft(scrollLeft > 0);
    setCanRight(scrollLeft + clientWidth < scrollWidth - 1);
  };

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    updateIndicators();
    const onScroll = () => updateIndicators();
    el.addEventListener("scroll", onScroll, { passive: true });
    const ro = new ResizeObserver(updateIndicators);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", onScroll);
      ro.disconnect();
    };
  }, []);

  useEffect(() => {
    updateIndicators();
  }, [visibleTabs.length]);

  const scrollByAmount = (dir: "left" | "right") => {
    const el = scrollRef.current;
    if (!el) return;
    const amt = Math.round(el.clientWidth * 0.75);
    el.scrollBy({ left: dir === "left" ? -amt : amt, behavior: "smooth" });
  };

  return (
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
      >
        <Box position="relative">
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
              onScroll={updateIndicators}
            >
              {visibleTabs.map((t) => (
                <TabsTrigger
                  key={t.value}
                  value={t.value}
                  disabled={t.disabled}
                  asChild
                >
                  <Flex
                    align="center"
                    gap={2}
                    px={3}
                    py={2}
                    flex="0 0 auto" /* no growth → prevents width inflation */
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
                  >
                    {t.icon && <Icon as={t.icon} boxSize="1em" />}
                    <span>{t.label}</span>
                  </Flex>
                </TabsTrigger>
              ))}

              {/* Keep the indicator INSIDE the scrollable list */}
              {showIndicator && (
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

          {/* Slim fades */}
          {edgeMode !== "none" && (
            <>
              <Box
                pointerEvents="none"
                position="absolute"
                left="0"
                top="0"
                bottom="0"
                width={`${edgeSize}px`}
                bgGradient="linear(to-r, white, rgba(255,255,255,0))"
              />
              <Box
                pointerEvents="none"
                position="absolute"
                right="0"
                top="0"
                bottom="0"
                width={`${edgeSize}px`}
                bgGradient="linear(to-l, white, rgba(255,255,255,0))"
              />
            </>
          )}

          {/* Overlay arrows */}
          {edgeMode === "overlay" && canLeft && (
            <Button
              onClick={() => scrollByAmount("left")}
              position="absolute"
              left="4px"
              top="50%"
              transform="translateY(-50%)"
              size="xs"
              variant="ghost"
              bg="whiteAlpha.700"
              backdropFilter="saturate(120%) blur(2px)"
              boxShadow="sm"
              borderRadius="full"
              _hover={{ bg: "whiteAlpha.800" }}
              _active={{ bg: "whiteAlpha.900" }}
              aria-label="Scroll left"
              zIndex={1}
              px={1.5}
              minW="auto"
              height="22px"
            >
              <Icon as={FiChevronLeft} />
            </Button>
          )}
          {edgeMode === "overlay" && canRight && (
            <Button
              onClick={() => scrollByAmount("right")}
              position="absolute"
              right="4px"
              top="50%"
              transform="translateY(-50%)"
              size="xs"
              variant="ghost"
              bg="whiteAlpha.700"
              backdropFilter="saturate(120%) blur(2px)"
              boxShadow="sm"
              borderRadius="full"
              _hover={{ bg: "whiteAlpha.800" }}
              _active={{ bg: "whiteAlpha.900" }}
              aria-label="Scroll right"
              zIndex={1}
              px={1.5}
              minW="auto"
              height="22px"
            >
              <Icon as={FiChevronRight} />
            </Button>
          )}
        </Box>
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
  );
}
