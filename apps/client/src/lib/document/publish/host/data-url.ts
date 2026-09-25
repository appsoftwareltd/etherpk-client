/**
 * The bytes of a `data:` url, decoded in place rather than fetched. Vite inlines any asset
 * under its size limit as a `data:` url, and `fetch` of one is a connection as far as the
 * Content Security Policy is concerned: `connect-src 'self'` refuses it, which is how the
 * smallest KaTeX fonts broke every publish and theme preview on a deployed Client while dev,
 * with no policy, sailed through. Decoding needs no connection at all.
 */

/** Null for anything that is not a `data:` url; the decoded payload otherwise. */
export function decodeDataUrl(url: string): Uint8Array | null {
    if (!url.startsWith('data:')) return null
    const comma = url.indexOf(',')
    if (comma === -1) throw new Error('The data url has no payload.')
    const meta = url.slice(5, comma)
    const payload = url.slice(comma + 1)
    if (/;base64$/i.test(meta)) {
        const binary = atob(payload)
        const out = new Uint8Array(binary.length)
        for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
        return out
    }
    return new TextEncoder().encode(decodeURIComponent(payload))
}
