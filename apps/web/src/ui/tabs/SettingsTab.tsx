"use client";

import { useEffect, useState } from "react";
import {
  Box,
  Button,
  Card,
  HStack,
  Input,
  Text,
  VStack,
} from "@chakra-ui/react";
import { apiGet, apiPatch } from "@/src/lib/api";
import { type TabPropsType } from "@/src/lib/types";
import { determineRoles } from "@/src/lib/lib";
import LoadingCenter from "@/src/ui/helpers/LoadingCenter";
import UnavailableNotice from "@/src/ui/notices/UnavailableNotice";
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

export default function SettingsTab({ me, purpose = "ADMIN" }: TabPropsType) {
  const { isAvail, isSuper } = determineRoles(me, purpose);

  const [settings, setSettings] = useState<Setting[]>([]);
  const [loading, setLoading] = useState(false);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [saving, setSaving] = useState(false);

  const [test, setTest] = useState(false);
  setTest(true);

  async function load() {
    setLoading(true);
    try {
      const list = await apiGet<Setting[]>("/api/admin/settings");
      setSettings(Array.isArray(list) ? list : []);
    } catch {
      setSettings([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function handleSave(key: string) {
    setSaving(true);
    try {
      await apiPatch(`/api/admin/settings/${key}`, { value: editValue });
      publishInlineMessage({
        type: "SUCCESS",
        text: `Setting "${key}" updated.`,
      });
      setEditingKey(null);
      void load();
    } catch (err) {
      publishInlineMessage({
        type: "ERROR",
        text: getErrorMessage("Update failed.", err),
      });
    } finally {
      setSaving(false);
    }
  }

  if (!isAvail) return <UnavailableNotice />;
  if (loading && settings.length === 0) return <LoadingCenter />;

  return (
    <Box w="full">
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
                      <Text fontSize="xs" color="fg.muted">
                        {s.description}
                      </Text>
                    )}
                  </VStack>
                  {isSuper && editingKey !== s.key && (
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() => {
                        setEditingKey(s.key);
                        setEditValue(s.value);
                      }}
                    >
                      Edit
                    </Button>
                  )}
                </HStack>

                {editingKey === s.key ? (
                  <HStack gap={2} w="full">
                    <Input
                      value={editValue}
                      onChange={(e) => setEditValue(e.target.value)}
                      size="sm"
                      flex="1"
                      autoFocus
                    />
                    <Button
                      size="sm"
                      onClick={() => handleSave(s.key)}
                      loading={saving}
                      disabled={editValue === s.value}
                    >
                      Save
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setEditingKey(null)}
                      disabled={saving}
                    >
                      Cancel
                    </Button>
                  </HStack>
                ) : (
                  <Text fontSize="md" fontWeight="medium">
                    {s.value}
                  </Text>
                )}

                {s.updatedBy && (
                  <Text fontSize="xs" color="fg.muted">
                    Last updated by {s.updatedBy.displayName ?? "unknown"} on{" "}
                    {new Date(s.updatedAt).toLocaleString()}
                  </Text>
                )}
              </VStack>
            </Card.Body>
          </Card.Root>
        ))}
        {settings.length === 0 && !loading && (
          <Text color="fg.muted" p="8">
            No settings configured.
          </Text>
        )}
      </VStack>
    </Box>
  );
}
