import { HStack, Button, Text, Switch } from "@chakra-ui/react";
import { useEffect, useState } from "react";
import {
  getOverrideRole,
  setOverrideRole,
  ensureDefaultWorker,
  isDev,
  type Role,
  type DevOverride,
} from "../lib/devRole";

const getSimProd = () =>
  typeof window !== "undefined" &&
  localStorage.getItem("seedlings3.simulateProd") === "1";

const setSimProdLS = (on: boolean) => {
  if (typeof window === "undefined") return;
  if (on) localStorage.setItem("seedlings3.simulateProd", "1");
  else localStorage.removeItem("seedlings3.simulateProd");
  // Only tell the app to refetch /me; lists will unmount/re-mount as needed
  window.dispatchEvent(new Event("seedlings3:dev-role-changed"));
};

export default function DevRoleSwitch() {
  const [role, setRole] = useState<DevOverride | null>(null);
  const [simProd, setSimProd] = useState<boolean>(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    if (!isDev()) return;

    setMounted(true);
    setSimProd(getSimProd());

    // Default to WORKER only if not set yet (keeps your old behavior)
    ensureDefaultWorker();
    setRole(getOverrideRole());
  }, []);

  const broadcastAll = (detail: DevOverride | Role) => {
    try {
      window.dispatchEvent(
        new CustomEvent("seedlings3:dev-role-changed", { detail })
      );
      window.dispatchEvent(new Event("seedlings3:equipment-updated"));
    } catch {}
  };

  // Clicking the same role clears it; clicking the other switches to it
  const toggleRole = (next: Role) => {
    const newRole: DevOverride = role === next ? "NONE" : next;
    setOverrideRole(newRole);
    setRole(newRole);
    broadcastAll(newRole);
  };

  if (!isDev()) return null;

  return (
    <HStack gap="3" alignItems="center">
      {/* Hide these buttons entirely in Prod mode */}
      {!simProd && (
        <>
          <Button
            size="sm"
            variant={role === "WORKER" ? "solid" : "outline"}
            onClick={() => toggleRole("WORKER")}
          >
            Worker
          </Button>

          <Button
            size="sm"
            variant={role === "ADMIN" ? "solid" : "outline"}
            onClick={() => toggleRole("ADMIN")}
          >
            Admin
          </Button>
        </>
      )}

      <HStack gap="2" alignItems="center" ml="auto">
        <Text fontSize="sm" color="gray.600">
          Prod mode
        </Text>

        {/* Render switch only after mount so default reflects localStorage */}
        {mounted && (
          <Switch.Root
            size="sm"
            checked={simProd}
            onCheckedChange={({ checked }: { checked: boolean }) => {
              setSimProdLS(checked); // write LS + fire events
              setSimProd(checked); // update toggle immediately
            }}
          >
            <Switch.HiddenInput
              aria-label="Simulate production behavior"
              onChange={(e) => {
                const checked = e.currentTarget.checked;
                setSimProdLS(checked);
                setSimProd(checked);
              }}
            />
            <Switch.Control cursor="pointer">
              <Switch.Thumb />
            </Switch.Control>
          </Switch.Root>
        )}
      </HStack>
    </HStack>
  );
}
