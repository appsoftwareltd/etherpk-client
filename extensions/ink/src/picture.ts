/**
 * The picture's element tree (`svg.ts`) built with the DOM, so the widget shows the same SVG a
 * published site does without writing any markup (the Client enforces Trusted Types).
 */
import { SVG_NAMESPACE, type SvgNode } from './svg'

export function svgElement(node: SvgNode): SVGElement {
    const element = document.createElementNS(SVG_NAMESPACE, node.tag)
    for (const [name, value] of Object.entries(node.attrs)) {
        // The namespace is the element's own; as an attribute it is only for a file's reader.
        if (name !== 'xmlns') element.setAttribute(name, value)
    }
    for (const child of node.children ?? []) element.append(svgElement(child))
    return element
}
