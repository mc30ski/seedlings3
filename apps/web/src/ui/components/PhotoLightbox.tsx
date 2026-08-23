"use client";

// Shared full-screen photo viewer with carousel navigation.
//
// Extracted verbatim from pages/pay/[paymentToken].tsx so the promotion landing
// page can reuse it rather than carry a second copy — the two behaved
// identically and would have drifted. Keyboard (arrows + Escape), swipe,
// on-screen arrows, and an "n / total" counter.

import { useEffect, useRef } from "react";
import { Box, Text } from "@chakra-ui/react";
import { ChevronLeft, ChevronRight, X } from "lucide-react";

export default function PhotoLightbox({
  photos,
  index,
  onClose,
  onPrev,
  onNext,
}: {
  photos: { url: string }[];
  index: number;
  onClose: () => void;
  onPrev: () => void;
  onNext: () => void;
}) {
  const touchXRef = useRef<number | null>(null);
  const hasPrev = index > 0;
  const hasNext = index < photos.length - 1;
  const current = photos[index];

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "ArrowLeft") { e.preventDefault(); onPrev(); }
      else if (e.key === "ArrowRight") { e.preventDefault(); onNext(); }
      else if (e.key === "Escape") { e.preventDefault(); onClose(); }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onPrev, onNext, onClose]);

  if (!current) return null;

  return (
    <Box
      position="fixed"
      inset="0"
      zIndex="9999"
      bg="blackAlpha.800"
      display="flex"
      alignItems="center"
      justifyContent="center"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      onTouchStart={(e) => { touchXRef.current = e.touches[0].clientX; }}
      onTouchEnd={(e) => {
        if (touchXRef.current === null) return;
        const dx = e.changedTouches[0].clientX - touchXRef.current;
        touchXRef.current = null;
        if (Math.abs(dx) > 50) {
          if (dx < 0) onNext();
          else onPrev();
        }
      }}
    >
      {hasPrev && (
        <Box
          position="absolute"
          left="3"
          top="50%"
          transform="translateY(-50%)"
          color="white"
          cursor="pointer"
          p={2}
          zIndex={1}
          onClick={(e) => { e.stopPropagation(); onPrev(); }}
          userSelect="none"
        >
          <ChevronLeft size={28} />
        </Box>
      )}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={current.url}
        alt=""
        style={{ maxWidth: "90vw", maxHeight: "80vh", objectFit: "contain", borderRadius: "8px" }}
        onClick={(e) => e.stopPropagation()}
      />
      {hasNext && (
        <Box
          position="absolute"
          right="3"
          top="50%"
          transform="translateY(-50%)"
          color="white"
          cursor="pointer"
          p={2}
          zIndex={1}
          onClick={(e) => { e.stopPropagation(); onNext(); }}
          userSelect="none"
        >
          <ChevronRight size={28} />
        </Box>
      )}
      <Box
        position="absolute"
        top="3"
        right="3"
        color="white"
        cursor="pointer"
        p={2}
        zIndex={1}
        onClick={(e) => { e.stopPropagation(); onClose(); }}
        userSelect="none"
        aria-label="Close"
      >
        <X size={24} />
      </Box>
      <Text
        position="absolute"
        bottom="4"
        left="0"
        right="0"
        textAlign="center"
        color="whiteAlpha.700"
        fontSize="sm"
      >
        {index + 1} / {photos.length}
      </Text>
    </Box>
  );
}
