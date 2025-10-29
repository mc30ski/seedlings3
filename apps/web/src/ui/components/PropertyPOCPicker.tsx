"use client";

import { useEffect, useMemo, useState } from "react";
import { HStack, Select, Text } from "@chakra-ui/react";
import { createListCollection } from "@chakra-ui/react/collection";
import { apiGet, apiPost } from "@/src/lib/api";
import { publishInlineMessage } from "@/src/ui/components/InlineMessage";

type Props = {
  propertyId: string;
  clientId: string;
  currentContactId?: string | null;
  scope?: string;
  onChanged?: (contactId: string | null) => void;
  disabled?: boolean;
};

export default function PropertyPOCPicker({
  propertyId,
  clientId,
  currentContactId,
  scope = "properties",
  onChanged,
  disabled,
}: Props) {
  const [contacts, setContacts] = useState<any[]>([]);
  const [value, setValue] = useState<string[]>(["NONE"]);

  useEffect(() => {
    setValue([currentContactId ?? "NONE"]);
  }, [currentContactId]);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const res: unknown = await apiGet(`/api/admin/clients/${clientId}`);

        // Accept a few envelope shapes and normalize to an array
        const contactsRaw: unknown =
          (res as any)?.contacts ??
          (res as any)?.data?.contacts ??
          (res as any)?.item?.contacts ??
          [];

        const list: any[] = Array.isArray(contactsRaw) ? contactsRaw : [];

        if (!cancelled) {
          setContacts(
            list.map((ct) => ({
              id: ct.id,
              firstName: ct.firstName ?? "",
              lastName: ct.lastName ?? "",
              email: ct.email ?? null,
              phone: ct.phone ?? null,
              // include other fields you need here (role, isPrimary, active, etc.)
            }))
          );
        }
      } catch {
        if (!cancelled) setContacts([]);
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [clientId]);

  const items = useMemo(
    () =>
      [{ label: "— None —", value: "NONE" }].concat(
        contacts.map((ct) => ({
          label: `${ct.firstName ?? ""} ${ct.lastName ?? ""}`.trim() || ct.id,
          value: ct.id,
        }))
      ),
    [contacts]
  );
  const collection = useMemo(() => createListCollection({ items }), [items]);

  async function save(next: string) {
    setValue([next]);
    try {
      await apiPost(`/api/admin/properties/${propertyId}/point-of-contact`, {
        contactId: next === "NONE" ? null : next,
      });
      publishInlineMessage({
        scope,
        type: "SUCCESS",
        text: "Default contact updated.",
        autoHideMs: 2000,
      });
      onChanged?.(next === "NONE" ? null : next);
    } catch (e) {
      publishInlineMessage({
        scope,
        type: "ERROR",
        text: "Failed to update default contact.",
      });
    }
  }

  return (
    <HStack gap={2}>
      <Text fontSize="sm">Default contact:</Text>
      <Select.Root
        collection={collection}
        value={value}
        onValueChange={(e) => void save(e.value[0]!)}
        size="sm"
        positioning={{ strategy: "fixed", hideWhenDetached: true }}
        disabled={disabled}
      >
        <Select.Control>
          <Select.Trigger>
            <Select.ValueText placeholder="Select" />
          </Select.Trigger>
        </Select.Control>
        <Select.Positioner>
          <Select.Content>
            {items.map((it) => (
              <Select.Item key={it.value} item={it.value}>
                <Select.ItemText>{it.label}</Select.ItemText>
              </Select.Item>
            ))}
          </Select.Content>
        </Select.Positioner>
      </Select.Root>
    </HStack>
  );
}
