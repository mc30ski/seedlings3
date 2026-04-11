"use client";

import { useEffect, useState } from "react";
import {
  Badge,
  Box,
  Button,
  Card,
  Dialog,
  HStack,
  Portal,
  Spinner,
  Text,
  VStack,
} from "@chakra-ui/react";
import { DollarSign, Pencil, Plus, Trash2 } from "lucide-react";
import { apiGet, apiPost, apiPatch, apiDelete } from "@/src/lib/api";
import {
  publishInlineMessage,
  getErrorMessage,
} from "@/src/ui/components/InlineMessage";
import ConfirmDialog from "@/src/ui/dialogs/ConfirmDialog";

type PricingEntry = {
  id: string;
  key: string;
  value: string;
  updatedAt: string;
  updatedBy?: { id: string; displayName: string } | null;
  parsedValue: {
    label: string;
    description: string;
    unit: string;
    amount: number;
    sortOrder: number;
  } | null;
};

type Props = {
  isSuper?: boolean;
};

export default function PricingTab({ isSuper }: Props) {
  const [entries, setEntries] = useState<PricingEntry[]>([]);
  const [loading, setLoading] = useState(true);

  // Dialog state
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editKey, setEditKey] = useState<string | null>(null);
  const [formLabel, setFormLabel] = useState("");
  const [formDescription, setFormDescription] = useState("");
  const [formUnit, setFormUnit] = useState("");
  const [formAmount, setFormAmount] = useState("");
  const [saving, setSaving] = useState(false);

  // Delete confirm
  const [deleteConfirm, setDeleteConfirm] = useState<{ key: string; label: string } | null>(null);

  async function load() {
    try {
      const list = await apiGet<PricingEntry[]>("/api/admin/pricing");
      const sorted = (Array.isArray(list) ? list : []).sort((a, b) => {
        const sa = a.parsedValue?.sortOrder ?? 100;
        const sb = b.parsedValue?.sortOrder ?? 100;
        if (sa !== sb) return sa - sb;
        return (a.parsedValue?.label ?? "").localeCompare(b.parsedValue?.label ?? "");
      });
      setEntries(sorted);
    } catch {
      setEntries([]);
    }
    setLoading(false);
  }

  useEffect(() => { void load(); }, []);

  function openCreate() {
    setEditKey(null);
    setFormLabel("");
    setFormDescription("");
    setFormUnit("");
    setFormAmount("");
    setDialogOpen(true);
  }

  function openEdit(entry: PricingEntry) {
    const v = entry.parsedValue;
    if (!v) return;
    setEditKey(entry.key);
    setFormLabel(v.label);
    setFormDescription(v.description);
    setFormUnit(v.unit);
    setFormAmount(String(v.amount));
    setDialogOpen(true);
  }

  async function handleSave() {
    if (!formLabel.trim() || !formUnit.trim() || !formAmount.trim()) {
      publishInlineMessage({ type: "ERROR", text: "Label, unit, and amount are required." });
      return;
    }
    setSaving(true);
    try {
      const payload = {
        label: formLabel.trim(),
        description: formDescription.trim(),
        unit: formUnit.trim(),
        amount: Number(formAmount),
      };
      if (editKey) {
        await apiPatch(`/api/admin/pricing/${editKey}`, payload);
        publishInlineMessage({ type: "SUCCESS", text: "Pricing updated." });
      } else {
        await apiPost("/api/admin/pricing", payload);
        publishInlineMessage({ type: "SUCCESS", text: "Pricing entry created." });
      }
      setDialogOpen(false);
      await load();
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Save failed.", err) });
    }
    setSaving(false);
  }

  async function handleDelete(key: string) {
    try {
      await apiDelete(`/api/admin/pricing/${key}`);
      publishInlineMessage({ type: "SUCCESS", text: "Pricing entry deleted." });
      await load();
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Delete failed.", err) });
    }
  }

  if (loading) {
    return <Box py={10} textAlign="center"><Spinner size="lg" /></Box>;
  }

  return (
    <Box w="full" pb={8}>
      <Box mb={3} p={3} bg="blue.50" borderWidth="1px" borderColor="blue.300" rounded="md">
        <Text fontSize="sm" fontWeight="medium" color="blue.700">Pricing Guide</Text>
        <Text fontSize="xs" color="blue.600">
          Reference pricing for common job types. {isSuper ? "You can add, edit, and remove entries." : "Contact a super admin to make changes."}
          {" "}This data is used by AI features to generate accurate estimates.
        </Text>
      </Box>

      {isSuper && (
        <Box mb={3}>
          <Button size="sm" colorPalette="blue" onClick={openCreate}>
            <Plus size={14} /> Add Pricing Entry
          </Button>
        </Box>
      )}

      {entries.length === 0 && (
        <Box textAlign="center" py={10}>
          <Text fontSize="lg" fontWeight="semibold" color="fg.muted">No pricing entries yet</Text>
          {isSuper && <Text fontSize="sm" color="fg.muted" mt={1}>Add your first entry to get started.</Text>}
        </Box>
      )}

      <VStack align="stretch" gap={2}>
        {entries.map((entry) => {
          const v = entry.parsedValue;
          if (!v) return null;
          return (
            <Card.Root key={entry.key} variant="outline">
              <Card.Body py="3" px="4">
                <HStack justify="space-between" align="start" gap={3}>
                  <VStack align="start" gap={1} flex="1" minW={0}>
                    <HStack gap={2} align="center">
                      <Text fontSize="sm" fontWeight="semibold">{v.label}</Text>
                      <Badge colorPalette="green" variant="solid" fontSize="sm" px="2" borderRadius="full">
                        <DollarSign size={12} />{v.amount.toFixed(2)}
                      </Badge>
                      <Badge colorPalette="gray" variant="subtle" fontSize="xs" px="2" borderRadius="full">
                        {v.unit}
                      </Badge>
                    </HStack>
                    {v.description && (
                      <Text fontSize="xs" color="fg.muted">{v.description}</Text>
                    )}
                    <Text fontSize="xs" color="fg.muted">
                      Last updated: {new Date(entry.updatedAt).toLocaleDateString()}
                      {entry.updatedBy?.displayName && ` by ${entry.updatedBy.displayName}`}
                    </Text>
                  </VStack>
                  {isSuper && (
                    <HStack gap={1} flexShrink={0}>
                      <Button size="xs" variant="ghost" onClick={() => openEdit(entry)} title="Edit">
                        <Pencil size={14} />
                      </Button>
                      <Button
                        size="xs"
                        variant="ghost"
                        colorPalette="red"
                        onClick={() => setDeleteConfirm({ key: entry.key, label: v.label })}
                        title="Delete"
                      >
                        <Trash2 size={14} />
                      </Button>
                    </HStack>
                  )}
                </HStack>
              </Card.Body>
            </Card.Root>
          );
        })}
      </VStack>

      {/* Create/Edit Dialog */}
      <Dialog.Root open={dialogOpen} onOpenChange={(e) => { if (!e.open) setDialogOpen(false); }}>
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <Dialog.Content maxW="md">
              <Dialog.Header>
                <Dialog.Title>{editKey ? "Edit Pricing Entry" : "Add Pricing Entry"}</Dialog.Title>
              </Dialog.Header>
              <Dialog.Body>
                <VStack align="stretch" gap={3}>
                  <Box>
                    <Text fontSize="sm" fontWeight="medium" mb={1}>Label *</Text>
                    <input
                      type="text"
                      placeholder="e.g., General Labor"
                      value={formLabel}
                      onChange={(e) => setFormLabel(e.target.value)}
                      disabled={!!editKey}
                      style={{ width: "100%", padding: "6px 10px", fontSize: "14px", border: "1px solid #ccc", borderRadius: "6px", opacity: editKey ? 0.6 : 1 }}
                    />
                    {editKey && <Text fontSize="xs" color="fg.muted" mt={0.5}>Label cannot be changed after creation</Text>}
                  </Box>
                  <Box>
                    <Text fontSize="sm" fontWeight="medium" mb={1}>Description</Text>
                    <textarea
                      placeholder="e.g., Hourly rate for general labor tasks like cleanup, hauling, debris removal"
                      value={formDescription}
                      onChange={(e) => setFormDescription(e.target.value)}
                      rows={3}
                      style={{ width: "100%", padding: "6px 10px", fontSize: "14px", border: "1px solid #ccc", borderRadius: "6px", resize: "vertical" }}
                    />
                  </Box>
                  <HStack gap={3}>
                    <Box flex="1">
                      <Text fontSize="sm" fontWeight="medium" mb={1}>Amount ($) *</Text>
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        placeholder="60.00"
                        value={formAmount}
                        onChange={(e) => setFormAmount(e.target.value)}
                        style={{ width: "100%", padding: "6px 10px", fontSize: "14px", border: "1px solid #ccc", borderRadius: "6px" }}
                      />
                    </Box>
                    <Box flex="1">
                      <Text fontSize="sm" fontWeight="medium" mb={1}>Unit *</Text>
                      <input
                        type="text"
                        placeholder="e.g., per hour per person"
                        value={formUnit}
                        onChange={(e) => setFormUnit(e.target.value)}
                        style={{ width: "100%", padding: "6px 10px", fontSize: "14px", border: "1px solid #ccc", borderRadius: "6px" }}
                      />
                    </Box>
                  </HStack>
                </VStack>
              </Dialog.Body>
              <Dialog.Footer>
                <Button variant="ghost" onClick={() => setDialogOpen(false)}>Cancel</Button>
                <Button
                  colorPalette="blue"
                  disabled={!formLabel.trim() || !formUnit.trim() || !formAmount.trim() || saving}
                  onClick={() => void handleSave()}
                >
                  {saving ? <Spinner size="sm" /> : editKey ? "Save Changes" : "Create Entry"}
                </Button>
              </Dialog.Footer>
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>

      {/* Delete Confirm */}
      <ConfirmDialog
        open={!!deleteConfirm}
        title="Delete Pricing Entry?"
        message={`Are you sure you want to delete "${deleteConfirm?.label}"? This cannot be undone.`}
        confirmLabel="Delete"
        confirmColorPalette="red"
        onConfirm={() => {
          if (deleteConfirm) void handleDelete(deleteConfirm.key);
          setDeleteConfirm(null);
        }}
        onCancel={() => setDeleteConfirm(null)}
      />
    </Box>
  );
}
