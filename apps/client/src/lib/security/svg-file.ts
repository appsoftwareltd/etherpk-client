/**
 * An SVG file an extension made for a published site (the picture a fence's `publish` returns),
 * cleaned before it is written into the site. A browser that opens a site's `.svg` file directly
 * runs any script in it, in the site's origin, and the site is served wherever its owner hosts it,
 * with no CSP of ours. So the file keeps only what DOMPurify's SVG profile allows: no script, no
 * event handler, no `javascript:` link and no HTML. Its `<style>` stays, since a drawing declares its
 * fonts there.
 *
 * The picture a fence's `quote` returns is cleaned the same way. The Backlinks panel shows it as an
 * image, where nothing in it runs, but a person can open that image in a tab of its own.
 *
 * Written out with `XMLSerializer` rather than as HTML: an SVG file is XML, which has no `&nbsp;`
 * and needs its namespace declared.
 */
import type { PublishedFence } from '@appsoftwareltd/etherpk-extension-api'
import DOMPurify from 'dompurify'

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg'

/**
 * The SVG cleaned, or null when it cannot be: there is no DOM to clean it against (Node), or nothing
 * in it is an SVG element. The caller publishes nothing for null, so an SVG is never published as it
 * came.
 */
export function cleanedSvgFile(svg: string): string | null {
    if (!DOMPurify.isSupported) return null
    const fragment = DOMPurify.sanitize(svg, {
        USE_PROFILES: { svg: true, svgFilters: true },
        ADD_TAGS: ['style'],
        RETURN_DOM_FRAGMENT: true,
    })
    const root = fragment.firstElementChild
    if (!root || root.namespaceURI !== SVG_NAMESPACE || root.localName !== 'svg') return null
    return new XMLSerializer().serializeToString(root)
}

/**
 * What an extension answered for a fence (a registration's `publish` or `quote`), with an SVG picture
 * cleaned, and any other answer as it is: its caller checks the rest. Throws when an SVG picture
 * cannot be cleaned, so one is never used as it came.
 */
export function cleanedFencePicture(out: PublishedFence | null): PublishedFence | null {
    if (out?.kind !== 'picture' || out.type !== 'image/svg+xml' || !(out.bytes instanceof Uint8Array)) return out
    const svg = cleanedSvgFile(new TextDecoder().decode(out.bytes))
    if (svg === null) throw new Error('its picture is not an SVG file the Client could check')
    return { ...out, bytes: new TextEncoder().encode(svg) }
}
