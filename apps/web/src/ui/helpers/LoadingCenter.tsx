import { Box, Spinner } from "@chakra-ui/react";

export default function LoadingCenter() {
  return (
    <Box
      minH="160px"
      display="flex"
      alignItems="center"
      justifyContent="center"
    >
      <Spinner size="lg" />
    </Box>
  );
}
