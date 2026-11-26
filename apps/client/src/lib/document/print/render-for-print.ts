/**
 * A document's text as the HTML it prints as (ADR 0207): the publisher's own renderer, with the
 * differences paper makes. A wikilink is its words. Raw HTML is the text it is in the editor, so
 * nothing a document holds becomes markup. A block that gives no picture says what was left out.
 *
 * DOM-free. The result is untrusted markup, which `print-document.ts` sanitizes.
 */
import { withDiagramId } from '../publish/diagram-id'
import { createDocumentRenderer, type Omitted, type RendererOptions } from '../publish/markdown/render'
import { bodyOf, prerenderFences, type PublishEnvironment } from '../publish/publish'
import { extensionOfFence } from '../extension-fence'

export interface PrintableDocument {
    /** The document's name, which is its heading, and what it is called in the lines for blocks left out. */
    name: string
    /** Its whole text, frontmatter included. */
    text: string
    /**
     * The heading the print opens with, in place of the name: a [[Block View]]'s title (ADR 0209),
     * whose text is one Block of the document `name` names.
     */
    heading?: string
    /** The document the text was taken from, said under the heading: "From Garden". */
    from?: string
}

export interface PrintableHtml {
    html: string
    /** The pictures the renderer drew, by the address the HTML gives them. */
    pictures: Map<string, { bytes: Uint8Array; type: string }>
    hasMath: boolean
}

export type PrintEnvironment = Pick<PublishEnvironment, 'renderMermaid' | 'renderMap' | 'publishFence'>

const PICTURE_TYPES: Record<string, string> = { svg: 'image/svg+xml', png: 'image/png', webp: 'image/webp' }

/** The line for a block that does not print. `what` starts it, and `see` is what a person opens EtherPK for. */
const leftOut = (what: string, name: string, see: string) => `${what} not printed. Open "${name}" in EtherPK to ${see}.`

/** What is said in place of a block with no picture. */
export function omittedLine(omitted: Omitted, name: string): string {
    if (omitted.kind === 'extension') return leftOut(`Content from the ${extensionOfFence(omitted.info)} extension`, name, 'see the content')
    if (omitted.kind === 'map') return leftOut('Map', name, 'see the map')
    if (omitted.kind === 'video') return leftOut('Video', name, `watch "${omitted.name}"`)
    return leftOut('Recording', name, `listen to "${omitted.name}"`)
}

const escapeHtml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** `document` as HTML for paper, its name as the first heading. */
export async function renderForPrint(document: PrintableDocument, environment: PrintEnvironment): Promise<PrintableHtml> {
    const doc = { docId: document.name, kind: 'page' as const, concept: document.name, aliases: [], text: document.text }
    const body = bodyOf(doc)
    const options: RendererOptions = {
        resolve: () => ({ href: '', missing: false }),
        // Every reference stays as it is written, and the page finds each one's bytes by it.
        assetHref: () => null,
        wikilinksAsText: true,
        rawHtml: false,
        omitted: (what) => {
            // A recording is written within a line, where a paragraph cannot go.
            const tag = what.kind === 'video' || what.kind === 'audio' ? 'span' : 'p'
            return `<${tag} class="etherpk-print-left-out">${escapeHtml(omittedLine(what, document.name))}</${tag}>\n`
        },
    }
    const env: PublishEnvironment = {
        loadTheme: () => Promise.reject(new Error('A print has no theme')),
        // Printed black on white: a colour that tells two words apart on screen tells nothing here.
        highlightCode: async () => null,
        ...environment,
    }
    // What could not be drawn is said on the page by its own line, so the issues are not kept.
    const made = await prerenderFences([{ doc, body }], createDocumentRenderer(options), env, [], [])
    let diagrams = 0
    const rendered = createDocumentRenderer({
        ...options,
        mermaidSvg: (source) => {
            const svg = made.mermaidSvg.get(source)
            return svg === undefined ? undefined : withDiagramId(svg, `mermaid_print_${++diagrams}`)
        },
        mapPicture: (source) => {
            const picture = made.mapPictures.get(source)
            return picture && { src: picture.path, alt: picture.alt, width: picture.width, height: picture.height }
        },
        fenceOutput: (lang, code) => made.fenceOutputs.get(`${lang}\n${code}`),
    }).render(body)

    const pictures: PrintableHtml['pictures'] = new Map()
    for (const [path, bytes] of made.fencePictures) pictures.set(path, { bytes, type: PICTURE_TYPES[path.slice(path.lastIndexOf('.') + 1)] ?? 'image/png' })
    for (const { path, bytes, type } of made.mapPictures.values()) pictures.set(path, { bytes, type })
    const from = document.from === undefined ? '' : `<p class="etherpk-print-from">From ${escapeHtml(document.from)}</p>\n`
    return { html: `<h1>${escapeHtml(document.heading ?? document.name)}</h1>\n${from}${rendered.html}`, pictures, hasMath: rendered.hasMath }
}
