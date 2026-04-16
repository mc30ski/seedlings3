"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Badge,
  Box,
  Button,
  Dialog,
  HStack,
  Portal,
  Text,
  VStack,
  Textarea,
} from "@chakra-ui/react";
import { Check, Image, Share2, X, ChevronDown, ChevronUp, Copy, Download } from "lucide-react";
import { apiGet } from "@/src/lib/api";
import { bizDateKey, fmtDate } from "@/src/lib/lib";
import { computeDatesFromPreset } from "@/src/lib/datePresets";
import DateInput from "@/src/ui/components/DateInput";
import {
  publishInlineMessage,
} from "@/src/ui/components/InlineMessage";

type PhotoItem = {
  id: string;
  fileName?: string | null;
  contentType?: string | null;
  uploadedBy?: { id: string; displayName?: string | null };
  createdAt: string;
  url: string;
  occurrence: {
    id: string;
    startAt: string | null;
    status: string;
    jobType?: string | null;
    property?: {
      displayName: string;
      address: string;
    } | null;
  };
};

type Props = {
  active: boolean;
  onDone: () => void;
};

export default function SharePhotosWorkflow({ active, onDone }: Props) {
  const [photos, setPhotos] = useState<PhotoItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [caption, setCaption] = useState("");
  const [step, setStep] = useState<"select" | "compose">("select");
  const [sharing, setSharing] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  // Date range — default to last 7 days
  const defaults = useMemo(() => computeDatesFromPreset("lastWeek"), []);
  const [dateFrom, setDateFrom] = useState(defaults.from);
  const [dateTo, setDateTo] = useState(defaults.to);

  useEffect(() => {
    if (!active) {
      setPhotos([]);
      setSelected(new Set());
      setCaption("");
      setStep("select");
      setExpandedGroups(new Set());
      return;
    }
    void loadPhotos();
  }, [active]);

  async function loadPhotos() {
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      if (dateFrom) qs.set("from", dateFrom);
      if (dateTo) qs.set("to", dateTo);
      const list = await apiGet<PhotoItem[]>(`/api/admin/photos?${qs}`);
      setPhotos(Array.isArray(list) ? list : []);
    } catch {
      setPhotos([]);
    } finally {
      setLoading(false);
    }
  }

  function togglePhoto(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAll() {
    setSelected(new Set(photos.map((p) => p.id)));
  }

  function deselectAll() {
    setSelected(new Set());
  }

  function toggleGroup(key: string) {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  // Group photos by date + property
  const grouped = useMemo(() => {
    const map = new Map<string, { date: string; property: string; address: string; photos: PhotoItem[] }>();
    for (const p of photos) {
      const date = p.occurrence.startAt ? bizDateKey(p.occurrence.startAt) : "Unknown date";
      const property = p.occurrence.property?.displayName ?? "Unknown property";
      const address = p.occurrence.property?.address ?? "";
      const key = `${date}|${property}`;
      if (!map.has(key)) map.set(key, { date, property, address, photos: [] });
      map.get(key)!.photos.push(p);
    }
    return [...map.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  }, [photos]);

  const selectedPhotos = photos.filter((p) => selected.has(p.id));

  // Generate default caption from selected photos
  function generateCaption() {
    const properties = new Set<string>();
    for (const p of selectedPhotos) {
      if (p.occurrence.property?.displayName) properties.add(p.occurrence.property.displayName);
    }
    const propList = [...properties].slice(0, 3);
    let text = "Check out our latest work";
    if (propList.length > 0) text += ` at ${propList.join(", ")}`;
    text += "! #lawncare #landscaping #seedlings";
    setCaption(text);
  }

  async function handleShare() {
    if (selectedPhotos.length === 0) return;
    setSharing(true);
    try {
      // Fetch photo blobs
      const files: File[] = [];
      for (const photo of selectedPhotos) {
        const res = await fetch(photo.url);
        const blob = await res.blob();
        const ext = photo.contentType?.includes("png") ? "png" : "jpg";
        const name = photo.fileName || `seedlings-${photo.id}.${ext}`;
        files.push(new File([blob], name, { type: photo.contentType || "image/jpeg" }));
      }

      // Check if Web Share API with files is supported
      if (navigator.canShare && navigator.canShare({ files })) {
        await navigator.share({
          text: caption || undefined,
          files,
        });
        publishInlineMessage({ type: "SUCCESS", text: "Photos shared successfully!" });
        onDone();
      } else {
        // Fallback: download files and copy caption
        await fallbackShare(files);
      }
    } catch (err: any) {
      // User cancelled share is not an error
      if (err?.name === "AbortError") return;
      publishInlineMessage({ type: "ERROR", text: "Failed to share photos. Try the download option instead." });
    } finally {
      setSharing(false);
    }
  }

  async function fallbackShare(files: File[]) {
    // Copy caption to clipboard
    if (caption) {
      try {
        await navigator.clipboard.writeText(caption);
        publishInlineMessage({ type: "INFO", text: `Caption copied to clipboard. Downloading ${files.length} photo${files.length === 1 ? "" : "s"}...` });
      } catch {
        publishInlineMessage({ type: "INFO", text: `Downloading ${files.length} photo${files.length === 1 ? "" : "s"}...` });
      }
    }
    // Download each file
    for (const file of files) {
      const url = URL.createObjectURL(file);
      const a = document.createElement("a");
      a.href = url;
      a.download = file.name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }
  }

  async function handleDownload() {
    if (selectedPhotos.length === 0) return;
    setSharing(true);
    try {
      const files: File[] = [];
      for (const photo of selectedPhotos) {
        const res = await fetch(photo.url);
        const blob = await res.blob();
        const ext = photo.contentType?.includes("png") ? "png" : "jpg";
        const name = photo.fileName || `seedlings-${photo.id}.${ext}`;
        files.push(new File([blob], name, { type: photo.contentType || "image/jpeg" }));
      }
      await fallbackShare(files);
    } catch {
      publishInlineMessage({ type: "ERROR", text: "Failed to download photos." });
    } finally {
      setSharing(false);
    }
  }

  if (!active) return null;

  return (
    <Dialog.Root open={active} onOpenChange={(e) => { if (!e.open) onDone(); }}>
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content mx="4" maxW="lg" w="full" rounded="2xl" p="0" shadow="lg">
            <Dialog.Header px="4" pt="4" pb="2">
              <HStack justify="space-between" w="full">
                <Dialog.Title fontSize="lg">
                  {step === "select" ? "Select Photos" : "Compose & Share"}
                </Dialog.Title>
                <Button size="sm" variant="ghost" onClick={onDone} px="1" minW="0">
                  <X size={18} />
                </Button>
              </HStack>
            </Dialog.Header>
            <Dialog.Body px="4" pb="4" style={{ maxHeight: "70vh", overflowY: "auto" }}>
              {step === "select" && (
                <VStack align="stretch" gap={3}>
                  {/* Date range */}
                  <HStack gap={2} align="center" wrap="wrap">
                    <DateInput value={dateFrom} onChange={(v) => setDateFrom(v)} />
                    <Text fontSize="sm">–</Text>
                    <DateInput value={dateTo} onChange={(v) => setDateTo(v)} />
                    <Button size="sm" variant="outline" onClick={() => void loadPhotos()} loading={loading}>
                      Load
                    </Button>
                  </HStack>

                  {/* Selection controls */}
                  <HStack gap={2} justify="space-between">
                    <HStack gap={2}>
                      <Button size="xs" variant="ghost" onClick={selectAll}>Select all</Button>
                      <Button size="xs" variant="ghost" onClick={deselectAll}>Clear</Button>
                    </HStack>
                    <Badge colorPalette={selected.size > 0 ? "green" : "gray"} variant="subtle">
                      {selected.size} selected
                    </Badge>
                  </HStack>

                  {/* Photo groups */}
                  {loading && photos.length === 0 && (
                    <Box py={8} textAlign="center">
                      <Text color="fg.muted" fontSize="sm">Loading photos...</Text>
                    </Box>
                  )}
                  {!loading && photos.length === 0 && (
                    <Box py={8} textAlign="center">
                      <Text color="fg.muted" fontSize="sm">No photos found in this date range.</Text>
                    </Box>
                  )}

                  {grouped.map(([key, group]) => {
                    const isExpanded = expandedGroups.has(key);
                    const groupSelectedCount = group.photos.filter((p) => selected.has(p.id)).length;
                    const allGroupSelected = groupSelectedCount === group.photos.length;

                    return (
                      <Box key={key} borderWidth="1px" borderRadius="lg" overflow="hidden">
                        {/* Group header */}
                        <HStack
                          px={3} py={2}
                          bg="gray.50"
                          cursor="pointer"
                          onClick={() => toggleGroup(key)}
                          justify="space-between"
                          _hover={{ bg: "gray.100" }}
                        >
                          <VStack align="start" gap={0}>
                            <HStack gap={2}>
                              <Text fontSize="sm" fontWeight="semibold">{group.property}</Text>
                              <Badge size="sm" variant="subtle" colorPalette="gray">
                                {fmtDate(group.date)}
                              </Badge>
                            </HStack>
                            {group.address && (
                              <Text fontSize="xs" color="fg.muted">{group.address}</Text>
                            )}
                          </VStack>
                          <HStack gap={2}>
                            <Badge size="sm" colorPalette={groupSelectedCount > 0 ? "green" : "gray"} variant="subtle">
                              {groupSelectedCount}/{group.photos.length}
                            </Badge>
                            <Button
                              size="xs"
                              variant="ghost"
                              px="1"
                              minW="0"
                              onClick={(e) => {
                                e.stopPropagation();
                                setSelected((prev) => {
                                  const next = new Set(prev);
                                  if (allGroupSelected) {
                                    for (const p of group.photos) next.delete(p.id);
                                  } else {
                                    for (const p of group.photos) next.add(p.id);
                                  }
                                  return next;
                                });
                              }}
                            >
                              {allGroupSelected ? <X size={14} /> : <Check size={14} />}
                            </Button>
                            {isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                          </HStack>
                        </HStack>

                        {/* Photo grid */}
                        {isExpanded && (
                          <Box
                            display="grid"
                            gridTemplateColumns="repeat(auto-fill, minmax(90px, 1fr))"
                            gap={1}
                            p={2}
                          >
                            {group.photos.map((photo) => {
                              const isSel = selected.has(photo.id);
                              return (
                                <Box
                                  key={photo.id}
                                  position="relative"
                                  cursor="pointer"
                                  onClick={() => togglePhoto(photo.id)}
                                  borderRadius="md"
                                  overflow="hidden"
                                  borderWidth="2px"
                                  borderColor={isSel ? "green.400" : "transparent"}
                                  transition="border-color 0.1s"
                                  _hover={{ borderColor: isSel ? "green.500" : "gray.300" }}
                                >
                                  <img
                                    src={photo.url}
                                    alt={photo.fileName || "Photo"}
                                    style={{
                                      width: "100%",
                                      aspectRatio: "1",
                                      objectFit: "cover",
                                      display: "block",
                                    }}
                                  />
                                  {isSel && (
                                    <Box
                                      position="absolute"
                                      top="4px"
                                      right="4px"
                                      bg="green.500"
                                      color="white"
                                      borderRadius="full"
                                      w="20px"
                                      h="20px"
                                      display="flex"
                                      alignItems="center"
                                      justifyContent="center"
                                    >
                                      <Check size={12} />
                                    </Box>
                                  )}
                                  <Text
                                    fontSize="9px"
                                    color="white"
                                    position="absolute"
                                    bottom="0"
                                    left="0"
                                    right="0"
                                    bg="blackAlpha.600"
                                    px="1"
                                    py="0.5"
                                    lineClamp={1}
                                  >
                                    {photo.uploadedBy?.displayName ?? ""}
                                  </Text>
                                </Box>
                              );
                            })}
                          </Box>
                        )}
                      </Box>
                    );
                  })}
                </VStack>
              )}

              {step === "compose" && (
                <VStack align="stretch" gap={3}>
                  {/* Selected photos preview */}
                  <Box>
                    <Text fontSize="sm" fontWeight="medium" mb={1}>
                      {selectedPhotos.length} photo{selectedPhotos.length !== 1 ? "s" : ""} selected
                    </Text>
                    <Box
                      display="flex"
                      gap={1}
                      overflowX="auto"
                      pb={2}
                    >
                      {selectedPhotos.map((photo) => (
                        <Box
                          key={photo.id}
                          position="relative"
                          flexShrink={0}
                          borderRadius="md"
                          overflow="hidden"
                        >
                          <img
                            src={photo.url}
                            alt={photo.fileName || "Photo"}
                            style={{
                              width: "70px",
                              height: "70px",
                              objectFit: "cover",
                              display: "block",
                            }}
                          />
                          <Box
                            position="absolute"
                            top="2px"
                            right="2px"
                            bg="blackAlpha.600"
                            color="white"
                            borderRadius="full"
                            w="16px"
                            h="16px"
                            display="flex"
                            alignItems="center"
                            justifyContent="center"
                            cursor="pointer"
                            onClick={() => togglePhoto(photo.id)}
                            _hover={{ bg: "red.500" }}
                          >
                            <X size={10} />
                          </Box>
                        </Box>
                      ))}
                    </Box>
                  </Box>

                  {/* Caption */}
                  <Box>
                    <HStack justify="space-between" mb={1}>
                      <Text fontSize="sm" fontWeight="medium">Caption</Text>
                      <Button size="xs" variant="ghost" onClick={generateCaption}>
                        Auto-generate
                      </Button>
                    </HStack>
                    <Textarea
                      value={caption}
                      onChange={(e) => setCaption(e.target.value)}
                      placeholder="Write a caption for your post..."
                      rows={3}
                      fontSize="sm"
                    />
                  </Box>

                  {/* Info box */}
                  <Box p={3} bg="blue.50" borderWidth="1px" borderColor="blue.200" rounded="md">
                    <Text fontSize="xs" color="blue.700">
                      Share will open your device's share sheet so you can post directly to Instagram, Facebook, or any other app.
                      On unsupported browsers, photos will be downloaded and the caption copied to your clipboard.
                    </Text>
                  </Box>
                </VStack>
              )}
            </Dialog.Body>
            <Dialog.Footer px="4" py="3" borderTopWidth="1px">
              {step === "select" ? (
                <HStack justify="space-between" w="full">
                  <Button size="sm" variant="ghost" onClick={onDone}>Cancel</Button>
                  <Button
                    size="sm"
                    variant="solid"
                    bg="black"
                    color="white"
                    disabled={selected.size === 0}
                    onClick={() => { setStep("compose"); generateCaption(); }}
                  >
                    Next ({selected.size})
                  </Button>
                </HStack>
              ) : (
                <HStack justify="space-between" w="full">
                  <Button size="sm" variant="ghost" onClick={() => setStep("select")}>Back</Button>
                  <HStack gap={2}>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={handleDownload}
                      loading={sharing}
                      disabled={selectedPhotos.length === 0}
                    >
                      <Download size={14} />
                      Download
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={async () => {
                        if (caption) {
                          try {
                            await navigator.clipboard.writeText(caption);
                            publishInlineMessage({ type: "SUCCESS", text: "Caption copied to clipboard." });
                          } catch {
                            publishInlineMessage({ type: "ERROR", text: "Failed to copy caption." });
                          }
                        }
                      }}
                      disabled={!caption}
                    >
                      <Copy size={14} />
                      Copy Caption
                    </Button>
                    <Button
                      size="sm"
                      variant="solid"
                      bg="black"
                      color="white"
                      onClick={handleShare}
                      loading={sharing}
                      disabled={selectedPhotos.length === 0}
                    >
                      <Share2 size={14} />
                      Share
                    </Button>
                  </HStack>
                </HStack>
              )}
            </Dialog.Footer>
            <Dialog.CloseTrigger />
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
