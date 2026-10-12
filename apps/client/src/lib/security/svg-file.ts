/**
 * An SVG file an extension made for a published site (the picture a fence's `publish` returns),
 * cleaned before it is written into the site. A browser that opens a site's `.svg` file directly
 * runs any script in it, in the site's origin, and the site is served wherever its owner hosts it,
 * with no CSP of ours. So the file keeps only what DOMPurify's SVG profile allows: no script, no
 * event handler, no `javascript:` link and no HTML. Its `<style>` stays, since a drawing declares its
 * fonts there.
 *
 * Written out with `XMLSerializer` rather than as HTML: an SVG file is XML, which has no `&nbsp;`
 * and needs its namespace declared.
 */
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
