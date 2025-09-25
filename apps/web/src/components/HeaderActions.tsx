// apps/web/src/components/HeaderActions.tsx
import { useCallback, useEffect, useState } from "react";
import { HStack, Button, Box } from "@chakra-ui/react";
import { UserButton } from "@clerk/clerk-react";
import { FiAlertCircle } from "react-icons/fi";
import { apiGet } from "../lib/api";
import { useRouter } from "next/router";

type Me = {
  id: string;
  isApproved: boolean;
  roles: ("ADMIN" | "WORKER")[];
};

export default function HeaderActions() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [pending, setPending] = useState<number | null>(null);

  const isAdmin = !!me?.isApproved && (me?.roles || []).includes("ADMIN");

  const loadMe = useCallback(async () => {
    try {
      const m = await apiGet<Me>("/api/me");
      setMe(m);
    } catch {
      setMe(null);
    }
  }, []);

  const loadPending = useCallback(async () => {
    if (!isAdmin) {
      setPending(null);
      return;
    }
    try {
      const res = await apiGet<{ pending: number }>(
        "/api/admin/users/pendingCount"
      );
      setPending(res?.pending ?? 0);
    } catch {
      setPending(0);
    }
  }, [isAdmin]);

  useEffect(() => {
    void loadMe();
  }, [loadMe]);
  useEffect(() => {
    void loadPending();
  }, [loadPending, me]);

  // Refresh pending count when users change (approve/remove/etc)
  useEffect(() => {
    const onUsersChanged = () => void loadPending();
    window.addEventListener("seedlings3:users-changed", onUsersChanged);
    return () =>
      window.removeEventListener("seedlings3:users-changed", onUsersChanged);
  }, [loadPending]);

  return (
    <HStack gap="8px">
      {isAdmin && (pending ?? 0) > 0 ? (
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            router.push({
              pathname: "/",
              query: { adminTab: "users", status: "pending" },
            })
          }
          title="Pending approvals"
          position="relative"
        >
          <HStack gap="6px">
            <FiAlertCircle />
            <span>Approvals</span>
            <Box
              as="span"
              position="absolute"
              top="-2px"
              right="-2px"
              fontSize="11px"
              minWidth="18px"
              height="18px"
              lineHeight="18px"
              textAlign="center"
              borderRadius="9999px"
              background="tomato"
              color="white"
              px="1"
            >
              {pending}
            </Box>
          </HStack>
        </Button>
      ) : null}
      <UserButton />
    </HStack>
  );
}
