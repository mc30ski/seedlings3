import { Badge, Box, Text } from "@chakra-ui/react";

export default function AwaitingApprovalNotice() {
  return (
    <Box w="full" p={3} bg="yellow.faint" borderWidth="1px" borderColor="yellow.emphasized" rounded="md" mb={2}>
      <Badge colorPalette="yellow" variant="solid" size="sm" mb={1}>Pending Approval</Badge>
      <Text fontSize="sm" color="yellow.fg">
        An administrator needs to approve your account before you can access all features.
        We&apos;ll send you a notification once it&apos;s approved — check back here then,
        or revisit any time to see if anything&apos;s opened up.
      </Text>
    </Box>
  );
}
