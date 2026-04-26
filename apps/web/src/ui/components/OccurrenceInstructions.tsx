"use client";

import { useEffect, useState } from "react";
import { Badge, Box, Button, Checkbox, HStack, Spinner, Text, VStack } from "@chakra-ui/react";
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
  /** Called after edit saves, so parent can update count */
  onUpdated?: (newCount: number) => void;
};

type AllPhoto = PropertyPhotoItem & { selected: boolean };

export default function OccurrenceInstructions({ occurrenceId, count, propertyId, canEdit, defaultExpanded = true, onUpdated }: Props) {
  const [photos, setPhotos] = useState<PropertyPhotoItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const [editing, setEditing] = useState(false);
  const [allPhotos, setAllPhotos] = useState<AllPhoto[]>([]);
  const [editLoading, setEditLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [displayCount, setDisplayCount] = useState(count);

  useEffect(() => { setDisplayCount(count); }, [count]);

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
      await apiPut(`/api/admin/occurrences/${occurrenceId}/property-photos`, { propertyPhotoIds: ids });
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

  if (displayCount === 0 && !editing) {
    if (!canEdit || !propertyId) return null;
    // Show "Add Guidance" button for admins even when no instructions yet
    return (
      <Button
        size="xs"
        variant="outline"
        colorPalette="blue"
        onClick={() => { setEditing(true); setExpanded(true); }}
      >
        <Camera size={12} /> Add Guidance
      </Button>
    );
  }

  return (
    <Box borderWidth="1px" borderColor="blue.200" borderRadius="md" bg="blue.50" overflow="hidden">
      <HStack
        px={3} py={2}
        cursor="pointer"
        onClick={(e) => { e.stopPropagation(); setExpanded((v) => !v); }}
        justify="space-between"
      >
        <HStack gap={1.5} fontSize="xs" fontWeight="semibold" color="blue.700">
          <Camera size={14} />
          <Text>Guidance ({displayCount})</Text>
        </HStack>
        <HStack gap={1}>
          {canEdit && propertyId && !editing && (
            <Button
              size="xs"
              variant="ghost"
              px="1"
              minW="0"
              onClick={(e) => { e.stopPropagation(); setEditing(true); setExpanded(true); }}
              title="Edit guidance"
            >
              <Pencil size={12} />
            </Button>
          )}
          {expanded ? <ChevronUp size={14} color="var(--chakra-colors-blue-500)" /> : <ChevronDown size={14} color="var(--chakra-colors-blue-500)" />}
        </HStack>
      </HStack>

      {expanded && !editing && (
        <VStack align="stretch" gap={0} px={3} pb={3}>
          {loading && <Text fontSize="xs" color="fg.muted">Loading...</Text>}
          {photos.map((photo, idx) => (
            <HStack key={photo.id} gap={3} py={2} borderTopWidth="1px" borderColor="blue.100" align="start" onClick={(e) => e.stopPropagation()}>
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
          {editLoading && <HStack gap={2}><Spinner size="sm" /><Text fontSize="xs" color="fg.muted">Loading...</Text></HStack>}
          {allPhotos.map((photo) => (
            <HStack
              key={photo.id}
              gap={3}
              p={2}
              borderWidth="1px"
              borderColor={photo.selected ? "blue.300" : "gray.200"}
              bg={photo.selected ? "blue.100" : "white"}
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
    <HStack gap={1.5} px="2" py="1" bg="blue.50" borderWidth="1px" borderColor="blue.200" borderRadius="md" w="full">
      <Camera size={12} color="var(--chakra-colors-blue-600)" />
      <Text fontSize="xs" fontWeight="semibold" color="blue.700">Guidance ({count})</Text>
    </HStack>
  );
}
