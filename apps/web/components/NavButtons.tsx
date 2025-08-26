"use client";

import { HStack, Button } from "@chakra-ui/react";
import { useRouter } from "next/navigation";

export function NavButtons() {
  const router = useRouter();
  return (
    <HStack gap={3} mt={6}>
      <Button colorPalette="brand" onClick={() => router.push("/hello")}>
        Call API
      </Button>
      <Button
        variant="outline"
        onClick={() =>
          window.open("https://seedlings3-web.vercel.app", "_blank")
        }
      >
        Open Site
      </Button>
    </HStack>
  );
}
