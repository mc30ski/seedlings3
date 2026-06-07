"use client";

import { useEffect, useState } from "react";
import {
  Box,
  Button,
  Checkbox,
  Dialog,
  HStack,
  Input,
  Portal,
  Text,
  Textarea,
  VStack,
} from "@chakra-ui/react";
import { Badge } from "@chakra-ui/react";
import { apiGet, apiPatch, apiPost } from "@/src/lib/api";
import {
  publishInlineMessage,
  getErrorMessage,
} from "@/src/ui/components/InlineMessage";
import RRuleEditor from "@/src/ui/components/RRuleEditor";
import {
  DEFAULT_TIMELINE_CATEGORIES,
  parseTimelineCategoriesConfig,
  type TimelineCategoryConfig,
} from "@/src/ui/components/TimelineCategoryPicker";

type TimelineEvent = {
  id: string;
  title: string;
  description: string | null;
  category: string | null;
  rrule: string | null;
  anchorDate: string;
  adminHidden: boolean;
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Null = create mode; otherwise edit mode for this event. */
  event: TimelineEvent | null;
  onSaved: () => void;
};

function isoToDateInput(iso: string | null | undefined): string {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  } catch {
    return "";
  }
}

export default function TimelineEventDialog({ open, onOpenChange, event, onSaved }: Props) {
  const isEdit = !!event;
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState<string>("");
  const [anchorDate, setAnchorDate] = useState("");
  const [rrule, setRRule] = useState("");
  const [adminHidden, setAdminHidden] = useState(false);
  const [busy, setBusy] = useState(false);

  // Categories come from the TIMELINE_CATEGORIES setting (configurable). Falls
  // back to the hardcoded defaults if the setting isn't present.
  const [categories, setCategories] = useState<TimelineCategoryConfig[]>(DEFAULT_TIMELINE_CATEGORIES);
  useEffect(() => {
    if (!open) return;
    (async () => {
      try {
        const settings = await apiGet<{ key: string; value: string }[]>("/api/admin/settings");
        const tc = (Array.isArray(settings) ? settings : []).find((s) => s.key === "TIMELINE_CATEGORIES");
        const parsed = parseTimelineCategoriesConfig(tc?.value);
        if (parsed) setCategories(parsed);
      } catch {}
    })();
  }, [open]);

  useEffect(() => {
    if (open) {
      setTitle(event?.title ?? "");
      setDescription(event?.description ?? "");
      setCategory(event?.category ?? "");
      setAnchorDate(isoToDateInput(event?.anchorDate));
      setRRule(event?.rrule ?? "");
      setAdminHidden(event?.adminHidden ?? false);
    }
  }, [open, event]);

  async function handleSave() {
    if (!title.trim() || !anchorDate) return;
    setBusy(true);
    try {
      const payload = {
        title: title.trim(),
        description: description.trim() || null,
        category: category.trim() || null,
        // Anchor at midday UTC so the date the user typed doesn't drift
        // when crossing timezones.
        anchorDate: new Date(anchorDate + "T12:00:00Z").toISOString(),
        rrule: rrule.trim() || null,
        adminHidden,
      };
      if (isEdit && event) {
        await apiPatch(`/api/super/timeline/${event.id}`, payload);
        publishInlineMessage({ type: "SUCCESS", text: "Activity updated." });
      } else {
        await apiPost("/api/super/timeline", payload);
        publishInlineMessage({ type: "SUCCESS", text: "Activity created." });
      }
      // Tell every listening surface that the timeline changed — the
      // JobsTab mixes Timeline activities into its admin feed via
      // /api/admin/timeline/upcoming and needs to refetch, the title-bar
      // alert count needs to refresh, etc. Without this dispatch, the
      // new activity is invisible everywhere except this dialog's parent
      // until a hard reload.
      window.dispatchEvent(new CustomEvent("seedlings3:timeline-changed"));
      onSaved();
      onOpenChange(false);
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Save failed.", err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={(e) => { if (!e.open) onOpenChange(false); }}>
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content mx="4" maxW="md" w="full" rounded="2xl" p="4" shadow="lg">
            <Dialog.CloseTrigger />
            <Dialog.Header>
              <Dialog.Title>{isEdit ? "Edit Activity" : "Add Activity"}</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <VStack align="stretch" gap={3}>
                <Box>
                  <Text fontSize="xs" fontWeight="medium" mb={1}>Title *</Text>
                  <Input size="sm" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g., Q3 estimated taxes" />
                </Box>
                <Box>
                  <Text fontSize="xs" fontWeight="medium" mb={1}>Description</Text>
                  <Textarea size="sm" value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
                </Box>
                <Box>
                  <Text fontSize="xs" fontWeight="medium" mb={1}>Category</Text>
                  <Box display="flex" gap="4px" flexWrap="wrap">
                    {categories.map((c) => {
                      const active = category === c.key;
                      return (
                        <Badge
                          key={c.key}
                          size="sm"
                          colorPalette={active ? "teal" : "gray"}
                          variant={active ? "solid" : "outline"}
                          cursor="pointer"
                          px="2"
                          borderRadius="full"
                          onClick={() => setCategory(active ? "" : c.key)}
                        >
                          {c.label}
                        </Badge>
                      );
                    })}
                  </Box>
                </Box>
                <Box>
                  <Text fontSize="xs" fontWeight="medium" mb={1}>Anchor date *</Text>
                  <Input type="date" size="sm" value={anchorDate} onChange={(e) => setAnchorDate(e.target.value)} />
                  <Text fontSize="xs" color="fg.muted" mt={1}>The reference date — for recurring events the rule extends from here.</Text>
                </Box>
                <Box borderWidth="1px" borderColor="gray.200" rounded="md" p={2}>
                  <RRuleEditor value={rrule} onChange={setRRule} anchorDate={anchorDate} />
                </Box>
                <Checkbox.Root
                  checked={adminHidden}
                  onCheckedChange={(e) => setAdminHidden(!!e.checked)}
                >
                  <Checkbox.HiddenInput />
                  <Checkbox.Control />
                  <Checkbox.Label>Hide from Admins (Super-only)</Checkbox.Label>
                </Checkbox.Root>
              </VStack>
            </Dialog.Body>
            <Dialog.Footer>
              <HStack justify="flex-end" w="full">
                <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
                <Button colorPalette="teal" loading={busy} disabled={!title.trim() || !anchorDate || busy} onClick={handleSave}>
                  {isEdit ? "Save" : "Create"}
                </Button>
              </HStack>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
