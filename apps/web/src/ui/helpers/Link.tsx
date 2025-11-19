import { Link, Text } from "@chakra-ui/react";

export function MailLink({
  to,
  subject,
  body,
}: {
  to: string;
  subject: string;
  body: string;
}) {
  return (
    <a
      href={`mailto:${to}?subject=${subject}&body=${body}`}
      style={{
        textDecoration: "underline",
        color: "#2563eb",
        cursor: "pointer",
        outline: "none",
      }}
    >
      {to}
    </a>
  );
}

export function CallLink({ to }: { to: string }) {
  return (
    <a
      href={`tel:${to}`}
      style={{
        textDecoration: "underline",
        color: "#2563eb",
        cursor: "pointer",
        outline: "none",
      }}
      aria-label={`Call ${to}`}
    >
      {to}
    </a>
  );
}

export function MapLink({ address }: { address: string }) {
  const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
    address
  )}`;

  return (
    <Text fontSize="sm" color="fg.muted">
      <Link
        href={mapsUrl}
        target="_blank"
        rel="noopener noreferrer"
        color="blue.500"
        textDecoration="underline"
      >
        {address}
      </Link>
    </Text>
  );
}
