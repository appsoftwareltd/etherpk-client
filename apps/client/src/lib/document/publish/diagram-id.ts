/**
 * Renaming a drawn Mermaid diagram's id, so a published page can carry it.
 *
 * Mermaid renders a diagram under the id it is given and scopes everything else to that id: every
 * rule of its inline `<style>` (`#gk-mermaid-4 .node rect { fill: … }`), its marker definitions
 * (`gk-mermaid-4_flowchart-pointEnd`) and the `url(#…)` references to them, and its accessible
 * title and description ids. The published `<svg>` must keep an id its styles match; without one
 * no rule applies and every node rect takes SVG's default black fill.
 *
 * The host's own id is not good enough to keep as it is. It comes from a render counter, so it
 * changes from one publish to the next (and the browser host reuses the editor's cached drawings),
 * which would rewrite every page with a diagram on every publish; and one drawing is reused for
 * every occurrence of the same source, so a diagram shown twice on a page would put one id there
 * twice. The publisher therefore renames each occurrence to an id of its own choosing.
 */

/** The root element's id, or null. Only the opening tag is read. */
function rootId(svg: string): string | null {
    const open = /^\s*<svg\b[^>]*>/.exec(svg)?.[0]
    if (!open) return null
    return /\sid="([^"]+)"/.exec(open)?.[1] ?? null
}

/** The id the inline styles are scoped to, for a drawing whose root has lost its id. */
function styleScope(svg: string): string | null {
    const style = /<style\b[^>]*>([\s\S]*?)<\/style>/.exec(svg)?.[1]
    if (!style) return null
    // A selector, not a colour: `#ECECFF` is followed by `;` or `}`, a selector by `{` or a space.
    return /#([A-Za-z][\w-]*)(?=[\s{.,>:])/.exec(style)?.[1] ?? null
}

function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * The drawing with its id, and everything scoped to it, renamed to `id`. `id` must be a valid
 * CSS identifier that starts with a letter. A drawing with no id anywhere is returned as it is:
 * nothing in it is scoped, so there is nothing to keep in step.
 */
export function withDiagramId(svg: string, id: string): string {
    const current = rootId(svg)
    if (current) {
        // Not followed by a letter or digit: `gk-mermaid-4` must not match inside `gk-mermaid-41`.
        // Mermaid's derived names follow the id with `_` or a quote, and those are renamed too.
        return svg.replace(new RegExp(`${escapeRegExp(current)}(?![A-Za-z0-9])`, 'g'), id)
    }
    const scope = styleScope(svg)
    if (!scope) return svg
    const renamed = svg.replace(new RegExp(`${escapeRegExp(scope)}(?![A-Za-z0-9])`, 'g'), id)
    return renamed.replace(/^(\s*<svg\b)/, `$1 id="${id}"`)
}
