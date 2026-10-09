/**
 * A basemap's credit as plain text, for a picture of a map, which draws it on a canvas. Sources
 * give their credit as HTML (`<a href="…">© OpenStreetMap</a>`). An extension writes no HTML to the
 * page (Trusted Types, ADR 0130), so the text is read off the markup here instead of parsed from it.
 */
export function attributionText(html: string): string {
    return html
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<\/?[a-zA-Z][^>]*>/g, '')
        .replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (reference, name: string) => characterFor(name) ?? reference)
        .replace(/\s+/g, ' ')
        .trim()
}

/** The named references credits are written with; any other name stays as it was written. */
const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®' }

function characterFor(name: string): string | undefined {
    if (name.startsWith('#')) {
        const code = name[1] === 'x' || name[1] === 'X' ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10)
        return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : undefined
    }
    return NAMED[name]
}
