"use client";

import { useEffect, useState } from "react";
import { Box, Checkbox, HStack, Spinner, Text, VStack } from "@chakra-ui/react";
import { Camera } from "lucide-react";
import { apiGet } from "@/src/lib/api";

type PropertyPhoto = {
  id: string;
  url: string;
  fileName?: string | null;
  description?: string | null;
  sortOrder: number;
};

type Props = {
  jobId: string;
  propertyId: string;
  /** If provided, load current selections from this occurrence instead of job defaults */
  occurrenceId?: string | null;
  /** Called whenever selection changes — parent is responsible for saving */
  onSelectionChange?: (selectedIds: string[]) => void;
};

export default function JobPropertyPhotosPicker({ jobId, propertyId, occurrenceId, onSelectionChange }: Props) {
  const [allPhotos, setAllPhotos] = useState<PropertyPhoto[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        // Always load all property photos
        const photos = await apiGet<PropertyPhoto[]>(`/api/admin/properties/${propertyId}/photos`);
        setAllPhotos(Array.isArray(photos) ? photos : []);

        // Load current selections: from occurrence if editing, otherwise from job defaults
        let currentIds: string[] = [];
        if (occurrenceId) {
          const occPhotos = await apiGet<{ id: string }[]>(`/api/occurrences/${occurrenceId}/property-photos`);
          currentIds = (Array.isArray(occPhotos) ? occPhotos : []).map((p) => p.id);
        } else {
          const defaults = await apiGet<{ propertyPhotoId: string }[]>(`/api/admin/jobs/${jobId}/property-photos`);
          currentIds = (Array.isArray(defaults) ? defaults : []).map((d) => d.propertyPhotoId);
        }
        setSelectedIds(new Set(currentIds));
      } catch {
        setAllPhotos([]);
      }
      setLoading(false);
    }
    void load();
  }, [jobId, propertyId, occurrenceId]);

  function toggle(photoId: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(photoId)) next.delete(photoId);
      else next.add(photoId);
      onSelectionChange?.(Array.from(next));
      return next;
    });
  }

  if (loading) return <HStack gap={2} py={2}><Spinner size="sm" /><Text fontSize="xs" color="fg.muted">Loading...</Text></HStack>;

  if (allPhotos.length === 0) {
    return (
      <Text fontSize="xs" color="fg.muted" py={2}>
        No property photos available. Upload photos on the property first.
      </Text>
    );
  }

  return (
    <Box>
      <HStack gap={1} mb={2} fontSize="xs" fontWeight="semibold" color="fg.muted">
        <Camera size={14} />
        <Text>Default Guidance ({selectedIds.size} of {allPhotos.length})</Text>
      </HStack>

      <VStack align="stretch" gap={1}>
        {allPhotos.map((photo) => (
          <HStack
            key={photo.id}
            gap={3}
            p={2}
            borderWidth="1px"
            borderColor={selectedIds.has(photo.id) ? "blue.300" : "gray.200"}
            bg={selectedIds.has(photo.id) ? "blue.50" : undefined}
            borderRadius="md"
            cursor="pointer"
            onClick={() => toggle(photo.id)}
            align="center"
          >
            <Checkbox.Root checked={selectedIds.has(photo.id)}>
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
            <Text fontSize="sm" color={photo.description ? "fg.default" : "fg.muted"} fontStyle={photo.description ? "normal" : "italic"} flex="1">
              {photo.description || "No description"}
            </Text>
          </HStack>
        ))}
      </VStack>
    </Box>
  );
}
