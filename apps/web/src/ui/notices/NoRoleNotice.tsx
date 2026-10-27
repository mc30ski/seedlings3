import { Box } from "@chakra-ui/react";

import StatusPanel from "@/src/ui/helpers/StatusPanel";

/**
 * Shown to an approved staff account that has been granted nothing.
 *
 * Four real accounts are in this state. Before this they matched no tab and
 * landed on an empty frame, which reads as a broken deploy rather than as a
 * setup step — a person who cannot get in also cannot be told why, so the
 * alternative of refusing them at sign-in was rejected.
 *
 * Deliberately does NOT name a role. "Added as a Worker or Admin" described
 * seed data as though it were the product; which roles exist is the
 * operator's decision and they can be renamed at any time.
 */
export default function NoRoleNotice() {
  return (
    // Spaced HERE, not in StatusPanel, which several other notices share.
    // This one is the whole page — there is no tab strip above it for an
    // account in this state — so it otherwise sits hard against the header.
    <Box mt={{ base: 6, md: 10 }}>
      <StatusPanel
        badge="Setup needed"
        tone="blue"
        title="Your account is active, but no access has been assigned yet"
        description="Before the app can show you anything, your access needs to be assigned from the Users screen. Please contact whoever set up your account. Your profile remains available from the avatar in the top right, where you can review and sign any outstanding policies."
      />
    </Box>
  );
}
