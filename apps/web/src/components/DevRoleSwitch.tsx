import { HStack, Button, Text } from "@chakra-ui/react";
import { useEffect, useState } from "react";
import {
  getOverrideRole,
  setOverrideRole,
  ensureDefaultWorker,
  isDev,
  type Role,
  type DevOverride,
} from "../lib/devRole";

export default function DevRoleSwitch() {
  const [role, setRole] = useState<DevOverride | null>(null);

  useEffect(() => {
    if (!isDev()) return;
    ensureDefaultWorker(); // sets WORKER only if key is missing
    setRole(getOverrideRole());
  }, []);

  const pick = (next: Role) => {
    setOverrideRole(next);
    setRole(next);
    try {
      window.dispatchEvent(
        new CustomEvent("seedlings3:dev-role-changed", { detail: next })
      );
    } catch {}
  };

  const clear = () => {
    setOverrideRole("NONE"); // <-- sentinel, not removing the key
    setRole("NONE");
    try {
      window.dispatchEvent(
        new CustomEvent("seedlings3:dev-role-changed", { detail: "NONE" })
      );
    } catch {}
  };

  if (!isDev()) return null;

  return (
    <HStack>
      <Button
        size="sm"
        variant={role === "WORKER" ? "solid" : "outline"}
        onClick={() => pick("WORKER")}
      >
        Worker
      </Button>
      <Button
        size="sm"
        variant={role === "ADMIN" ? "solid" : "outline"}
        onClick={() => pick("ADMIN")}
      >
        Admin
      </Button>
      <Button
        size="sm"
        variant={role === "NONE" ? "solid" : "outline"}
        onClick={clear}
      >
        Clear
      </Button>
    </HStack>
  );
}
