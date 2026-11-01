/**
 * Rendering a property's portfolio memberships.
 *
 * Membership used to be one column, so every card read `property.area.name`
 * and drew one badge. It is a list now, and six places were doing that
 * flattening — or rather, were about to need to. One helper, so a property
 * that is in a location portfolio AND a route shows both wherever it is
 * shown, instead of showing whichever one the API happened to put first.
 */
import { Badge } from "@chakra-ui/react";
import { Layers } from "lucide-react";

type Membership = { portfolio?: { id?: string | null; name?: string | null } | null };

/**
 * The names, from whatever the API returned.
 *
 * Tolerant on purpose: these shapes arrive as `any` through the proxy, and
 * a card quietly rendering nothing is a better failure than a card
 * throwing. An older deploy's single `portfolio` object is still read, so
 * a stale cached response does not blank the badges.
 */
export function portfolioNames(x: unknown): string[] {
  const o = x as { portfolios?: Membership[]; portfolio?: { name?: string | null } | null } | null;
  if (!o) return [];
  if (Array.isArray(o.portfolios)) {
    return o.portfolios
      .map((m) => m?.portfolio?.name)
      .filter((n): n is string => typeof n === "string" && n.length > 0);
  }
  return o.portfolio?.name ? [o.portfolio.name] : [];
}

/**
 * The badges for one property.
 *
 * Renders nothing when it belongs to none, and that absence is
 * INFORMATION: such a property is invisible to every portfolio-scoped
 * reader and counts toward no rollup.
 *
 * LAYERS, NOT A PIN. It was a map pin, on the argument that a portfolio is
 * usually somewhere and a pin reads geographically at a glance. Two things
 * made that wrong. `Layers` is now the portfolio glyph everywhere else —
 * the lens chip in the header, the marker on a filtered tab — so the pin
 * was the one place the same concept wore a different icon. And a pin
 * asserts a PLACE, which a Route or a Book is not: those cut across the
 * location tree on purpose, and a property in Mike's Book was being
 * badged as though the Book were a location.
 */
export function PortfolioBadges({ of }: { of: unknown }) {
  const names = portfolioNames(of);
  if (names.length === 0) return null;
  return (
    <>
      {names.map((name) => (
        <Badge
          key={name}
          size="sm"
          variant="subtle"
          colorPalette="purple"
          flexShrink={0}
          display="inline-flex"
          alignItems="center"
          gap="1"
        >
          <Layers size={10} />
          {name}
        </Badge>
      ))}
    </>
  );
}

/** The same, joined into one line, for somewhere a badge will not fit. */
export function PortfolioNameLine({ of, prefix = "" }: { of: unknown; prefix?: string }) {
  const names = portfolioNames(of);
  if (names.length === 0) return null;
  return <>{prefix}{names.join(" · ")}</>;
}

