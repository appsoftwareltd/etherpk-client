/**
 * The [[Graph View]]'s colours, read from the app's theme tokens.
 *
 * The picture is drawn with WebGL, which cannot read CSS custom properties, so the tokens are
 * read once into plain strings and read again when the theme changes. The neutrals (background,
 * text, lines, accent) are the app's own `--gk-*` tokens. The [[Cluster]] colours are a palette
 * per theme, picked so each one stands at least 3:1 against that theme's background, which is
 * what WCAG asks of a graphic that carries meaning.
 */

export interface MapColours {
    background: string
    /** Label text. Drawn on a plate of the background colour, so it keeps its contrast over lines. */
    label: string
    labelPlate: string
    /** Journal entries and dots in no Cluster. */
    muted: string
    /** The local copy: one line from the centre, and further out. */
    near: string
    far: string
    line: string
    /** A line drawn by a scope in a page's own name. */
    scopeLine: string
    /** Lines and dots set back while something else is picked out. */
    faded: string
    accent: string
    /** The Cluster palette, biggest Cluster first. */
    clusters: readonly string[]
    /** The font labels are drawn in: the app's sans. */
    font: string
}

const LIGHT_CLUSTERS = [
    '#2563eb', '#db2777', '#059669', '#d97706', '#7c3aed', '#0891b2',
    '#dc2626', '#4d7c0f', '#c026d3', '#c2410c', '#0d9488', '#6366f1',
] as const
const DARK_CLUSTERS = [
    '#60a5fa', '#f472b6', '#34d399', '#fbbf24', '#a78bfa', '#22d3ee',
    '#f87171', '#a3e635', '#e879f9', '#fb923c', '#2dd4bf', '#818cf8',
] as const

/** Build the colours from a token reader, so they can be tested without a stylesheet. */
export function mapColours(read: (token: string) => string, theme: { dark: boolean; font: string }): MapColours {
    const token = (name: string, fallback: string) => read(name).trim() || fallback
    const background = token('--gk-surface-0', theme.dark ? '#18181b' : '#ffffff')
    const text = token('--gk-text-default', theme.dark ? '#d4d4d8' : '#374151')
    const subtle = token('--gk-text-subtle', theme.dark ? '#8e8e97' : '#5f6672')
    const accent = token('--gk-accent', theme.dark ? '#5ab3ff' : '#0a66c2')
    return {
        background,
        label: text,
        labelPlate: withAlpha(background, 0.88),
        muted: subtle,
        near: text,
        far: subtle,
        line: blend(subtle, background, theme.dark ? 0.42 : 0.36),
        scopeLine: blend(accent, background, 0.55),
        faded: blend(subtle, background, 0.16),
        accent,
        clusters: theme.dark ? DARK_CLUSTERS : LIGHT_CLUSTERS,
        font: theme.font,
    }
}

/**
 * The colours for the theme showing now, `dark` as the extension context reports it. The `--gk-*`
 * tokens are part of the Extension API, read from the page's root where the Client defines them.
 * Browser only.
 */
export function readMapColours(dark: boolean): MapColours {
    const style = getComputedStyle(document.documentElement)
    const font = getComputedStyle(document.body).fontFamily || 'system-ui, sans-serif'
    return mapColours((name) => style.getPropertyValue(name), { dark, font })
}

/**
 * `colour` at `alpha` opacity, as `rgba()`. Takes `#rgb`, `#rrggbb`, `rgb()` and `rgba()`. For
 * the 2D label layer only: sigma's WebGL layers composite a translucent colour wrongly (it comes
 * out washed towards white), so anything they draw goes through {@link blend} instead.
 */
export function withAlpha(colour: string, alpha: number): string {
    const channels = rgbOf(colour)
    return channels ? `rgba(${channels.join(', ')}, ${alpha})` : colour.trim()
}

/**
 * `colour` laid over `background` at `amount` (0 to 1), as one opaque `rgb()`: how a
 * translucent line would look, without asking WebGL to blend it. sigma writes colours
 * un-premultiplied into a canvas the browser composites as premultiplied, so a grey at 34%
 * opacity over a white page draws as white.
 */
export function blend(colour: string, background: string, amount: number): string {
    const top = rgbOf(colour) ?? [0, 0, 0]
    const under = rgbOf(background) ?? [255, 255, 255]
    const mixed = top.map((channel, index) => Math.round(channel * amount + under[index] * (1 - amount)))
    return `rgb(${mixed.join(', ')})`
}

function rgbOf(colour: string): [number, number, number] | null {
    const value = colour.trim()
    const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/iu.exec(value)?.[1]
    if (hex) {
        const full = hex.length === 3 ? [...hex].map((digit) => digit + digit).join('') : hex
        const [r, g, b] = [0, 2, 4].map((at) => parseInt(full.slice(at, at + 2), 16))
        return [r, g, b]
    }
    const rgb = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/iu.exec(value)
    return rgb ? [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])] : null
}
