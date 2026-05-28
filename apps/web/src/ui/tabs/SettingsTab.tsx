"use client";

import { useEffect, useMemo, useState } from "react";
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
import { ChevronDown, ChevronRight, DollarSign, Eye, EyeOff, Pencil, Plus, Trash2 } from "lucide-react";
import { apiGet, apiPatch, apiPost, apiDelete } from "@/src/lib/api";
import { type TabPropsType } from "@/src/lib/types";
import { determineRoles, fmtDateTime } from "@/src/lib/lib";
import { usePersistedState } from "@/src/lib/usePersistedState";
import {
  SETTING_SECTIONS,
  OTHER_SECTION,
  SETTING_SECTION_ORDER,
  resolveSettingSection,
} from "@/src/lib/settingSections";
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
  /** Presentational grouping key — resolved to a section via settingSections. */
  section?: string | null;
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

/** Numeric setting registry. Keys listed here get a number input in the
 *  editor with min/max/step bounds and matching client-side validation.
 *  `kind: "integer"` rejects decimals; `kind: "float"` accepts any finite
 *  number inside [min, max]. Add a new entry when introducing a numeric
 *  setting so admins can't save it as free text. */
type NumericSettingConfig = {
  kind: "integer" | "float";
  min: number;
  max?: number;
  step?: number;
  /** Error message shown next to the input + in the toast on save. */
  hint: string;
};

const NUMERIC_SETTINGS: Record<string, NumericSettingConfig> = {
  MAX_PHOTOS_PER_JOB: {
    kind: "integer",
    min: 1,
    step: 1,
    hint: "Must be a positive whole number (1 or greater).",
  },
  PHOTO_MAX_EDGE_PX: {
    kind: "integer",
    min: 100,
    max: 8000,
    step: 1,
    hint: "Must be a whole number between 100 and 8000 pixels.",
  },
  PHOTO_JPEG_QUALITY: {
    kind: "float",
    min: 0.1,
    max: 1.0,
    step: 0.05,
    hint: "Must be a number between 0.1 and 1.0 (e.g., 0.8 for the typical balance, 0.6 for smaller files).",
  },
};

/** Setting keys whose value is a boolean toggle (stored as "true"/"false").
 *  Rendered as a two-state Off/On toggle in the editor, like the
 *  payment-comms-mode picker. Add a key here when introducing a yes/no
 *  setting so admins can't save it as free text. */
const BOOLEAN_SETTINGS = new Set([
  "NOTIFY_PAYMENT_APPROVAL_VIA_SMS_EMAIL",
]);

function validateNumericSetting(key: string, value: string): { ok: boolean; error?: string } {
  const cfg = NUMERIC_SETTINGS[key];
  if (!cfg) return { ok: true };
  const trimmed = value.trim();
  if (trimmed === "") return { ok: false, error: cfg.hint };
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return { ok: false, error: cfg.hint };
  if (cfg.kind === "integer" && !Number.isInteger(n)) return { ok: false, error: cfg.hint };
  if (n < cfg.min) return { ok: false, error: cfg.hint };
  if (cfg.max != null && n > cfg.max) return { ok: false, error: cfg.hint };
  return { ok: true };
}

/** Convert a SNAKE_CASE setting key into a human-readable Title Case label.
 *  Used for both the card title and any toast that references a setting. */
function prettySettingName(key: string): string {
  return key
    .split("_")
    .map((w) => w.charAt(0) + w.slice(1).toLowerCase())
    .join(" ");
}

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

/** Dedicated editor for the PAYMENT_METHODS taxonomy. Surfaces every field
 *  the spec calls out (key, label, fees, context flags, active) as direct
 *  inputs and tucks the long-string fields (deepLinkTemplate, instructions)
 *  into a per-row expanded panel. The generic JsonArrayEditor below is too
 *  narrow for this shape — it only knows about {key, label}. */
type PaymentMethodRow = {
  key: string;
  label: string;
  feePercent: number;
  feeFixed: number;
  supportsClientRequest: boolean;
  supportsOnSite: boolean;
  deepLinkTemplate: string | null;
  instructions: string | null;
  active: boolean;
  preferred: boolean;
};

function PaymentMethodsEditor({ value, onChange, onSave, onCancel, saving, originalValue }: {
  value: string;
  onChange: (v: string) => void;
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
  originalValue: string;
}) {
  let items: PaymentMethodRow[] = [];
  let parseError: string | null = null;
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) throw new Error("must be an array");
    items = parsed.map((r: any) => ({
      key: String(r.key ?? ""),
      label: String(r.label ?? ""),
      feePercent: Number(r.feePercent ?? 0) || 0,
      feeFixed: Number(r.feeFixed ?? 0) || 0,
      supportsClientRequest: !!r.supportsClientRequest,
      supportsOnSite: !!r.supportsOnSite,
      deepLinkTemplate: r.deepLinkTemplate == null ? null : String(r.deepLinkTemplate),
      instructions: r.instructions == null ? null : String(r.instructions),
      active: r.active !== false,
      preferred: r.preferred === true,
    }));
  } catch (e: any) {
    parseError = e?.message ?? "invalid JSON";
  }

  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);

  function update(idx: number, patch: Partial<PaymentMethodRow>) {
    const updated = items.map((row, i) => (i === idx ? { ...row, ...patch } : row));
    onChange(JSON.stringify(updated));
  }
  function remove(idx: number) {
    onChange(JSON.stringify(items.filter((_, i) => i !== idx)));
    if (expandedIdx === idx) setExpandedIdx(null);
  }
  function add() {
    const next: PaymentMethodRow = {
      key: "",
      label: "",
      feePercent: 0,
      feeFixed: 0,
      supportsClientRequest: false,
      supportsOnSite: true,
      deepLinkTemplate: null,
      instructions: null,
      active: true,
      preferred: false,
    };
    onChange(JSON.stringify([...items, next]));
    setExpandedIdx(items.length);
  }

  if (parseError) {
    return (
      <VStack align="stretch" gap={2} w="full">
        <Text fontSize="xs" color="red.600">PAYMENT_METHODS JSON is malformed: {parseError}</Text>
        <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
      </VStack>
    );
  }

  return (
    <VStack align="stretch" gap={2} w="full">
      <Text fontSize="2xs" color="fg.muted">
        Placeholders: <Text as="span" fontFamily="mono">{"{SETTING_KEY}"}</Text> looks up a Setting value (must match an existing key — e.g. VENMO_BUSINESS_HANDLE).{" "}
        <Text as="span" fontFamily="mono">{"{{amount}}"}</Text> and{" "}
        <Text as="span" fontFamily="mono">{"{{note}}"}</Text> are filled in at payment time.
      </Text>
      {/* Compact column headers. The expanded panel below each row reveals
          the long-string fields (deepLinkTemplate, instructions). */}
      <HStack gap={2} fontSize="2xs" color="fg.muted" fontWeight="medium" px={1}>
        <Text w="80px">Key</Text>
        <Text w="120px">Label</Text>
        <Text w="70px" textAlign="right">Fee %</Text>
        <Text w="70px" textAlign="right">Fee $</Text>
        <Text w="60px" textAlign="center">Client</Text>
        <Text w="60px" textAlign="center">On-site</Text>
        <Text w="50px" textAlign="center">Active</Text>
        <Text w="60px" textAlign="center">Preferred</Text>
        <Box flex="1" />
        <Box w="60px" />
      </HStack>
      {items.map((row, idx) => (
        <Box key={idx} borderWidth="1px" borderColor="gray.200" borderRadius="md" p={2}>
          <HStack gap={2}>
            <Input size="sm" w="80px" value={row.key} onChange={(e) => update(idx, { key: e.target.value.toUpperCase() })} placeholder="VENMO" />
            <Input size="sm" w="120px" value={row.label} onChange={(e) => update(idx, { label: e.target.value })} placeholder="Venmo" />
            <Input
              size="sm"
              w="70px"
              type="number"
              step="0.01"
              min={0}
              max={100}
              value={String(row.feePercent)}
              onChange={(e) => update(idx, { feePercent: Number(e.target.value) || 0 })}
              textAlign="right"
            />
            <Input
              size="sm"
              w="70px"
              type="number"
              step="0.01"
              min={0}
              value={String(row.feeFixed)}
              onChange={(e) => update(idx, { feeFixed: Number(e.target.value) || 0 })}
              textAlign="right"
            />
            <Box w="60px" textAlign="center">
              <input type="checkbox" checked={row.supportsClientRequest} onChange={(e) => update(idx, { supportsClientRequest: e.target.checked })} />
            </Box>
            <Box w="60px" textAlign="center">
              <input type="checkbox" checked={row.supportsOnSite} onChange={(e) => update(idx, { supportsOnSite: e.target.checked })} />
            </Box>
            <Box w="50px" textAlign="center">
              <input type="checkbox" checked={row.active} onChange={(e) => update(idx, { active: e.target.checked })} />
            </Box>
            <Box w="60px" textAlign="center">
              <input type="checkbox" checked={row.preferred} onChange={(e) => update(idx, { preferred: e.target.checked })} />
            </Box>
            <Box flex="1" />
            <Button size="xs" variant="outline" onClick={() => setExpandedIdx(expandedIdx === idx ? null : idx)}>
              {expandedIdx === idx ? "Hide" : "Edit text"}
            </Button>
            <Button size="xs" variant="ghost" colorPalette="red" onClick={() => remove(idx)}>
              <Trash2 size={12} />
            </Button>
          </HStack>
          {expandedIdx === idx && (
            <VStack align="stretch" gap={2} mt={2} pl={1}>
              <Box>
                <Text fontSize="2xs" color="fg.muted" mb={1}>
                  Instructions — shown to the client on the payment page. Supports{" "}
                  <Text as="span" fontFamily="mono">{"{SETTING_KEY}"}</Text> and{" "}
                  <Text as="span" fontFamily="mono">{"{{amount}}"}</Text>/<Text as="span" fontFamily="mono">{"{{note}}"}</Text>.
                </Text>
                <Input
                  size="sm"
                  value={row.instructions ?? ""}
                  onChange={(e) => update(idx, { instructions: e.target.value || null })}
                  placeholder="Send {{amount}} to @{VENMO_BUSINESS_HANDLE} on Venmo"
                />
              </Box>
              <Box>
                <Text fontSize="2xs" color="fg.muted" mb={1}>
                  Deep-link template — mobile URL scheme, opens the payment app. Leave blank for none.
                </Text>
                <Input
                  size="sm"
                  value={row.deepLinkTemplate ?? ""}
                  onChange={(e) => update(idx, { deepLinkTemplate: e.target.value || null })}
                  placeholder="venmo://paycharge?txn=pay&recipients={VENMO_BUSINESS_HANDLE}&amount={{amount}}&note={{note}}"
                  fontFamily="mono"
                />
              </Box>
            </VStack>
          )}
        </Box>
      ))}
      <Button size="sm" variant="outline" onClick={add}>
        <Plus size={12} /> Add payment method
      </Button>
      <HStack gap={2}>
        <Button size="sm" onClick={onSave} loading={saving} disabled={value === originalValue}>Save</Button>
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={saving}>Cancel</Button>
      </HStack>
    </VStack>
  );
}

/** Inline editor for JSON array-of-objects settings like [{key, label}].
 *  Column visibility is auto-detected from item shape: equipmentKind shows up
 *  when any item has one (used by SERVICE_TYPES); singleton shows up when any
 *  item has the field (used by DOCUMENT_TYPES). */
type JsonArrayItem = {
  key: string;
  label: string;
  equipmentKind?: string;
  singleton?: boolean;
  description?: string;
};
/** Dedicated editor for the EXPENSE_CATEGORIES taxonomy — label, Schedule C
 *  line, QuickBooks chart-of-accounts mapping, and the selectable flag
 *  (off = export-only synthetic category). qbAccount is stored as
 *  string | null: null means "Unmapped" — rows in that category land in
 *  the QB Expenses CSV's "Unmapped" account so the operator re-categorizes
 *  on the QB side after import. The editor treats an empty input as null
 *  so the user never has to type the word "null". */
type ExpenseCategoryRow = {
  label: string;
  scheduleCLine: string;
  qbAccount: string | null;
  selectable: boolean;
};

// Empty input → null. Whitespace also collapses to null so a stray space
// in the field doesn't accidentally produce an unfindable QB account name.
function normalizeQbAccount(raw: string): string | null {
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
}

function ExpenseCategoriesEditor({ value, onChange, onSave, onCancel, saving }: {
  value: string;
  onChange: (v: string) => void;
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
}) {
  let items: ExpenseCategoryRow[] = [];
  let parseError: string | null = null;
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) throw new Error("must be an array");
    // Round-trip qbAccount with the same null-vs-string contract the seed
    // and the backend parser use. Earlier versions of this editor silently
    // dropped qbAccount on parse — re-saving wiped every mapping. Fixed.
    items = parsed.map((r: any) => {
      let qbAccount: string | null = null;
      if (typeof r.qbAccount === "string") {
        qbAccount = normalizeQbAccount(r.qbAccount);
      }
      return {
        label: String(r.label ?? ""),
        scheduleCLine: String(r.scheduleCLine ?? ""),
        qbAccount,
        selectable: r.selectable !== false,
      };
    });
  } catch (e: any) {
    parseError = e?.message ?? "invalid JSON";
  }

  function update(idx: number, patch: Partial<ExpenseCategoryRow>) {
    onChange(JSON.stringify(items.map((row, i) => (i === idx ? { ...row, ...patch } : row))));
  }
  function remove(idx: number) {
    onChange(JSON.stringify(items.filter((_, i) => i !== idx)));
  }
  function add() {
    // New rows default to qbAccount: null — operator picks a QB account
    // before this category can land cleanly in qb-expenses.csv.
    onChange(JSON.stringify([...items, { label: "", scheduleCLine: "", qbAccount: null, selectable: true }]));
  }

  if (parseError) {
    return (
      <VStack align="stretch" gap={2} w="full">
        <Text fontSize="xs" color="red.600">EXPENSE_CATEGORIES JSON is malformed: {parseError}</Text>
        <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
      </VStack>
    );
  }

  return (
    <VStack align="stretch" gap={2} w="full">
      <Text fontSize="2xs" color="fg.muted">
        Maps each expense category to its Schedule C line and its QuickBooks
        chart-of-accounts name. <Text as="span" fontWeight="semibold">QB Account</Text> must match
        the account name in QuickBooks exactly (capitalization + spacing) — leave it blank to land
        rows in this category as "Unmapped" in the QB Expenses CSV (the operator re-categorizes
        them inside QB after import). Uncheck "Selectable" for export-only synthetic categories
        (e.g. Payment Processing Fees) — they stay in the export but are hidden from the
        expense-logging pickers.
      </Text>
      <HStack gap={2} fontSize="2xs" color="fg.muted" fontWeight="medium" px={1}>
        <Text flex="1">Category label</Text>
        <Text w="80px" textAlign="center">Sch. C line</Text>
        <Text flex="1">QB Account</Text>
        <Text w="70px" textAlign="center">Selectable</Text>
        <Box w="32px" />
      </HStack>
      {items.map((row, idx) => (
        <HStack key={idx} gap={2}>
          <Input size="sm" flex="1" value={row.label} onChange={(e) => update(idx, { label: e.target.value })} placeholder="Advertising" />
          <Input size="sm" w="80px" textAlign="center" value={row.scheduleCLine} onChange={(e) => update(idx, { scheduleCLine: e.target.value })} placeholder="8" />
          <Input
            size="sm"
            flex="1"
            value={row.qbAccount ?? ""}
            // Pass the raw input value through during editing so trailing
            // spaces don't get stripped mid-word ("Vehicle " → "Vehicle"
            // would block the user from typing the next word). Empty /
            // whitespace-only values still resolve to null on the server
            // via parseExpenseCategoriesSetting, so the "Unmapped" semantic
            // is preserved without per-keystroke normalization.
            onChange={(e) => update(idx, { qbAccount: e.target.value })}
            placeholder="Unmapped"
          />
          <Box w="70px" textAlign="center">
            <input type="checkbox" checked={row.selectable} onChange={(e) => update(idx, { selectable: e.target.checked })} />
          </Box>
          <Button size="xs" variant="ghost" colorPalette="red" w="32px" onClick={() => remove(idx)}>
            <Trash2 size={12} />
          </Button>
        </HStack>
      ))}
      <HStack gap={2}>
        <Button size="xs" variant="outline" onClick={add}>+ Add category</Button>
        <Box flex="1" />
        <Button size="xs" variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button size="xs" colorPalette="blue" loading={saving} onClick={onSave}>Save</Button>
      </HStack>
    </VStack>
  );
}

function JsonArrayEditor({ value, onChange, onSave, onCancel, saving, originalValue, forceDescription }: {
  value: string;
  onChange: (v: string) => void;
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
  originalValue: string;
  /** Force the Description column visible even when no row has one yet —
   *  used so editors can bootstrap the field on settings like DOCUMENT_TYPES. */
  forceDescription?: boolean;
}) {
  let items: JsonArrayItem[] = [];
  try { items = JSON.parse(value); } catch {}

  const hasEquipmentKind = items.some((i) => i.equipmentKind);
  const hasSingleton = items.some((i) => i.singleton !== undefined);
  const hasDescription = forceDescription || items.some((i) => typeof i.description === "string");

  const [newKey, setNewKey] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [newEquipment, setNewEquipment] = useState("");
  const [newSingleton, setNewSingleton] = useState(false);
  const [newDescription, setNewDescription] = useState("");

  function updateItem(idx: number, updates: Partial<JsonArrayItem>) {
    const updated = [...items];
    const item = { ...updated[idx], ...updates };
    if (!item.equipmentKind) delete item.equipmentKind;
    if (!hasSingleton) delete item.singleton;
    if (!item.description) delete item.description;
    updated[idx] = item;
    onChange(JSON.stringify(updated));
  }

  function removeItem(idx: number) {
    onChange(JSON.stringify(items.filter((_, i) => i !== idx)));
  }

  function addItem() {
    if (!newKey.trim() || !newLabel.trim()) return;
    const item: JsonArrayItem = { key: newKey.trim().toUpperCase(), label: newLabel.trim() };
    if (newEquipment.trim()) item.equipmentKind = newEquipment.trim().toUpperCase();
    if (hasSingleton) item.singleton = newSingleton;
    if (hasDescription && newDescription.trim()) item.description = newDescription.trim();
    onChange(JSON.stringify([...items, item]));
    setNewKey("");
    setNewLabel("");
    setNewEquipment("");
    setNewSingleton(false);
    setNewDescription("");
  }

  return (
    <VStack align="stretch" gap={2} w="full">
      {/* Header */}
      <HStack gap={2} fontSize="2xs" color="fg.muted" fontWeight="medium">
        <Text flex="1">Key</Text>
        <Text flex="1">Label</Text>
        {hasEquipmentKind && <Text flex="1">Equipment Kind</Text>}
        {hasSingleton && <Text w="64px" textAlign="center">Singleton</Text>}
        {hasDescription && <Text flex="2">Description</Text>}
        <Box w="24px" />
      </HStack>
      {items.map((item, idx) => (
        <HStack key={idx} gap={2}>
          <Input size="sm" value={item.key} onChange={(e) => updateItem(idx, { key: e.target.value.toUpperCase() })} flex="1" placeholder="MOW" />
          <Input size="sm" value={item.label} onChange={(e) => updateItem(idx, { label: e.target.value })} flex="1" placeholder="Mow" />
          {hasEquipmentKind && (
            <Input size="sm" value={item.equipmentKind ?? ""} onChange={(e) => updateItem(idx, { equipmentKind: e.target.value.toUpperCase() })} flex="1" placeholder="(optional)" />
          )}
          {hasSingleton && (
            <Box w="64px" textAlign="center">
              <input
                type="checkbox"
                checked={!!item.singleton}
                onChange={(e) => updateItem(idx, { singleton: e.target.checked })}
              />
            </Box>
          )}
          {hasDescription && (
            <Input size="sm" value={item.description ?? ""} onChange={(e) => updateItem(idx, { description: e.target.value })} flex="2" placeholder="(optional)" />
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
        {hasSingleton && (
          <Box w="64px" textAlign="center">
            <input
              type="checkbox"
              checked={newSingleton}
              onChange={(e) => setNewSingleton(e.target.checked)}
            />
          </Box>
        )}
        {hasDescription && (
          <Input size="sm" value={newDescription} onChange={(e) => setNewDescription(e.target.value)} flex="2" placeholder="Description (opt)" />
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
  // Collapsed Settings-tab sections, persisted per admin. Stores section keys
  // that are collapsed; the first-visit default is all sections collapsed so
  // the tab opens as a compact overview. (Key is v2 — bumped when the default
  // flipped from expanded to collapsed, so the new default actually applies.)
  const [collapsedSections, setCollapsedSections] = usePersistedState<string[]>(
    "settings_collapsed_sections_v2",
    SETTING_SECTION_ORDER,
  );
  function toggleSection(key: string) {
    setCollapsedSections((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key],
    );
  }
  // Group the loaded settings into ordered sections. `settings` is already
  // sorted by SETTINGS_ORDER, so each section preserves that intra-order.
  // Only sections with at least one setting are rendered.
  const groupedSections = useMemo(() => {
    const orderedKeys = [...SETTING_SECTIONS.map((s) => s.key), OTHER_SECTION.key];
    const byKey = new Map<string, Setting[]>();
    for (const s of settings) {
      const sectionKey = resolveSettingSection(s.section).key;
      if (!byKey.has(sectionKey)) byKey.set(sectionKey, []);
      byKey.get(sectionKey)!.push(s);
    }
    return orderedKeys
      .map((k) => ({
        section: k === OTHER_SECTION.key ? OTHER_SECTION : SETTING_SECTIONS.find((s) => s.key === k)!,
        items: byKey.get(k) ?? [],
      }))
      .filter((g) => g.items.length > 0);
  }, [settings]);

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
        "PAYMENT_METHODS",
        "HIGH_VALUE_JOB_THRESHOLD",
        "EQUIPMENT_KINDS",
        "SERVICE_TYPES",
        "EXPENSE_CATEGORIES",
        "DOCUMENT_TYPES",
        "DOCUMENT_MAX_SIZE_MB",
        "TIMELINE_CATEGORIES",
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
    // Numeric keys (integer or float, bounded by NUMERIC_SETTINGS) get
    // validated client-side first. Anything failing the registry's bounds
    // gets rejected before hitting the API.
    const numericCheck = validateNumericSetting(key, editValue);
    if (!numericCheck.ok) {
      publishInlineMessage({ type: "ERROR", text: numericCheck.error ?? "Invalid value." });
      return;
    }
    setSaving(true);
    try {
      await apiPatch(`/api/admin/settings/${key}`, { value: editValue });
      publishInlineMessage({ type: "SUCCESS", text: `${prettySettingName(key)} updated.` });
      // Invalidate the in-memory PAYMENT_METHODS label cache so subsequent
      // page navigations pick up the new labels without a hard refresh.
      if (key === "PAYMENT_METHODS") {
        const { invalidatePaymentMethodLabels } = await import("@/src/lib/usePaymentMethodLabels");
        invalidatePaymentMethodLabels();
      }
      if (key === "EXPENSE_CATEGORIES") {
        const { invalidateExpenseCategories } = await import("@/src/lib/useExpenseCategories");
        invalidateExpenseCategories();
      }
      setEditingKey(null);
      void load();
    } catch (err) {
      publishInlineMessage({ type: "ERROR", text: getErrorMessage("Update failed.", err) });
    } finally {
      setSaving(false);
    }
  }

  // Direct write for inline-toggle settings (no edit-mode flow).
  async function saveSettingValue(key: string, value: string) {
    setSaving(true);
    try {
      await apiPatch(`/api/admin/settings/${key}`, { value });
      publishInlineMessage({ type: "SUCCESS", text: `${prettySettingName(key)} updated.` });
      if (key === "PAYMENT_METHODS") {
        const { invalidatePaymentMethodLabels } = await import("@/src/lib/usePaymentMethodLabels");
        invalidatePaymentMethodLabels();
      }
      if (key === "EXPENSE_CATEGORIES") {
        const { invalidateExpenseCategories } = await import("@/src/lib/useExpenseCategories");
        invalidateExpenseCategories();
      }
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
      {/* Pricing Guide moved to its own tab under Directory. Settings now
          only carries the general key/value settings rows. */}

      {/* ── General Settings Sections ── */}
      {groupedSections.length > 0 && (
        <Box>
          <Text fontSize="md" fontWeight="semibold" mb={2} px={1}>General Settings</Text>
          <VStack align="stretch" gap={4}>
            {groupedSections.map(({ section, items }) => {
              const collapsed = collapsedSections.includes(section.key);
              return (
                <Box key={section.key}>
                  {/* Collapsible section header */}
                  <HStack
                    gap={2}
                    px={1}
                    py={1.5}
                    cursor="pointer"
                    onClick={() => toggleSection(section.key)}
                    _hover={{ bg: "gray.50" }}
                    borderRadius="md"
                  >
                    <Box color="fg.muted" flexShrink={0}>
                      {collapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
                    </Box>
                    <VStack align="start" gap={0} flex="1" minW={0}>
                      <HStack gap={2}>
                        <Text fontSize="sm" fontWeight="semibold">{section.title}</Text>
                        <Badge size="sm" colorPalette="gray" variant="subtle" borderRadius="full">
                          {items.length}
                        </Badge>
                      </HStack>
                      <Text fontSize="xs" color="fg.muted">{section.description}</Text>
                    </VStack>
                  </HStack>
                  {!collapsed && (
                    <VStack align="stretch" gap={3} mt={2}>
                      {items.map((s) => (
              <Card.Root key={s.id} variant="outline">
                <Card.Body py="2" px="3">
                  <VStack align="start" gap={1}>
                    <HStack justify="space-between" w="full" align="start">
                      <VStack align="start" gap={0}>
                        <Text fontSize="sm" fontWeight="semibold">
                          {prettySettingName(s.key)}
                        </Text>
                        {s.description && (
                          <Text fontSize="xs" color="fg.muted">{s.description}</Text>
                        )}
                      </VStack>
                      {isSuper && editingKey !== s.key && s.key !== "DEFAULT_PAYMENT_COMMUNICATIONS_MODE" && s.key !== "PAYROLL_PERIOD_CADENCE" && !BOOLEAN_SETTINGS.has(s.key) && (
                        <Button size="xs" variant="outline" onClick={() => { setEditingKey(s.key); setEditValue(s.value); }}>
                          Edit
                        </Button>
                      )}
                    </HStack>

                    {s.key === "PAYROLL_PERIOD_CADENCE" ? (
                      // Three-state cadence selector — only WEEKLY, BIWEEKLY,
                      // or MONTHLY are valid. Free text would corrupt the
                      // Exports tab period math. Super-only writes.
                      <HStack gap={2}>
                        {(["WEEKLY", "BIWEEKLY", "MONTHLY"] as const).map((v) => (
                          <Button
                            key={v}
                            size="xs"
                            variant={s.value === v ? "solid" : "outline"}
                            colorPalette="blue"
                            loading={saving && s.value !== v}
                            disabled={!isSuper || s.value === v}
                            onClick={() => void saveSettingValue(s.key, v)}
                          >
                            {v.charAt(0) + v.slice(1).toLowerCase()}
                          </Button>
                        ))}
                      </HStack>
                    ) : s.key === "DEFAULT_PAYMENT_COMMUNICATIONS_MODE" ? (
                      // Two-state toggle — the only valid values are SERVER
                      // or CLAIMER, so no free-text input. Super-only writes.
                      <HStack gap={2}>
                        <Button
                          size="xs"
                          variant={s.value === "SERVER" ? "solid" : "outline"}
                          colorPalette="blue"
                          loading={saving && s.value !== "SERVER"}
                          disabled={!isSuper || s.value === "SERVER"}
                          onClick={() => void saveSettingValue(s.key, "SERVER")}
                        >
                          Server
                        </Button>
                        <Button
                          size="xs"
                          variant={s.value === "CLAIMER" ? "solid" : "outline"}
                          colorPalette="purple"
                          loading={saving && s.value !== "CLAIMER"}
                          disabled={!isSuper || s.value === "CLAIMER"}
                          onClick={() => void saveSettingValue(s.key, "CLAIMER")}
                        >
                          Claimer
                        </Button>
                      </HStack>
                    ) : BOOLEAN_SETTINGS.has(s.key) ? (
                      // Off/On toggle — value is "true"/"false". Super-only.
                      <HStack gap={2}>
                        <Button
                          size="xs"
                          variant={s.value !== "true" ? "solid" : "outline"}
                          colorPalette="gray"
                          loading={saving && s.value !== "false"}
                          disabled={!isSuper || s.value !== "true"}
                          onClick={() => void saveSettingValue(s.key, "false")}
                        >
                          Off
                        </Button>
                        <Button
                          size="xs"
                          variant={s.value === "true" ? "solid" : "outline"}
                          colorPalette="green"
                          loading={saving && s.value !== "true"}
                          disabled={!isSuper || s.value === "true"}
                          onClick={() => void saveSettingValue(s.key, "true")}
                        >
                          On
                        </Button>
                      </HStack>
                    ) : editingKey === s.key ? (
                      (() => {
                        // Settings keys that should always expose a Description
                        // column in the editor (so admin can bootstrap the
                        // first description on a row that has none yet).
                        const forceDescription = s.key === "DOCUMENT_TYPES" || s.key === "TIMELINE_CATEGORIES";
                        // Numeric keys: use a number input with bounds from
                        // NUMERIC_SETTINGS. inputMode hints the right mobile
                        // keyboard. handleSave is still the source of truth.
                        const numericCfg = NUMERIC_SETTINGS[s.key];
                        if (numericCfg) {
                          const valid = validateNumericSetting(s.key, editValue).ok;
                          return (
                            <HStack gap={2} w="full" align="start">
                              <VStack align="stretch" flex="1" gap={1}>
                                <Input
                                  type="number"
                                  inputMode={numericCfg.kind === "integer" ? "numeric" : "decimal"}
                                  min={numericCfg.min}
                                  max={numericCfg.max}
                                  step={numericCfg.step ?? (numericCfg.kind === "integer" ? 1 : "any")}
                                  value={editValue}
                                  onChange={(e) => setEditValue(e.target.value)}
                                  size="sm"
                                  autoFocus
                                />
                                {!valid && (
                                  <Text fontSize="xs" color="red.600">{numericCfg.hint}</Text>
                                )}
                              </VStack>
                              <Button size="sm" onClick={() => handleSave(s.key)} loading={saving} disabled={editValue === s.value || !valid}>Save</Button>
                              <Button size="sm" variant="ghost" onClick={() => setEditingKey(null)} disabled={saving}>Cancel</Button>
                            </HStack>
                          );
                        }
                        // Dedicated editor for PAYMENT_METHODS — exposes every
                        // field the taxonomy needs (fees, contexts, deep link,
                        // instructions) instead of the generic key/label form.
                        if (s.key === "PAYMENT_METHODS") {
                          return <PaymentMethodsEditor value={editValue} onChange={setEditValue} onSave={() => handleSave(s.key)} onCancel={() => setEditingKey(null)} saving={saving} originalValue={s.value} />;
                        }
                        // Dedicated editor for EXPENSE_CATEGORIES — label,
                        // Schedule C line, and the selectable flag.
                        if (s.key === "EXPENSE_CATEGORIES") {
                          return <ExpenseCategoriesEditor value={editValue} onChange={setEditValue} onSave={() => handleSave(s.key)} onCancel={() => setEditingKey(null)} saving={saving} />;
                        }
                        // Detect JSON format and use appropriate editor
                        try {
                          const parsed = JSON.parse(s.value);
                          if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].key) {
                            return <JsonArrayEditor value={editValue} onChange={setEditValue} onSave={() => handleSave(s.key)} onCancel={() => setEditingKey(null)} saving={saving} originalValue={s.value} forceDescription={forceDescription} />;
                          }
                          if (typeof parsed === "object" && !Array.isArray(parsed)) {
                            return <JsonMapEditor value={editValue} onChange={setEditValue} onSave={() => handleSave(s.key)} onCancel={() => setEditingKey(null)} saving={saving} originalValue={s.value} />;
                          }
                        } catch {}
                        // Also handle empty array case
                        if (s.value === "[]") {
                          return <JsonArrayEditor value={editValue} onChange={setEditValue} onSave={() => handleSave(s.key)} onCancel={() => setEditingKey(null)} saving={saving} originalValue={s.value} forceDescription={forceDescription} />;
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
                        // EXPENSE_CATEGORIES items are keyed on `label`, not
                        // `key`, so render them explicitly as badges instead
                        // of falling through to the raw-JSON display.
                        if (s.key === "EXPENSE_CATEGORIES") {
                          try {
                            const cats = JSON.parse(s.value);
                            if (Array.isArray(cats) && cats.length > 0) {
                              return (
                                <Box display="flex" gap="4px" flexWrap="wrap">
                                  {cats.map((c: any) => (
                                    <Badge
                                      key={c.label}
                                      size="sm"
                                      variant="solid"
                                      colorPalette={c.selectable === false ? "gray" : "blue"}
                                      px="2"
                                      borderRadius="full"
                                      fontSize="xs"
                                    >
                                      {c.label} · line {c.scheduleCLine}
                                      {c.selectable === false ? " · export-only" : ""}
                                    </Badge>
                                  ))}
                                </Box>
                              );
                            }
                          } catch {}
                        }
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
                  )}
                </Box>
              );
            })}
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
