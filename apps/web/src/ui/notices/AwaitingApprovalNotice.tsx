import { Badge, Box, Text } from "@chakra-ui/react";

export default function AwaitingApprovalNotice() {
  return (
    <Box w="full" p={3} bg="yellow.50" borderWidth="1px" borderColor="yellow.300" rounded="md" mb={2}>
      <Badge colorPalette="yellow" variant="solid" size="sm" mb={1}>Pending Approval</Badge>
      <Text fontSize="sm" color="yellow.800">
        An administrator needs to approve your account before you can access all features.
      </Text>
    </Box>
  );
}
