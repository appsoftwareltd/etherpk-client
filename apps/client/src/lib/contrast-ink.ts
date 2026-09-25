/**
 * Which ink to put on a background of a given colour: the graph's toolbar colour (Graph
 * Settings, ADR 0071) is any `#rrggbb` the user likes, and text painted over it has to be
 * readable whatever they picked.
 *
 * The decision uses WCAG relative luminance rather than a perceived-brightness estimate. The
 * two disagree exactly where it matters here: on the ready-made pastels the settings dialog
 * offers, the YIQ formula with its usual threshold gives white text at under 2:1, while the
 * luminance crossover puts dark ink on every one of them. Pure and Node-tested; the consumer
 * owns the actual colours through {@link DARK_INK} and {@link LIGHT_INK}.
 */

/** Ink for a light background - Tailwind's gray-950, the row text the header already uses. */
export const DARK_INK = '#030712'
/** Ink for a dark background. */
export const LIGHT_INK = '#ffffff'

/**
 * The luminance at which black and white text contrast equally against the background:
 * solving (L + 0.05) / 0.05 = 1.05 / (L + 0.05) gives L = sqrt(0.0525) - 0.05.
 */
const INK_CROSSOVER = Math.sqrt(0.0525) - 0.05

/** One sRGB channel (0-255) linearised per the WCAG definition. */
function linearChannel(value: number): number {
    const c = value / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

/**
 * WCAG 2 relative luminance of a `#rrggbb` colour, 0 for black to 1 for white. The input is
 * trusted to be the canonical form `normalizeHexColor` produces; case does not matter.
 */
export function relativeLuminance(hex: string): number {
    const r = parseInt(hex.slice(1, 3), 16)
    const g = parseInt(hex.slice(3, 5), 16)
    const b = parseInt(hex.slice(5, 7), 16)
    return 0.2126 * linearChannel(r) + 0.7152 * linearChannel(g) + 0.0722 * linearChannel(b)
}

/** The ink that contrasts better against `background`: {@link DARK_INK} or {@link LIGHT_INK}. */
export function inkFor(background: string): string {
    return relativeLuminance(background) > INK_CROSSOVER ? DARK_INK : LIGHT_INK
}
