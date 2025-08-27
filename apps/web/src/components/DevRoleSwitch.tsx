import { HStack, Button, Text } from "@chakra-ui/react";
import { useEffect, useState } from "react";

export default function DevRoleSwitch() {
  const [id, setId] = useState<string | null>(null);
  useEffect(() => setId(localStorage.getItem("dev_clerkUserId")), []);
  const set = (v: string) => {
    localStorage.setItem("dev_clerkUserId", v);
    setId(v);
    location.reload();
  };
  return (
    <HStack gap={3}>
      <Text fontSize="sm">DEV user:</Text>
      <Button
        size="sm"
        onClick={() => set("clerk_worker_example")}
        variant={id === "clerk_worker_example" ? "solid" : "outline"}
      >
        Worker
      </Button>
      <Button
        size="sm"
        onClick={() => set("clerk_admin_example")}
        variant={id === "clerk_admin_example" ? "solid" : "outline"}
      >
        Admin
      </Button>
      <Button
        size="sm"
        onClick={() => {
          localStorage.removeItem("dev_clerkUserId");
          setId(null);
          location.reload();
        }}
      >
        Clear
      </Button>
    </HStack>
  );
}
