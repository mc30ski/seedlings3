import { useEffect, useState, useCallback } from "react";
import { Button, Box, HStack } from "@chakra-ui/react";
import { apiGet } from "../lib/api";
import { useRouter } from "next/router";
// optional icon; remove if you prefer text-only
import { FiAlertCircle } from "react-icons/fi";

/**
 * Shows a small alert icon with a badge when there are pending user approvals.
 * - Only attempts to load if the admin endpoint returns 200 (i.e., you’re an admin).
 * - Hides itself completely if count === 0 or the caller isn’t an admin (403/401).
 */
export default function AdminApprovalBell() {
  const [count, setCount] = useState<number | null>(null); // null => hide
  const router = useRouter();

  const load = useCallback(async () => {
    try {
      // Admin-only endpoint; will 403 for non-admins — that’s okay, we hide then.
      const pending = await apiGet<Array<unknown>>(
        "/api/admin/users?approved=false"
      );
      setCount(Array.isArray(pending) ? pending.length : 0);
    } catch {
      // hide on any error (unauthorized, network, etc.)
      setCount(null);
    }
  }, []);

  useEffect(() => {
    // initial fetch
    void load();

    // refresh occasionally (e.g., each minute)
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [load]);

  // Don’t render if not admin (count === null) or nothing pending
  if (count == null || count === 0) return null;

  return (
    <HStack>
      <Box position="relative">
        <Button
          size="sm"
          variant="ghost"
          onClick={() =>
            router.push({
              pathname: "/",
              query: { adminTab: "users", status: "pending" },
            })
          }
          title={`${count} pending approval${count === 1 ? "" : "s"}`}
        >
          <FiAlertCircle style={{ marginRight: 6 }} />
          Approvals
          {/* badge */}
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
            {count}
          </Box>
        </Button>
      </Box>
    </HStack>
  );
}
