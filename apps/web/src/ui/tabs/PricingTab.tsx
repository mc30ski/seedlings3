"use client";

import { useEffect, useState } from "react";
import CurrencyInput from "@/src/ui/components/CurrencyInput";
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
  Wrap,
} from "@chakra-ui/react";
import { DollarSign, Pencil, Plus, Trash2 } from "lucide-react";
import TabExplainer, { Em, ExplainerText, RoleSection } from "@/src/ui/components/TabExplainer";
import { apiGet, apiPost, apiPatch, apiDelete } from "@/src/lib/api";
import { fmtDate } from "@/src/lib/dates";
import {
  publishInlineMessage,
  getErrorMessage,
} from "@/src/ui/components/InlineMessage";
import ConfirmDialog from "@/src/ui/dialogs/ConfirmDialog";
import { DEFAULT_SERVICE_TYPES, jobTagLabel, pricingJobTags } from "@/src/ui/components/JobTagPicker";

export type PricingEntry = {
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
    /** Optional bindings to one or more job tags (MOW, TRIM, …). Drives
     *  the add-on and estimate inline-reference hints when set. The
     *  legacy `jobTag` single-string field is kept readable for old
     *  rows; new writes always use the array. */
    jobTags?: string[] | null;
    jobTag?: string | null;
  } | null;
};

type Props = {
  isSuper?: boolean;
  /** Forces read-only regardless of role. Admin + Worker views set this. */
  readOnly?: boolean;
  /** Additive scope — capabilities ADD as you climb the ladder.
   *  scope.isWorker → read-only view of the pricing guide.
   *  scope.isAdmin  → read-only view (same data).
   *  scope.isSuper  → adds add/edit/delete affordances.
   *  Falls back to a scope derived from the legacy `isSuper` + `readOnly`
   *  props when not passed, so mounts still on the old shape keep working. */
  scope?: { isWorker: boolean; isAdmin: boolean; isSuper: boolean };
};

export default function PricingTab({ isSuper, readOnly, scope }: Props) {
  const [entries, setEntries] = useState<PricingEntry[]>([]);
  const [loading, setLoading] = useState(true);

  // Effective scope: prefer the additive prop; fall back to a scope
  // derived from the legacy props. `isSuper` = the super, writable
  // variant; `readOnly` on its own = admin (or worker) read-only view.
  const effScope = scope ?? {
    isWorker: !isSuper && !!readOnly,
    isAdmin: !isSuper && !!readOnly,
    isSuper: !!isSuper && !readOnly,
  };
  // Capabilities render additively AND are strictly governed by the
  // scope prop. No `me` prop on this tab — trust the scope for the
  // super check (the shell only sets scope.isSuper on the super tab).
  const showWorkerExtras = effScope.isWorker;
  const showAdminExtras = effScope.isAdmin || effScope.isSuper;
  const showSuperExtras = effScope.isSuper;

  // Effective editability: Super only.
  const canEdit = showSuperExtras;
  // Workers/admins hit the worker-guard endpoint; super reads /admin/pricing
  // which carries the updatedBy join. Mutations always go to /admin/pricing.
  const readEndpoint = showSuperExtras ? "/api/admin/pricing" : "/api/pricing";

  // Dialog state
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editKey, setEditKey] = useState<string | null>(null);
  const [formLabel, setFormLabel] = useState("");
  const [formDescription, setFormDescription] = useState("");
  const [formUnit, setFormUnit] = useState("");
  const [formAmount, setFormAmount] = useState("");
  const [formJobTags, setFormJobTags] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  function toggleFormJobTag(tag: string) {
    setFormJobTags((prev) =>
      prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag],
    );
  }

  // Delete confirm
  const [deleteConfirm, setDeleteConfirm] = useState<{ key: string; label: string } | null>(null);

  async function load() {
    try {
      const list = await apiGet<PricingEntry[]>(readEndpoint);
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
    setFormJobTags([]);
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
    setFormJobTags(pricingJobTags(v));
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
        jobTags: formJobTags,
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

  // HOISTED ABOVE THE LOADING GATES ON PURPOSE.
  // The help panel is static copy — it does not depend on anything this tab
  // fetches. While it lived below the gates it was unmounted for the whole
  // fetch, and because the breadcrumb's (i) is driven by whichever explainer
  // is mounted, the icon blinked out and back on every visit to this tab.
  // Rendering it in the gate branches too keeps it mounted from the first
  // paint. Closed, it renders nothing, so the loading view is unchanged.
  const tabHelp = (
  <TabExplainer
          explainerId={`seedlings:pricingTab:guideOpen:${canEdit ? "super" : "read"}`}
        >
          <ExplainerText>
            Reference prices for common job types — a <Em>starting point</Em> when quoting, not what
            any client is actually charged. What a job bills is set on the job itself and can differ
            per client.
          </ExplainerText>
          {/* WAS "the AI estimate features read this list". Nothing AI reads
              it — the only model call in the app is the Forecast tool, and it
              does not touch PricingEntry. What actually reads this list is the
              reference panel inside the Complete-Estimate dialog, which sums
              the entries matching the job's tags and offers the total as the
              amount. See `pricingReferenceTags` in ConfirmDialog. */}
          <ExplainerText>
            When you complete an estimate, the dialog shows the entries matching that
            job&rsquo;s tags and offers their total as the amount &mdash; so an entry that
            drifts from what you really charge quietly pulls quotes along with it. Changing
            an entry is <Em>super-only</Em>; if a price here looks wrong it is worth
            flagging.
          </ExplainerText>
          {canEdit && (
            <RoleSection role="Super">
              <ExplainerText>
                You can add, edit and remove entries. Nothing recalculates behind you &mdash;
                a change applies to the next quote, not to work already priced.
              </ExplainerText>
            </RoleSection>
          )}
        </TabExplainer>
  );

  if (loading) {
    return <>{tabHelp}<Box py={10} textAlign="center"><Spinner size="lg" /></Box></>;
  }

  return (
    <Box w="full" pb={8}>
      {/* GET /admin/pricing is adminGuard; POST/PATCH/DELETE are superGuard.
          So "you can edit this" is true for a super admin ONLY — an admin
          reading that would go looking for buttons that are not rendered. */}
      {/* Own bottom margin: this tab's root Box has no `gap`, so without it
          the explainer butts straight into the Add Pricing Entry button. */}
  {tabHelp}

      {canEdit && (
        <Box mb={3}>
          <Button size="sm" colorPalette="blue" onClick={openCreate}>
            <Plus size={14} /> Add Pricing Entry
          </Button>
        </Box>
      )}

      {entries.length === 0 && (
        <Box textAlign="center" py={10}>
          <Text fontSize="lg" fontWeight="semibold" color="fg.muted">No pricing entries yet</Text>
          {canEdit && <Text fontSize="sm" color="fg.muted" mt={1}>Add your first entry to get started.</Text>}
        </Box>
      )}

      <VStack align="stretch" gap={2}>
        {entries.map((entry) => {
          const v = entry.parsedValue;
          if (!v) return null;
          return (
            <Card.Root key={entry.key} variant="outline">
              <Card.Body py="2" px="3">
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
                      {(() => {
                        const tags = pricingJobTags(v);
                        if (tags.length === 0) return null;
                        return (
                          <Badge colorPalette="blue" variant="subtle" fontSize="xs" px="2" borderRadius="full" title="Pricing hint surfaces when any of these tags is added on a job">
                            ⚡ tag{tags.length > 1 ? "s" : ""}: {tags.map((t) => jobTagLabel(t)).join(", ")}
                          </Badge>
                        );
                      })()}
                    </HStack>
                    {v.description && (
                      <Text fontSize="xs" color="fg.muted">{v.description}</Text>
                    )}
                    <Text fontSize="xs" color="fg.muted">
                      Last updated: {fmtDate(entry.updatedAt)}
                      {entry.updatedBy?.displayName && ` by ${entry.updatedBy.displayName}`}
                    </Text>
                  </VStack>
                  {canEdit && (
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
                      <Text fontSize="sm" fontWeight="medium" mb={1}>Amount *</Text>
                      <CurrencyInput value={formAmount} onChange={setFormAmount} placeholder="60.00" size="sm" />
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
                  <Box>
                    <Text fontSize="sm" fontWeight="medium" mb={1}>
                      Inline hint for tag(s) (optional)
                    </Text>
                    <Wrap gap={1.5}>
                      {DEFAULT_SERVICE_TYPES.map((t) => {
                        const on = formJobTags.includes(t.key);
                        return (
                          <Button
                            key={t.key}
                            type="button"
                            size="xs"
                            variant={on ? "solid" : "outline"}
                            colorPalette={on ? "blue" : "gray"}
                            borderRadius="full"
                            onClick={() => toggleFormJobTag(t.key)}
                          >
                            {t.label}
                          </Button>
                        );
                      })}
                    </Wrap>
                    <Text fontSize="xs" color="fg.muted" mt={1}>
                      Tap one or more tags to bind this entry. Its price will show as an inline reference next to any of these tags in the add-on dialog and estimate workflow. Leave all unselected for browse-only entries.
                    </Text>
                  </Box>
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
