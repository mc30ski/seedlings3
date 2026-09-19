"use client";

import { useEffect, useState } from "react";
import { Badge, Box, Button, Checkbox, HStack, Spinner, Text, Textarea, VStack } from "@chakra-ui/react";
import { Camera, ChevronDown, ChevronUp, Pencil } from "lucide-react";
import { apiGet, apiPut } from "@/src/lib/api";
import { type PropertyPhotoItem } from "@/src/lib/types";
import { publishInlineMessage, getErrorMessage } from "@/src/ui/components/InlineMessage";

type Props = {
  occurrenceId: string;
  /** Number of property photos (from inline data, avoids extra API call for count) */
  count: number;
  /** Property ID — needed for editing (fetching all available photos) */
  propertyId?: string | null;
  /** Allow editing (admin only) */
  canEdit?: boolean;
  /** Start expanded? */
  defaultExpanded?: boolean;
  /** Start in edit mode immediately */
  startInEditMode?: boolean;
  /** Current overall guidance description (separate from per-photo captions) */
  guidanceNote?: string | null;
  /** Fired whenever the drawer opens or closes. The pulse that draws
   *  attention to this section lives on the PARENT (it has to wrap the
   *  whole box), so the parent needs to know the moment it has been read —
   *  otherwise it keeps flashing at someone already looking at it. */
  onExpandedChange?: (expanded: boolean) => void;
  /** Breathe the header band to say "there is something unread in here".
   *  The pulse has to live on the HEADER, not on a wrapper around the whole
   *  drawer: a ring drawn around a blue box in the same blue reads as
   *  nothing. Only ever applied while collapsed — an open drawer is being
   *  read, and pulsing at it is just noise. */
  pulse?: boolean;
  /** Called after edit saves, so parent can update count */
  onUpdated?: (newCount: number) => void;
};

type AllPhoto = PropertyPhotoItem & { selected: boolean };

export default function OccurrenceInstructions({ occurrenceId, count, propertyId, canEdit, defaultExpanded = true, startInEditMode, guidanceNote, onUpdated, onExpandedChange, pulse }: Props) {
  const [photos, setPhotos] = useState<PropertyPhotoItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [expanded, setExpandedState] = useState(defaultExpanded);
  /** Every path that changes `expanded` goes through here — there are four
   *  of them (header toggle, two Manage buttons, the empty-state button) and
   *  a parent that missed one would keep pulsing at an open drawer. */
  const setExpanded = (next: boolean | ((v: boolean) => boolean)) => {
    setExpandedState((v) => {
      const resolved = typeof next === "function" ? next(v) : next;
      if (resolved !== v) onExpandedChange?.(resolved);
      return resolved;
    });
  };
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const [editing, setEditing] = useState(!!startInEditMode);
  const [allPhotos, setAllPhotos] = useState<AllPhoto[]>([]);
  const [editLoading, setEditLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [displayCount, setDisplayCount] = useState(count);
  const [noteText, setNoteText] = useState(guidanceNote ?? "");

  useEffect(() => { setDisplayCount(count); }, [count]);
  useEffect(() => { setNoteText(guidanceNote ?? ""); }, [guidanceNote]);

  // Load occurrence's current instructions
  useEffect(() => {
    if (!expanded || loaded || displayCount === 0) return;
    setLoading(true);
    apiGet<PropertyPhotoItem[]>(`/api/occurrences/${occurrenceId}/property-photos`)
      .then((list) => { setPhotos(Array.isArray(list) ? list : []); setLoaded(true); })
      .catch(() => setPhotos([]))
      .finally(() => setLoading(false));
  }, [expanded, loaded, occurrenceId, displayCount]);

  // Load all property photos when entering edit mode
  useEffect(() => {
    if (!editing || !propertyId) return;
    setEditLoading(true);
    Promise.all([
      apiGet<PropertyPhotoItem[]>(`/api/admin/properties/${propertyId}/photos`),
      apiGet<PropertyPhotoItem[]>(`/api/occurrences/${occurrenceId}/property-photos`),
    ]).then(([all, current]) => {
      const currentIds = new Set((Array.isArray(current) ? current : []).map((p) => p.id));
      setAllPhotos((Array.isArray(all) ? all : []).map((p) => ({ ...p, selected: currentIds.has(p.id) })));
    }).catch(() => setAllPhotos([]))
      .finally(() => setEditLoading(false));
  }, [editing, propertyId, occurrenceId]);

  function togglePhoto(photoId: string) {
    setAllPhotos((prev) => prev.map((p) => p.id === photoId ? { ...p, selected: !p.selected } : p));
  }

  async function saveEdit() {
    setSaving(true);
    try {
      const ids = allPhotos.filter((p) => p.selected).map((p) => p.id);
      await apiPut(`/api/admin/occurrences/${occurrenceId}/property-photos`, {
        propertyPhotoIds: ids,
        guidanceNote: noteText.trim() || null,
      });
      // Refresh display
      setPhotos(allPhotos.filter((p) => p.selected));
      setDisplayCount(ids.length);
      setLoaded(true);
      setEditing(false);
      onUpdated?.(ids.length);
      publishInlineMessage({ type: "SUCCESS", text: "Guidance updated." });
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Save failed.", err) });
    }
    setSaving(false);
  }

  if (displayCount === 0 && !noteText && !editing) {
    if (!canEdit || !propertyId) return null;
    return (
      <Button
        size="xs"
        variant="outline"
        onClick={() => { setEditing(true); setExpanded(true); }}
      >
        Manage Guidance
      </Button>
    );
  }

  // DARKER THAN blue.faint ON PURPOSE. The job weather panel is
  // `blue.emphasized` border on `blue.faint` — byte-identical to what this
  // drawer used to be — so on an expanded card the two read as one repeated
  // element. Guidance now carries a solid header band matching the saturation
  // of its collapsed-card chip (`blue.400`), which is what ties the two
  // together for someone who tapped that chip to get here.
  //
  // Dialled back one step from `blue.solid` (#2563eb), which was a hard
  // saturated band — correct in being unmistakable, too heavy for something
  // that sits at the top of every card carrying guidance. `blue.muted` header
  // over a `blue.subtle` body keeps the header reading as a header, stays a
  // full step darker than the weather panel, and stops shouting.
  return (
    <Box
      borderWidth="1px"
      borderColor="blue.strong"
      borderRadius="md"
      bg="blue.subtle"
      overflow="hidden"
      // THE PULSE LIVES HERE, NOT ON THE HEADER INSIDE.
      //
      // `overflow="hidden"` on this Box clips its children's box-shadows.
      // With the animation on the header, the expanding ring — the part that
      // actually reads as a pulse — was cut off at this boundary every
      // frame, leaving only the background fade behind. Hence two rounds of
      // "it is not pulsating, it is just changing colour": it literally was
      // only changing colour. An element's OWN shadow is not clipped by its
      // own overflow, so the ring escapes from here.
      data-guidance-pulse={pulse && !expanded ? "1" : undefined}
      css={pulse && !expanded
        ? { animation: "seedlings-pulse-guidance 1.8s ease-in-out infinite" }
        : undefined}
    >
      <HStack
        px={3} py={2}
        // Transparent while pulsing so the Box's breathing background shows
        // through — collapsed, this band IS the whole drawer, and an opaque
        // fill here would hide the animation completely.
        bg={pulse && !expanded ? "transparent" : "blue.muted"}
        color="blue.fg"
        cursor="pointer"
        onClick={(e) => { e.stopPropagation(); setExpanded((v) => !v); }}
        justify="space-between"
      >
        <HStack gap={1.5} fontSize="xs" fontWeight="semibold">
          <Camera size={14} />
          <Text>Guidance ({displayCount})</Text>
        </HStack>
        <HStack gap={1}>
          {canEdit && propertyId && !editing && (
            <Button
              size="xs"
              variant="outline"
              onClick={(e) => { e.stopPropagation(); setEditing(true); setExpanded(true); }}
            >
              Manage
            </Button>
          )}
          {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </HStack>
      </HStack>

      {expanded && !editing && (
        <VStack align="stretch" gap={0} px={3} pb={3}>
          {noteText && (
            <Text fontSize="sm" color="fg.default" pb={2} whiteSpace="pre-wrap">
              {noteText}
            </Text>
          )}
          {loading && <Text fontSize="xs" color="fg.muted">Loading...</Text>}
          {photos.map((photo, idx) => (
            <HStack key={photo.id} gap={3} py={2} borderTopWidth="1px" borderColor="blue.emphasized" align="start" onClick={(e) => e.stopPropagation()}>
              <Box
                flexShrink={0}
                w="80px"
                h="80px"
                borderRadius="md"
                overflow="hidden"
                cursor="pointer"
                onClick={(e) => { e.stopPropagation(); setViewerIndex(idx); }}
              >
                <img
                  src={photo.url}
                  alt={photo.description || "Guidance"}
                  style={{ width: "100%", height: "100%", objectFit: "cover" }}
                />
              </Box>
              <Text fontSize="sm" color="fg.default" flex="1">
                {photo.description || <Text as="span" color="fg.muted" fontStyle="italic">No description</Text>}
              </Text>
            </HStack>
          ))}
        </VStack>
      )}

      {expanded && editing && (
        <VStack align="stretch" gap={1} px={3} pb={3}>
          <Box>
            <Text fontSize="xs" fontWeight="semibold" color="blue.fg" mb={1}>Overall description</Text>
            <Textarea
              size="sm"
              bg="bg.panel"
              rows={3}
              placeholder="Optional — describe the work overall (separate from the photos)."
              value={noteText}
              onChange={(e) => setNoteText(e.target.value)}
            />
          </Box>
          <Text fontSize="xs" fontWeight="semibold" color="blue.fg" mt={1}>Photos</Text>
          {editLoading && <HStack gap={2}><Spinner size="sm" /><Text fontSize="xs" color="fg.muted">Loading...</Text></HStack>}
          {!editLoading && allPhotos.length === 0 && (
            <Text fontSize="xs" color="fg.muted" fontStyle="italic">
              There are no photos to share. Add photos to the property first.
            </Text>
          )}
          {allPhotos.map((photo) => (
            <HStack
              key={photo.id}
              gap={3}
              p={2}
              borderWidth="1px"
              borderColor={photo.selected ? "blue.emphasized" : "gray.emphasized"}
              bg={photo.selected ? "blue.subtle" : "bg.panel"}
              borderRadius="md"
              cursor="pointer"
              onClick={() => togglePhoto(photo.id)}
              align="center"
            >
              <Checkbox.Root checked={photo.selected}>
                <Checkbox.HiddenInput />
                <Checkbox.Control />
              </Checkbox.Root>
              <Box flexShrink={0} w="50px" h="50px" borderRadius="md" overflow="hidden">
                <img
                  src={photo.url}
                  alt={photo.description || "Property photo"}
                  style={{ width: "100%", height: "100%", objectFit: "cover" }}
                />
              </Box>
              <Text fontSize="xs" color={photo.description ? "fg.default" : "fg.muted"} fontStyle={photo.description ? "normal" : "italic"} flex="1">
                {photo.description || "No description"}
              </Text>
            </HStack>
          ))}
          <HStack gap={2} mt={1}>
            <Button size="xs" colorPalette="blue" loading={saving} onClick={saveEdit}>Save</Button>
            <Button size="xs" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
          </HStack>
        </VStack>
      )}

      {/* Full-size viewer with navigation */}
      {viewerIndex != null && photos[viewerIndex] && (() => {
        const photo = photos[viewerIndex];
        const hasPrev = viewerIndex > 0;
        const hasNext = viewerIndex < photos.length - 1;
        const navigate = (dir: -1 | 1) => {
          const next = viewerIndex + dir;
          if (next >= 0 && next < photos.length) setViewerIndex(next);
        };
        return (
          <Box
            position="fixed"
            inset="0"
            zIndex={10000}
            bg="blackAlpha.800"
            display="flex"
            flexDirection="column"
            alignItems="center"
            justifyContent="center"
            onClick={(e) => { e.stopPropagation(); setViewerIndex(null); }}
            onKeyDown={(e) => {
              if (e.key === "ArrowLeft" && hasPrev) { e.preventDefault(); navigate(-1); }
              else if (e.key === "ArrowRight" && hasNext) { e.preventDefault(); navigate(1); }
              else if (e.key === "Escape") setViewerIndex(null);
            }}
            onTouchStart={(e) => { (e.currentTarget as any)._touchX = e.touches[0].clientX; }}
            onTouchEnd={(e) => {
              const dx = e.changedTouches[0].clientX - ((e.currentTarget as any)._touchX ?? 0);
              if (Math.abs(dx) > 50) { dx < 0 ? navigate(1) : navigate(-1); }
            }}
            tabIndex={0}
            ref={(el: HTMLDivElement | null) => el?.focus()}
          >
            {hasPrev && (
              <Box position="absolute" left="3" top="50%" transform="translateY(-50%)" color="white" fontSize="2xl" cursor="pointer" p={2} onClick={(e) => { e.stopPropagation(); navigate(-1); }} userSelect="none">
                ◀
              </Box>
            )}
            <img
              src={photo.url}
              alt={photo.description || "Guidance"}
              style={{ maxWidth: "90vw", maxHeight: "70vh", objectFit: "contain", borderRadius: "8px" }}
              onClick={(e) => e.stopPropagation()}
            />
            {photo.description && (
              <Box mt={3} px={4} py={2} bg="blackAlpha.600" borderRadius="md" maxW="90vw" onClick={(e) => e.stopPropagation()}>
                <Text color="white" fontSize="sm" textAlign="center">{photo.description}</Text>
              </Box>
            )}
            <Text position="absolute" bottom="4" color="whiteAlpha.700" fontSize="sm">
              {viewerIndex + 1} / {photos.length}
            </Text>
            {hasNext && (
              <Box position="absolute" right="3" top="50%" transform="translateY(-50%)" color="white" fontSize="2xl" cursor="pointer" p={2} onClick={(e) => { e.stopPropagation(); navigate(1); }} userSelect="none">
                ▶
              </Box>
            )}
          </Box>
        );
      })()}
    </Box>
  );
}

/** Compact guidance indicator for collapsed cards */
export function InstructionsBadge({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <HStack gap={1.5} px="2" py="1" bg="blue.subtle" borderWidth="1px" borderColor="blue.strong" borderRadius="md">
      <Camera size={12} color="var(--chakra-colors-blue-600)" />
      <Text fontSize="xs" fontWeight="semibold" color="blue.fg">Guidance ({count})</Text>
    </HStack>
  );
}
