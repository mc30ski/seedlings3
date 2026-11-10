"use client";

// ─────────────────────────────────────────────────────────────────────────────
// MESSAGE THE CUSTOMER ABOUT THIS ROW.
//
// Work → Repeating is where the operator decides to stop or restart somebody's
// service, and the decision has a person on the other end of it: "you would
// want to tell the client you are about to pause the job, or resume the job".
// Telling them was a trip to Customers, a search, and a copy-paste of a phone
// number — far enough away that it would not happen.
//
// SAME PLUMBING AS THE JOB CARDS, deliberately: `buildSmsHref` /
// `buildMailtoHref` / `fetchCommsCc`, so a message sent from here carries the
// same CC list as one sent from Work → Jobs. Only the trigger and the drafted
// body are this screen's own.
//
// IT DRAFTS, IT DOES NOT SEND. Every item opens the operator's own SMS or mail
// client with the text filled in, which is what the rest of this app does and
// is the only version that is safe to offer next to a destructive-ish action:
// the message is still theirs to read, edit or abandon, and nothing is
// recorded as "sent" that a person did not actually send.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useRef, useState } from "react";
import { Box, Button, Text, VStack } from "@chakra-ui/react";
import { ChevronDown, Mail, MessageCircle, Phone } from "lucide-react";
import { buildMailtoHref, buildSmsHref, fetchCommsCc } from "@/src/lib/comms";

export type ContactTarget = {
  contactName: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
};

/** A message the operator would plausibly want to send about this row. */
export type DraftMessage = { label: string; subject: string; body: string };

export default function ClientContactMenu({
  contact,
  draft,
  label = "Message the customer",
  size = "xs",
}: {
  contact: ContactTarget;
  /**
   * The row-specific draft, or null when nothing obvious applies. Null still
   * leaves Text / Email / Call — "no draft" is not "no way to reach them".
   */
  draft?: DraftMessage | null;
  label?: string;
  size?: "2xs" | "xs" | "sm";
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement | null>(null);

  // Close on any click outside, and on Escape. Without the first, a second
  // menu opens while the first is still up and the operator cannot tell which
  // row they are about to message.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const { contactName, contactPhone, contactEmail } = contact;
  // NOTHING TO OFFER IS NOTHING TO SHOW. A disabled icon on a customer with
  // no phone and no email teaches the operator to ignore the icon.
  if (!contactPhone && !contactEmail) return null;

  async function send(channel: "sms" | "email", body: string, subject: string) {
    setOpen(false);
    const cc = await fetchCommsCc();
    if (channel === "sms" && contactPhone) {
      window.open(buildSmsHref({ to: contactPhone, body, ccPhones: cc.phones }), "_self");
    } else if (contactEmail) {
      window.open(
        buildMailtoHref({ to: contactEmail, subject, body, ccEmails: cc.emails }),
        "_self",
      );
    }
  }

  return (
    <Box position="relative" ref={wrap} flexShrink={0} w="full">
      {/* A FULL-WIDTH BUTTON, NOT AN ICON. It sits in the row's actions
          column, whose whole rule is that every control there is the same
          width, size and alignment — a stack, not a wrapped row, because
          three buttons at three widths on three alignments is what that
          column shipped as and could not be read. A square icon dropped into
          a stack of stretched buttons breaks the same rule from the other
          side: it was the one thing in the column that did not line up.

          Ghost like `Open`, because it opens something rather than changing
          anything; the caret says it opens a menu rather than navigating. */}
      <Button
        size={size}
        variant="ghost"
        w="full"
        justifyContent="center"
        gap={1}
        onClick={() => setOpen((v) => !v)}
        title={contactName ? `${label} — ${contactName}` : label}
        aria-label={label}
        aria-expanded={open}
        aria-haspopup="menu"
        data-testid="contact-menu-trigger"
        data-open={open ? "1" : "0"}
      >
        <MessageCircle size={11} />
        Message
        <ChevronDown size={11} />
      </Button>

      {open && (
        <VStack
          position="absolute"
          top="100%"
          right="0"
          mt={1}
          zIndex={20}
          minW="200px"
          align="stretch"
          gap={0}
          bg="bg.panel"
          borderWidth="1px"
          borderColor="border.emphasized"
          borderRadius="md"
          boxShadow="lg"
          p={1}
          data-testid="contact-menu"
        >
          {contactName && (
            <Text fontSize="2xs" color="fg.muted" px={2} py={1} fontWeight="semibold">
              {contactName}
            </Text>
          )}

          {/* THE DRAFT FIRST, because it is the reason the operator opened
              this. The bare channels below it are the fallback for anything
              the draft does not cover. */}
          {draft && (contactPhone || contactEmail) && (
            <Button
              size="xs"
              variant="ghost"
              justifyContent="flex-start"
              colorPalette="blue"
              onClick={() => send(contactPhone ? "sms" : "email", draft.body, draft.subject)}
              data-testid="contact-menu-draft"
            >
              <MessageCircle size={12} />
              {draft.label}
            </Button>
          )}

          {contactPhone && (
            <Button
              size="xs"
              variant="ghost"
              justifyContent="flex-start"
              onClick={() => send("sms", "", "")}
              data-testid="contact-menu-text"
            >
              <MessageCircle size={12} />
              Text {contactPhone}
            </Button>
          )}
          {contactEmail && (
            <Button
              size="xs"
              variant="ghost"
              justifyContent="flex-start"
              onClick={() => send("email", "", "Seedlings Lawn Care")}
              data-testid="contact-menu-email"
            >
              <Mail size={12} />
              Email
            </Button>
          )}
          {contactPhone && (
            <Button
              size="xs"
              variant="ghost"
              justifyContent="flex-start"
              onClick={() => { setOpen(false); window.open(`tel:${contactPhone}`, "_self"); }}
              data-testid="contact-menu-call"
            >
              <Phone size={12} />
              Call {contactPhone}
            </Button>
          )}
        </VStack>
      )}
    </Box>
  );
}
