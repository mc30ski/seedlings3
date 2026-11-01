/**
 * THE COLOUR A PORTFOLIO IS DRAWN IN — one source, three consumers.
 *
 * The map pins, the legend above it and the grouped list all have to agree
 * about which colour means which portfolio, or the colour stops being
 * information and becomes decoration. So the assignment lives here and
 * none of them decides for itself.
 *
 * PALETTE NAMES, NEVER HEX. A literal would be the same colour in all
 * fourteen themes, which is exactly what the theming rules exist to stop.
 * Chakra publishes each palette as a CSS custom property, so a name here
 * resolves to whatever the active theme says that palette looks like.
 */

/**
 * The palettes a portfolio may be drawn in.
 *
 * Chosen for SEPARATION AT PIN SIZE, not for looks. These are seven-pixel
 * dots on a map that is itself green, grey and beige, so neighbours in the
 * list need to be far apart in hue — which is why this is an explicit
 * sequence rather than every palette Chakra ships. Two adjacent zones in
 * near-identical blues would make the map look answered when it is not.
 *
 * `gray` is deliberately absent: it reads as "disabled" everywhere else in
 * the app, and a portfolio is not.
 */
export const PORTFOLIO_PALETTES = [
  "green",
  "blue",
  "purple",
  "orange",
  "teal",
  "pink",
  "cyan",
  "red",
  "yellow",
] as const;

export type PortfolioPalette = (typeof PORTFOLIO_PALETTES)[number];

/** Anything stored that is not a known palette is treated as unset. */
export function isPortfolioPalette(x: unknown): x is PortfolioPalette {
  return typeof x === "string" && (PORTFOLIO_PALETTES as readonly string[]).includes(x);
}

/**
 * The palette for one portfolio, falling back to its position.
 *
 * NULL IN THE DATABASE MEANS AUTO, not "no colour". The map has to tell
 * ten zones apart whether or not anybody has been round to choose ten
 * colours, so an unset portfolio takes a palette from `index` — its
 * position among the ones being drawn together. Choosing a colour pins it
 * so a later reshuffle cannot move it.
 *
 * The consequence worth knowing: two AUTO portfolios can swap colours when
 * a third is added between them. That is the cost of not making colour
 * mandatory, and it is why the picker exists.
 */
export function paletteFor(
  portfolio: { color?: string | null } | null | undefined,
  index: number,
): PortfolioPalette {
  if (portfolio && isPortfolioPalette(portfolio.color)) return portfolio.color;
  return PORTFOLIO_PALETTES[index % PORTFOLIO_PALETTES.length];
}

/**
 * The concrete colour a palette resolves to RIGHT NOW, for Leaflet.
 *
 * Leaflet paints into a canvas and cannot read a CSS custom property, so
 * the token has to be read off the document and the literal handed over.
 * Returns undefined rather than a hex fallback when the token is missing:
 * a literal here would freeze one theme's palette into the code, and
 * Leaflet's own default is a better failure than the wrong colour.
 *
 * Browser only — it touches `document`.
 */
export function resolvePaletteColor(palette: PortfolioPalette): string | undefined {
  if (typeof document === "undefined") return undefined;
  return (
    getComputedStyle(document.documentElement)
      .getPropertyValue(`--chakra-colors-${palette}-solid`)
      .trim() || undefined
  );
}
