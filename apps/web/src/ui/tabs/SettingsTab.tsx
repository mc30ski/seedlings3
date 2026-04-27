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
import { DollarSign, Eye, EyeOff, Pencil, Plus, Trash2 } from "lucide-react";
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

/** Inline editor for JSON key-value map settings */
function JsonMapEditor({ value, onChange, onSave, onCancel, saving, originalValue }: {
  value: string;
  onChange: (v: string) => void;
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
  originalValue: string;
}) {
  let pairs: [string, string][] = [];
  try { pairs = Object.entries(JSON.parse(value)); } catch {}

  const [newKey, setNewKey] = useState("");
  const [newVal, setNewVal] = useState("");

  function updatePair(idx: number, key: string, val: string) {
    const updated = [...pairs];
    updated[idx] = [key, val];
    onChange(JSON.stringify(Object.fromEntries(updated)));
  }

  function removePair(idx: number) {
    const updated = pairs.filter((_, i) => i !== idx);
    onChange(JSON.stringify(Object.fromEntries(updated)));
  }

  function addPair() {
    if (!newKey.trim() || !newVal.trim()) return;
    const updated = [...pairs, [newKey.trim().toUpperCase(), newVal.trim().toUpperCase()] as [string, string]];
    onChange(JSON.stringify(Object.fromEntries(updated)));
    setNewKey("");
    setNewVal("");
  }

  return (
    <VStack align="stretch" gap={2} w="full">
      {pairs.map(([k, v], idx) => (
        <HStack key={idx} gap={2}>
          <Input size="sm" value={k} onChange={(e) => updatePair(idx, e.target.value.toUpperCase(), v)} flex="1" placeholder="Service tag" />
          <Text fontSize="sm" color="fg.muted">→</Text>
          <Input size="sm" value={v} onChange={(e) => updatePair(idx, k, e.target.value.toUpperCase())} flex="1" placeholder="Equipment kind" />
          <Button size="xs" variant="ghost" colorPalette="red" px="1" minW="0" onClick={() => removePair(idx)}>
            <Trash2 size={12} />
          </Button>
        </HStack>
      ))}
      <HStack gap={2} borderTopWidth="1px" borderColor="gray.200" pt={2}>
        <Input size="sm" value={newKey} onChange={(e) => setNewKey(e.target.value)} flex="1" placeholder="New tag (e.g. MOW)" />
        <Text fontSize="sm" color="fg.muted">→</Text>
        <Input size="sm" value={newVal} onChange={(e) => setNewVal(e.target.value)} flex="1" placeholder="Equipment kind (e.g. MOWER)" />
        <Button size="xs" variant="outline" onClick={addPair} disabled={!newKey.trim() || !newVal.trim()}>
          <Plus size={12} />
        </Button>
      </HStack>
      <HStack gap={2}>
        <Button size="sm" onClick={onSave} loading={saving} disabled={value === originalValue}>Save</Button>
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={saving}>Cancel</Button>
      </HStack>
    </VStack>
  );
}

/** Inline editor for JSON array-of-objects settings like [{key, label}] */
function JsonArrayEditor({ value, onChange, onSave, onCancel, saving, originalValue }: {
  value: string;
  onChange: (v: string) => void;
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
  originalValue: string;
}) {
  let items: { key: string; label: string; equipmentKind?: string }[] = [];
  try { items = JSON.parse(value); } catch {}

  // Detect if any item has equipmentKind — show the column if so
  const hasEquipmentKind = items.some((i) => i.equipmentKind);

  const [newKey, setNewKey] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [newEquipment, setNewEquipment] = useState("");

  function updateItem(idx: number, updates: Partial<{ key: string; label: string; equipmentKind: string }>) {
    const updated = [...items];
    const item = { ...updated[idx], ...updates };
    if (!item.equipmentKind) delete item.equipmentKind;
    updated[idx] = item;
    onChange(JSON.stringify(updated));
  }

  function removeItem(idx: number) {
    onChange(JSON.stringify(items.filter((_, i) => i !== idx)));
  }

  function addItem() {
    if (!newKey.trim() || !newLabel.trim()) return;
    const item: any = { key: newKey.trim().toUpperCase(), label: newLabel.trim() };
    if (newEquipment.trim()) item.equipmentKind = newEquipment.trim().toUpperCase();
    onChange(JSON.stringify([...items, item]));
    setNewKey("");
    setNewLabel("");
    setNewEquipment("");
  }

  return (
    <VStack align="stretch" gap={2} w="full">
      {/* Header */}
      <HStack gap={2} fontSize="2xs" color="fg.muted" fontWeight="medium">
        <Text flex="1">Key</Text>
        <Text flex="1">Label</Text>
        {hasEquipmentKind && <Text flex="1">Equipment Kind</Text>}
        <Box w="24px" />
      </HStack>
      {items.map((item, idx) => (
        <HStack key={idx} gap={2}>
          <Input size="sm" value={item.key} onChange={(e) => updateItem(idx, { key: e.target.value.toUpperCase() })} flex="1" placeholder="MOW" />
          <Input size="sm" value={item.label} onChange={(e) => updateItem(idx, { label: e.target.value })} flex="1" placeholder="Mow" />
          {hasEquipmentKind && (
            <Input size="sm" value={item.equipmentKind ?? ""} onChange={(e) => updateItem(idx, { equipmentKind: e.target.value.toUpperCase() })} flex="1" placeholder="(optional)" />
          )}
          <Button size="xs" variant="ghost" colorPalette="red" px="1" minW="0" onClick={() => removeItem(idx)}>
            <Trash2 size={12} />
          </Button>
        </HStack>
      ))}
      <HStack gap={2} borderTopWidth="1px" borderColor="gray.200" pt={2}>
        <Input size="sm" value={newKey} onChange={(e) => setNewKey(e.target.value)} flex="1" placeholder="New key" />
        <Input size="sm" value={newLabel} onChange={(e) => setNewLabel(e.target.value)} flex="1" placeholder="Label" />
        {hasEquipmentKind && (
          <Input size="sm" value={newEquipment} onChange={(e) => setNewEquipment(e.target.value)} flex="1" placeholder="Equipment (opt)" />
        )}
        <Button size="xs" variant="outline" onClick={addItem} disabled={!newKey.trim() || !newLabel.trim()}>
          <Plus size={12} />
        </Button>
      </HStack>
      <HStack gap={2}>
        <Button size="sm" onClick={onSave} loading={saving} disabled={value === originalValue}>Save</Button>
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={saving}>Cancel</Button>
      </HStack>
    </VStack>
  );
}

export default function SettingsTab({ me, purpose = "ADMIN" }: TabPropsType) {
  const { isAvail, isSuper: userIsSuper } = determineRoles(me, purpose);
  const isSuper = userIsSuper && purpose === "SUPER";

  // General settings
  const [settings, setSettings] = useState<Setting[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [revealedKeys, setRevealedKeys] = useState<Set<string>>(new Set());

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
      const SETTINGS_ORDER = [
        "CONTRACTOR_PLATFORM_FEE_PERCENT",
        "EMPLOYEE_BUSINESS_MARGIN_PERCENT",
        "HIGH_VALUE_JOB_THRESHOLD",
        "EQUIPMENT_KINDS",
        "SERVICE_TYPES",
        "WEATHER_API_KEY",
      ];
      const general = (Array.isArray(allSettings) ? allSettings : []).filter((s) => !s.key.startsWith("pricing_"));
      general.sort((a, b) => {
        const ai = SETTINGS_ORDER.indexOf(a.key);
        const bi = SETTINGS_ORDER.indexOf(b.key);
        return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
      });
      setSettings(general);

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
                      (() => {
                        // Detect JSON format and use appropriate editor
                        try {
                          const parsed = JSON.parse(s.value);
                          if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].key) {
                            return <JsonArrayEditor value={editValue} onChange={setEditValue} onSave={() => handleSave(s.key)} onCancel={() => setEditingKey(null)} saving={saving} originalValue={s.value} />;
                          }
                          if (typeof parsed === "object" && !Array.isArray(parsed)) {
                            return <JsonMapEditor value={editValue} onChange={setEditValue} onSave={() => handleSave(s.key)} onCancel={() => setEditingKey(null)} saving={saving} originalValue={s.value} />;
                          }
                        } catch {}
                        // Also handle empty array case
                        if (s.value === "[]") {
                          return <JsonArrayEditor value={editValue} onChange={setEditValue} onSave={() => handleSave(s.key)} onCancel={() => setEditingKey(null)} saving={saving} originalValue={s.value} />;
                        }
                        return (
                          <HStack gap={2} w="full">
                            <Input value={editValue} onChange={(e) => setEditValue(e.target.value)} size="sm" flex="1" autoFocus />
                            <Button size="sm" onClick={() => handleSave(s.key)} loading={saving} disabled={editValue === s.value}>Save</Button>
                            <Button size="sm" variant="ghost" onClick={() => setEditingKey(null)} disabled={saving}>Cancel</Button>
                          </HStack>
                        );
                      })()
                    ) : (
                      (() => {
                        try {
                          const parsed = JSON.parse(s.value);
                          // Array of {key, label, equipmentKind?} objects
                          if (Array.isArray(parsed)) {
                            if (parsed.length === 0) return <Text fontSize="xs" color="fg.muted" fontStyle="italic">No items configured</Text>;
                            if (parsed[0]?.key) {
                              return (
                                <Box display="flex" gap="4px" flexWrap="wrap">
                                  {parsed.map((item: any) => (
                                    <Badge key={item.key} size="sm" variant="solid" colorPalette="blue" px="2" borderRadius="full" fontSize="xs">
                                      {item.label}{item.equipmentKind ? ` → ${item.equipmentKind}` : ""}
                                    </Badge>
                                  ))}
                                </Box>
                              );
                            }
                          }
                          // Object map (key→value pairs)
                          if (typeof parsed === "object" && !Array.isArray(parsed)) {
                            const entries = Object.entries(parsed);
                            if (entries.length > 0) {
                              return (
                                <Box display="flex" gap="4px" flexWrap="wrap">
                                  {entries.map(([k, v]) => (
                                    <Badge key={k} size="sm" variant="outline" colorPalette="blue" px="2" borderRadius="full" fontSize="xs">
                                      {k} → {String(v)}
                                    </Badge>
                                  ))}
                                </Box>
                              );
                            }
                            return <Text fontSize="xs" color="fg.muted" fontStyle="italic">No mappings configured</Text>;
                          }
                        } catch {}
                        const isSensitive = /api.key|secret|token|password/i.test(s.key);
                        if (isSensitive && !revealedKeys.has(s.key)) {
                          return (
                            <HStack gap={1}>
                              <Text fontSize="md" fontWeight="medium">••••••••••••••••</Text>
                              {isSuper && (
                                <Button size="xs" variant="ghost" px="1" minW="0" onClick={() => setRevealedKeys((prev) => new Set([...prev, s.key]))} title="Show value">
                                  <Eye size={14} />
                                </Button>
                              )}
                            </HStack>
                          );
                        }
                        if (isSensitive) {
                          return (
                            <HStack gap={1}>
                              <Text fontSize="md" fontWeight="medium">{s.value}</Text>
                              <Button size="xs" variant="ghost" px="1" minW="0" onClick={() => setRevealedKeys((prev) => { const next = new Set(prev); next.delete(s.key); return next; })} title="Hide value">
                                <EyeOff size={14} />
                              </Button>
                            </HStack>
                          );
                        }
                        return <Text fontSize="md" fontWeight="medium">{s.value}</Text>;
                      })()
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
