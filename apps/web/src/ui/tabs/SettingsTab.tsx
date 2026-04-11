"use client";

import { useEffect, useState } from "react";
import {
  Badge,
  Box,
  Button,
  Card,
  Dialog,
  HStack,
  Input,
  Portal,
  Spinner,
  Text,
  VStack,
} from "@chakra-ui/react";
import { DollarSign, Pencil, Plus, Trash2 } from "lucide-react";
import { apiGet, apiPatch, apiPost, apiDelete } from "@/src/lib/api";
import { type TabPropsType } from "@/src/lib/types";
import { determineRoles, fmtDateTime } from "@/src/lib/lib";
import LoadingCenter from "@/src/ui/helpers/LoadingCenter";
import UnavailableNotice from "@/src/ui/notices/UnavailableNotice";
import ConfirmDialog from "@/src/ui/dialogs/ConfirmDialog";
import {
  publishInlineMessage,
  getErrorMessage,
} from "@/src/ui/components/InlineMessage";

type Setting = {
  id: string;
  key: string;
  value: string;
  description?: string | null;
  updatedAt: string;
  updatedBy?: { id: string; displayName?: string | null } | null;
};

type PricingValue = {
  label: string;
  description: string;
  unit: string;
  amount: number;
  sortOrder: number;
};

type PricingEntry = Setting & { parsedValue: PricingValue | null };

export default function SettingsTab({ me, purpose = "ADMIN" }: TabPropsType) {
  const { isAvail, isSuper } = determineRoles(me, purpose);

  // General settings
  const [settings, setSettings] = useState<Setting[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [saving, setSaving] = useState(false);

  // Pricing
  const [pricingEntries, setPricingEntries] = useState<PricingEntry[]>([]);
  const [pricingDialogOpen, setPricingDialogOpen] = useState(false);
  const [pricingEditKey, setPricingEditKey] = useState<string | null>(null);
  const [pricingLabel, setPricingLabel] = useState("");
  const [pricingDescription, setPricingDescription] = useState("");
  const [pricingUnit, setPricingUnit] = useState("");
  const [pricingAmount, setPricingAmount] = useState("");
  const [pricingSaving, setPricingSaving] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<{ key: string; label: string } | null>(null);

  async function load() {
    try {
      const [allSettings, pricing] = await Promise.all([
        apiGet<Setting[]>("/api/admin/settings"),
        apiGet<PricingEntry[]>("/api/admin/pricing"),
      ]);
      setSettings((Array.isArray(allSettings) ? allSettings : []).filter((s) => !s.key.startsWith("pricing_")));

      const sorted = (Array.isArray(pricing) ? pricing : []).sort((a, b) => {
        const sa = a.parsedValue?.sortOrder ?? 100;
        const sb = b.parsedValue?.sortOrder ?? 100;
        if (sa !== sb) return sa - sb;
        return (a.parsedValue?.label ?? "").localeCompare(b.parsedValue?.label ?? "");
      });
      setPricingEntries(sorted);
    } catch {
      setSettings([]);
      setPricingEntries([]);
    }
    setLoading(false);
  }

  useEffect(() => { void load(); }, []);

  // General settings save
  async function handleSave(key: string) {
    setSaving(true);
    try {
      await apiPatch(`/api/admin/settings/${key}`, { value: editValue });
      publishInlineMessage({ type: "SUCCESS", text: `Setting "${key}" updated.` });
      setEditingKey(null);
      void load();
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Update failed.", err) });
    } finally {
      setSaving(false);
    }
  }

  // Pricing CRUD
  function openPricingCreate() {
    setPricingEditKey(null);
    setPricingLabel("");
    setPricingDescription("");
    setPricingUnit("");
    setPricingAmount("");
    setPricingDialogOpen(true);
  }

  function openPricingEdit(entry: PricingEntry) {
    const v = entry.parsedValue;
    if (!v) return;
    setPricingEditKey(entry.key);
    setPricingLabel(v.label);
    setPricingDescription(v.description);
    setPricingUnit(v.unit);
    setPricingAmount(String(v.amount));
    setPricingDialogOpen(true);
  }

  async function handlePricingSave() {
    if (!pricingLabel.trim() || !pricingUnit.trim() || !pricingAmount.trim()) {
      publishInlineMessage({ type: "ERROR", text: "Label, unit, and amount are required." });
      return;
    }
    setPricingSaving(true);
    try {
      const payload = {
        label: pricingLabel.trim(),
        description: pricingDescription.trim(),
        unit: pricingUnit.trim(),
        amount: Number(pricingAmount),
      };
      if (pricingEditKey) {
        await apiPatch(`/api/admin/pricing/${pricingEditKey}`, payload);
        publishInlineMessage({ type: "SUCCESS", text: "Pricing updated." });
      } else {
        await apiPost("/api/admin/pricing", payload);
        publishInlineMessage({ type: "SUCCESS", text: "Pricing entry created." });
      }
      setPricingDialogOpen(false);
      await load();
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Save failed.", err) });
    }
    setPricingSaving(false);
  }

  async function handlePricingDelete(key: string) {
    try {
      await apiDelete(`/api/admin/pricing/${key}`);
      publishInlineMessage({ type: "SUCCESS", text: "Pricing entry deleted." });
      await load();
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Delete failed.", err) });
    }
  }

  if (!isAvail) return <UnavailableNotice />;
  if (loading) return <LoadingCenter />;

  return (
    <Box w="full" pb={8}>
      {/* ── Pricing Section ── */}
      <Box mb={6}>
        <HStack justify="space-between" mb={2} px={1}>
          <Text fontSize="md" fontWeight="semibold">Pricing Guide</Text>
          {isSuper && (
            <Button size="xs" colorPalette="blue" onClick={openPricingCreate}>
              <Plus size={14} /> Add Entry
            </Button>
          )}
        </HStack>
        <Box mb={2} p={3} bg="blue.50" borderWidth="1px" borderColor="blue.200" rounded="md">
          <Text fontSize="xs" color="blue.600">
            Reference pricing for common job types. {isSuper ? "You can add, edit, and remove entries." : "Contact a super admin to make changes."}
            {" "}This data is used by AI features to generate accurate estimates.
          </Text>
        </Box>

        {pricingEntries.length === 0 && (
          <Box textAlign="center" py={6}>
            <Text fontSize="sm" color="fg.muted">No pricing entries yet.{isSuper ? " Add your first entry above." : ""}</Text>
          </Box>
        )}

        <VStack align="stretch" gap={2}>
          {pricingEntries.map((entry) => {
            const v = entry.parsedValue;
            if (!v) return null;
            return (
              <Card.Root key={entry.key} variant="outline">
                <Card.Body py="3" px="4">
                  <HStack justify="space-between" align="start" gap={3}>
                    <VStack align="start" gap={1} flex="1" minW={0}>
                      <HStack gap={2} align="center" wrap="wrap">
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
                        Updated {new Date(entry.updatedAt).toLocaleDateString()}
                        {entry.updatedBy?.displayName && ` by ${entry.updatedBy.displayName}`}
                      </Text>
                    </VStack>
                    {isSuper && (
                      <HStack gap={1} flexShrink={0}>
                        <Button size="xs" variant="ghost" onClick={() => openPricingEdit(entry)} title="Edit">
                          <Pencil size={14} />
                        </Button>
                        <Button size="xs" variant="ghost" colorPalette="red" onClick={() => setDeleteConfirm({ key: entry.key, label: v.label })} title="Delete">
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
      </Box>

      {/* ── General Settings Section ── */}
      {settings.length > 0 && (
        <Box>
          <Text fontSize="md" fontWeight="semibold" mb={2} px={1}>General Settings</Text>
          <VStack align="stretch" gap={3}>
            {settings.map((s) => (
              <Card.Root key={s.id} variant="outline">
                <Card.Body py="3" px="4">
                  <VStack align="start" gap={1}>
                    <HStack justify="space-between" w="full" align="start">
                      <VStack align="start" gap={0}>
                        <Text fontSize="sm" fontWeight="semibold">
                          {s.key
                            .split("_")
                            .map((w) => w.charAt(0) + w.slice(1).toLowerCase())
                            .join(" ")}
                        </Text>
                        {s.description && (
                          <Text fontSize="xs" color="fg.muted">{s.description}</Text>
                        )}
                      </VStack>
                      {isSuper && editingKey !== s.key && (
                        <Button size="xs" variant="outline" onClick={() => { setEditingKey(s.key); setEditValue(s.value); }}>
                          Edit
                        </Button>
                      )}
                    </HStack>

                    {editingKey === s.key ? (
                      <HStack gap={2} w="full">
                        <Input value={editValue} onChange={(e) => setEditValue(e.target.value)} size="sm" flex="1" autoFocus />
                        <Button size="sm" onClick={() => handleSave(s.key)} loading={saving} disabled={editValue === s.value}>Save</Button>
                        <Button size="sm" variant="ghost" onClick={() => setEditingKey(null)} disabled={saving}>Cancel</Button>
                      </HStack>
                    ) : (
                      <Text fontSize="md" fontWeight="medium">{s.value}</Text>
                    )}

                    {s.updatedBy && (
                      <Text fontSize="xs" color="fg.muted">
                        Last updated by {s.updatedBy.displayName ?? "unknown"} on {fmtDateTime(s.updatedAt)}
                      </Text>
                    )}
                  </VStack>
                </Card.Body>
              </Card.Root>
            ))}
          </VStack>
        </Box>
      )}

      {/* Pricing Create/Edit Dialog */}
      <Dialog.Root open={pricingDialogOpen} onOpenChange={(e) => { if (!e.open) setPricingDialogOpen(false); }}>
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <Dialog.Content maxW="md">
              <Dialog.Header>
                <Dialog.Title>{pricingEditKey ? "Edit Pricing Entry" : "Add Pricing Entry"}</Dialog.Title>
              </Dialog.Header>
              <Dialog.Body>
                <VStack align="stretch" gap={3}>
                  <Box>
                    <Text fontSize="sm" fontWeight="medium" mb={1}>Label *</Text>
                    <input
                      type="text"
                      placeholder="e.g., General Labor"
                      value={pricingLabel}
                      onChange={(e) => setPricingLabel(e.target.value)}
                      disabled={!!pricingEditKey}
                      style={{ width: "100%", padding: "6px 10px", fontSize: "14px", border: "1px solid #ccc", borderRadius: "6px", opacity: pricingEditKey ? 0.6 : 1 }}
                    />
                    {pricingEditKey && <Text fontSize="xs" color="fg.muted" mt={0.5}>Label cannot be changed after creation</Text>}
                  </Box>
                  <Box>
                    <Text fontSize="sm" fontWeight="medium" mb={1}>Description</Text>
                    <textarea
                      placeholder="e.g., Hourly rate for general labor tasks like cleanup, hauling, debris removal"
                      value={pricingDescription}
                      onChange={(e) => setPricingDescription(e.target.value)}
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
                        value={pricingAmount}
                        onChange={(e) => setPricingAmount(e.target.value)}
                        style={{ width: "100%", padding: "6px 10px", fontSize: "14px", border: "1px solid #ccc", borderRadius: "6px" }}
                      />
                    </Box>
                    <Box flex="1">
                      <Text fontSize="sm" fontWeight="medium" mb={1}>Unit *</Text>
                      <input
                        type="text"
                        placeholder="e.g., per hour per person"
                        value={pricingUnit}
                        onChange={(e) => setPricingUnit(e.target.value)}
                        style={{ width: "100%", padding: "6px 10px", fontSize: "14px", border: "1px solid #ccc", borderRadius: "6px" }}
                      />
                    </Box>
                  </HStack>
                </VStack>
              </Dialog.Body>
              <Dialog.Footer>
                <Button variant="ghost" onClick={() => setPricingDialogOpen(false)}>Cancel</Button>
                <Button
                  colorPalette="blue"
                  disabled={!pricingLabel.trim() || !pricingUnit.trim() || !pricingAmount.trim() || pricingSaving}
                  onClick={() => void handlePricingSave()}
                >
                  {pricingSaving ? <Spinner size="sm" /> : pricingEditKey ? "Save Changes" : "Create Entry"}
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
          if (deleteConfirm) void handlePricingDelete(deleteConfirm.key);
          setDeleteConfirm(null);
        }}
        onCancel={() => setDeleteConfirm(null)}
      />
    </Box>
  );
}
