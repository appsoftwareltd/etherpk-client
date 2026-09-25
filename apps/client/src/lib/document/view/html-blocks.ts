/**
 * The [[Rich Paste]] converter (CONTEXT.md; ADR 0090; plan `2026-09-22 Rich Paste.md`): the HTML a
 * clipboard carries beside its plain text, read as a tree of blocks the editor can write, and the
 * two ways of writing that tree - as an outline into a [[Block]], or as flat markdown into prose.
 *
 * Pure over a DOM `Document`: the browser's `DOMParser` supplies one for free, `linkedom`'s in the
 * Node rows (`html-blocks.test.ts`). The mapping is the table in the plan; the rules that decide
 * shape are stated where they run.
 *
 * What comes out is text on the [[Indent Unit]] grid that the paste filter (`paste-clamp.ts`) lands
 * as any pasted tree: a heading owns its section only in the outline, since a page of prose is flat
 * prose; a list nests either way; a table, a code block and a quote are one block with continuation
 * lines. Every image the selection carried is reported alongside, with the exact source string
 * written into the text, so the upload half (`remote-image-upload.ts`) can fetch it and find its
 * reference again.
 */

/** One block of a converted selection. */
export interface HtmlBlock {
    /**
     * `text` for a paragraph, heading, quote, table, code block or image; `item` for a list item.
     * The outline writer bullets both; the markdown writer keeps `text` flat and bullets `item`.
     */
    kind: 'text' | 'item'
    /** The block's own lines: the first is its text, the rest its continuation lines. Never empty. */
    lines: string[]
    /** Nested list items under a list item; the section under a heading once nested. */
    children: HtmlBlock[]
    /** A heading's level, 1-6; the outline nests what follows a heading under it. */
    heading?: number
}

/** An image the converter wrote into the text, as the upload half needs to see it. */
export interface PastedImage {
    /** The source written into the markdown, exactly, so the reference can be found again. */
    src: string
    alt: string
}

export interface HtmlConversion {
    blocks: HtmlBlock[]
    images: PastedImage[]
}

export interface HtmlBlocksOptions {
    /** The [[Display Size]] hint every image reference carries (the graph's default), or none. */
    displaySize?: string
}

/** An `<img>` narrower or shorter than this by its own attributes is decoration (an icon, a pixel), not content. */
export const TINY_IMAGE_PX = 32
/** A `data:` image larger than this stays out of the text: a document line is no place for megabytes. */
export const MAX_DATA_URL_LENGTH = 256 * 1024

/** Elements whose content is never part of a selection's meaning. */
const DROPPED = new Set([
    'script', 'style', 'noscript', 'template', 'svg', 'iframe', 'nav', 'button', 'input', 'select', 'textarea',
    'option', 'canvas', 'video', 'audio', 'object', 'embed', 'head', 'title', 'meta', 'link', 'map', 'area', 'source', 'track',
])
/** Block-level containers: their content flows into the surrounding list, a container edge ending a paragraph. */
const CONTAINERS = new Set([
    'div', 'p', 'section', 'article', 'main', 'aside', 'header', 'footer', 'details', 'summary', 'dl', 'dt', 'dd',
    'form', 'fieldset', 'address', 'body', 'html', 'center', 'li', 'tr', 'td', 'th', 'thead', 'tbody', 'tfoot', 'caption',
])
/** Hyperlink schemes the editor opens (CONTEXT.md → Hyperlink). Anything else is its text. */
const LINK_SCHEMES = new Set(['http:', 'https:', 'mailto:', 'tel:', 'ftp:'])
/** Image schemes the paste writes: the two the browser might read, and no other. */
const IMAGE_SCHEMES = new Set(['http:', 'https:', 'data:'])

interface Ctx {
    images: PastedImage[]
    displaySize?: string
    /** The address relative sources resolve against: the document's `<base href>`, or nothing. */
    base: string | null
}

/**
 * The paragraph being gathered while inline content flows: text parts and images, in order. An
 * image inside a paragraph goes on its own line inside the paragraph's block, where drag-and-drop
 * puts an image dropped mid-line; a paragraph that is only images is a block per image.
 */
class Collector {
    readonly out: HtmlBlock[] = []
    private parts: (string | { image: string })[] = []
    private current = ''

    /** `altOnly`: images contribute their alt text and are recorded nowhere (a table cell, a caption). */
    constructor(readonly altOnly = false) {}

    text(s: string): void {
        // HTML whitespace: a run is one space, a no-break space included, a newline in a paragraph is a space.
        this.current += s.replace(/[\s\u00a0]+/g, ' ')
    }

    /**
     * The text appended to the current part by `walk`, transformed in place: how a mark or a link wraps
     * its content. False when the walk left the part (an image, a block inside): the text is then as
     * the walk left it, and the caller may wrap the blocks instead.
     */
    capture(walk: () => void, transform: (inner: string) => string): boolean {
        const partsBefore = this.parts.length
        const blocksBefore = this.out.length
        const before = this.current.length
        walk()
        if (this.parts.length !== partsBefore || this.out.length !== blocksBefore) return false
        const added = this.current.slice(before)
        this.current = this.current.slice(0, before) + transform(added)
        return true
    }

    softBreak(): void {
        this.parts.push(this.current)
        this.current = ''
    }

    image(src: string): void {
        this.parts.push(this.current, { image: src })
        this.current = ''
    }

    /** End the paragraph: its lines become one block, or one block per image when there is no text. */
    flush(): void {
        const parts = [...this.parts, this.current]
        this.parts = []
        this.current = ''
        const lines: string[] = []
        let hasText = false
        for (const part of parts) {
            if (typeof part === 'string') {
                const text = part.replace(/ {2,}/g, ' ').trim()
                if (text === '') continue
                lines.push(text)
                hasText = true
            } else lines.push(part.image)
        }
        if (lines.length === 0) return
        if (hasText) this.out.push({ kind: 'text', lines, children: [] })
        else for (const line of lines) this.out.push({ kind: 'text', lines: [line], children: [] })
    }
}

function isElement(node: Node): node is Element {
    return node.nodeType === 1
}

function tagOf(el: Element): string {
    return el.tagName.toLowerCase()
}

function hidden(el: Element): boolean {
    if (el.hasAttribute('hidden')) return true
    const style = el.getAttribute('style') ?? ''
    return /display\s*:\s*none/i.test(style)
}

/** A url made absolute against the base, or null when it cannot be (a relative address with no base). */
function resolve(href: string, base: string | null): URL | null {
    try {
        return base ? new URL(href, base) : new URL(href)
    } catch {
        return null
    }
}

/** A hyperlink target the editor opens, made absolute; null for a fragment, an unsafe scheme or an unresolvable address. */
function linkTarget(href: string, base: string | null): string | null {
    const trimmed = href.trim()
    if (trimmed === '' || trimmed.startsWith('#')) return null
    const url = resolve(trimmed, base)
    if (!url || !LINK_SCHEMES.has(url.protocol)) return null
    return encodeParens(url.href)
}

/** Parentheses in a target are percent-encoded so the reference syntax `[text](url)` survives them. */
function encodeParens(href: string): string {
    return href.replace(/\(/g, '%28').replace(/\)/g, '%29')
}

/** The largest candidate of a `srcset`, or null when there is none to read. */
function largestSrcsetCandidate(srcset: string): string | null {
    let best: { url: string; size: number } | null = null
    for (const entry of srcset.split(',')) {
        const [url, descriptor] = entry.trim().split(/\s+/, 2)
        if (!url) continue
        const size = descriptor ? parseFloat(descriptor) : 1
        // Width descriptors outrank density ones: a `1600w` is a bigger picture than a `2x`.
        const weight = descriptor?.endsWith('w') ? size : size * 1000
        if (!best || weight > best.size) best = { url, size: weight }
    }
    return best?.url ?? null
}

function declaredSize(el: Element, name: 'width' | 'height'): number | null {
    const attr = el.getAttribute(name)
    if (attr && /^\s*\d+(\.\d+)?\s*(px)?\s*$/.test(attr)) return parseFloat(attr)
    const style = el.getAttribute('style') ?? ''
    const m = new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*(\\d+(?:\\.\\d+)?)px`, 'i').exec(style)
    return m ? parseFloat(m[1]) : null
}

/** The image's source as the text will carry it, or null when the image is dropped (tiny, unresolvable, a scheme the browser never reads). */
function imageSource(el: Element, base: string | null): string | null {
    const width = declaredSize(el, 'width')
    const height = declaredSize(el, 'height')
    if ((width !== null && width < TINY_IMAGE_PX) || (height !== null && height < TINY_IMAGE_PX)) return null
    const srcset = el.getAttribute('srcset')
    const candidate = (srcset && largestSrcsetCandidate(srcset)) || el.getAttribute('src') || ''
    if (candidate.trim() === '') return null
    const url = resolve(candidate.trim(), base) ?? (candidate !== el.getAttribute('src') ? resolve((el.getAttribute('src') ?? '').trim(), base) : null)
    if (!url || !IMAGE_SCHEMES.has(url.protocol)) return null
    if (url.protocol === 'data:') {
        if (!url.href.startsWith('data:image/') || url.href.length > MAX_DATA_URL_LENGTH) return null
        return url.href
    }
    return encodeParens(url.href)
}

/** Alt text that survives the reference syntax: one line, no brackets, no `|` (which would read as a size hint). */
function altText(el: Element): string {
    const raw = el.getAttribute('alt') || el.getAttribute('title') || ''
    return raw.replace(/[[\]|]/g, '').replace(/[\s\u00a0]+/g, ' ').trim()
}

function imageLine(src: string, alt: string, ctx: Ctx): string {
    ctx.images.push({ src, alt })
    return `![${ctx.displaySize ? `${alt}|${ctx.displaySize}` : alt}](${src})`
}

/** Wrap inline content in a mark, the way CommonMark wants it: no whitespace just inside the markers. */
function wrap(inner: string, mark: string): string {
    const core = inner.trim()
    if (core === '') return inner
    const lead = inner.slice(0, inner.length - inner.trimStart().length)
    const trail = inner.slice(inner.trimEnd().length)
    return `${lead}${mark}${core}${mark}${trail}`
}

/** Google Docs writes its whole selection inside a `<b style="font-weight:normal">`: bold that is not bold. */
function boldInName(el: Element): boolean {
    return !/font-weight\s*:\s*(normal|400)/i.test(el.getAttribute('style') ?? '')
}

/** The code inside a `<pre>`, verbatim: the one place whitespace is content. */
function codeText(el: Element): string {
    const text = (el.textContent ?? '').replace(/\r\n?/g, '\n')
    return text.replace(/^\n/, '').replace(/\n$/, '')
}

function codeLanguage(el: Element): string {
    const code = el.querySelector('code')
    for (const cls of [...(el.getAttribute('class') ?? '').split(/\s+/), ...(code?.getAttribute('class') ?? '').split(/\s+/)]) {
        const m = /^(?:language|lang)-([\w#+-]+)$/.exec(cls)
        if (m) return m[1]
    }
    return ''
}

/** A cell's text as a GFM table can carry it: no `|` unescaped, no line break. */
function escapeTableCell(text: string): string {
    return text.replace(/\s*\n\s*/g, ' ').replace(/\|/g, '\\|').trim()
}

/** Every line of a tree, depth first: what a cell or a caption reads as when it must be one line. */
function allLines(blocks: readonly HtmlBlock[]): string[] {
    return blocks.flatMap((b) => [...b.lines, ...allLines(b.children)])
}

/** The inline text of an element as one line: a table cell, a caption. Images inside it are their alt, and are not recorded. */
function oneLine(el: Element, ctx: Ctx): string {
    const col = new Collector(true)
    walkChildren(el, col, ctx)
    col.flush()
    return allLines(col.out).join(' ').replace(/ {2,}/g, ' ').trim()
}

function tableBlock(el: Element, ctx: Ctx): HtmlBlock | null {
    const rows: string[][] = []
    let headerFromTh = false
    for (const tr of el.querySelectorAll('tr')) {
        // A nested table's rows are its own; only rows of this table.
        if (tr.closest('table') !== el) continue
        const cells = [...tr.children].filter((c) => isElement(c) && (tagOf(c) === 'td' || tagOf(c) === 'th'))
        if (cells.length === 0) continue
        if (rows.length === 0 && cells.every((c) => tagOf(c) === 'th')) headerFromTh = true
        rows.push(cells.map((c) => escapeTableCell(oneLine(c, ctx))))
    }
    if (rows.length === 0) return null
    const width = Math.max(...rows.map((r) => r.length))
    const pad = (r: string[]) => [...r, ...Array<string>(width - r.length).fill('')]
    const line = (r: string[]) => `| ${pad(r).join(' | ')} |`
    const [header, ...body] = rows
    void headerFromTh // the first row is the header either way: GFM needs one
    return { kind: 'text', lines: [line(header), `| ${Array<string>(width).fill('---').join(' | ')} |`, ...body.map(line)], children: [] }
}

function listItems(list: Element, ctx: Ctx): HtmlBlock[] {
    const ordered = tagOf(list) === 'ol'
    let n = ordered ? parseInt(list.getAttribute('start') ?? '1', 10) || 1 : 0
    const items: HtmlBlock[] = []
    for (const child of list.children) {
        if (!isElement(child) || tagOf(child) !== 'li' || hidden(child)) continue
        const sub = new Collector()
        walkChildren(child, sub, ctx)
        sub.flush()
        const [first, ...rest] = sub.out
        // An `<ol>` item keeps its number as text: the outliner has no ordered node (the Import rule for
        // a construct with no equivalent), and dropping the number would lose what the reader saw.
        const prefix = ordered ? `${n++}. ` : ''
        // The item's own text is its first paragraph; an item that is only a nested list is an empty
        // bullet over the list, not the first nested item promoted.
        const own: HtmlBlock =
            first && first.kind === 'text'
                ? { kind: 'item', lines: [prefix + first.lines[0], ...first.lines.slice(1)], children: [...first.children, ...rest] }
                : { kind: 'item', lines: [prefix.trim()], children: sub.out }
        items.push(own)
    }
    return items
}

function figureBlock(el: Element, ctx: Ctx): HtmlBlock | null {
    const img = el.querySelector('img')
    if (!img) return null
    const src = imageSource(img, ctx.base)
    const caption = el.querySelector('figcaption')
    const captionText = caption ? oneLine(caption, ctx) : ''
    const lines: string[] = []
    if (src) lines.push(imageLine(src, altText(img), ctx))
    else if (altText(img)) lines.push(altText(img))
    if (captionText) lines.push(captionText)
    return lines.length ? { kind: 'text', lines, children: [] } : null
}

function walkChildren(el: Node, col: Collector, ctx: Ctx): void {
    for (const child of el.childNodes) walkNode(child, col, ctx)
}

function walkNode(node: Node, col: Collector, ctx: Ctx): void {
    if (node.nodeType === 3) {
        col.text((node as Text).data)
        return
    }
    if (!isElement(node)) return
    const el = node
    const tag = tagOf(el)
    if (DROPPED.has(tag) || hidden(el)) return
    const heading = /^h([1-6])$/.exec(tag)
    if (heading) {
        col.flush()
        const sub = new Collector()
        walkChildren(el, sub, ctx)
        sub.flush()
        // An image inside a heading goes after the heading's line: a reference in heading text is never an
        // image line, and would neither render nor be found again by the upload.
        const lines = sub.out.flatMap((b) => b.lines)
        const isImage = (line: string) => /^!\[[^\]]*\]\([^)]*\)$/.test(line)
        const texts = lines.filter((line) => !isImage(line))
        const images = lines.filter(isImage)
        if (lines.length === 0) return
        const level = Number(heading[1])
        if (texts.length === 0) {
            for (const image of images) col.out.push({ kind: 'text', lines: [image], children: [] })
            return
        }
        col.out.push({ kind: 'text', lines: [`${'#'.repeat(level)} ${texts.join(' ')}`, ...images], children: [], heading: level })
        return
    }
    switch (tag) {
        case 'br':
            col.softBreak()
            return
        case 'hr':
            col.flush()
            return
        case 'img': {
            const src = col.altOnly ? null : imageSource(el, ctx.base)
            if (src) col.image(imageLine(src, altText(el), ctx))
            else if (altText(el)) col.text(` ${altText(el)} `)
            return
        }
        case 'ul':
        case 'ol':
            col.flush()
            col.out.push(...listItems(el, ctx))
            return
        case 'pre': {
            col.flush()
            const code = codeText(el)
            // The fence must outrun any backtick run in the code, or a line of the code closes it.
            const longest = (code.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 0)
            const fence = '`'.repeat(Math.max(3, longest + 1))
            col.out.push({ kind: 'text', lines: [fence + codeLanguage(el), ...code.split('\n'), fence], children: [] })
            return
        }
        case 'table': {
            col.flush()
            const block = tableBlock(el, ctx)
            if (block) col.out.push(block)
            return
        }
        case 'blockquote': {
            col.flush()
            const sub = new Collector()
            walkChildren(el, sub, ctx)
            sub.flush()
            const inner = blocksAsMarkdown(sub.out)
            if (inner.trim() === '') return
            col.out.push({ kind: 'text', lines: inner.split('\n').map((l) => (l === '' ? '>' : `> ${l}`)), children: [] })
            return
        }
        case 'figure': {
            col.flush()
            const block = figureBlock(el, ctx)
            if (block) col.out.push(block)
            else walkChildren(el, col, ctx)
            col.flush()
            return
        }
        case 'a': {
            const href = el.getAttribute('href')
            const target = href ? linkTarget(href, ctx.base) : null
            if (!target) {
                walkChildren(el, col, ctx)
                return
            }
            const blocksBefore = col.out.length
            const applied = col.capture(
                () => walkChildren(el, col, ctx),
                (inner) => (inner.trim() === '' ? inner : `[${inner.trim()}](${target})`),
            )
            if (applied) return
            // Block content inside the link (a card: a heading and a summary): each block's first line is
            // linked; an image line is left as it is, since the image is the content.
            for (const block of col.out.slice(blocksBefore)) {
                const [first, ...rest] = block.lines
                if (/^!\[[^\]]*\]\([^)]*\)$/.test(first)) continue
                const heading = /^(#{1,6} )(.*)$/.exec(first)
                block.lines = heading ? [`${heading[1]}[${heading[2]}](${target})`, ...rest] : [`[${first}](${target})`, ...rest]
            }
            return
        }
        case 'strong':
        case 'b':
            if (!boldInName(el)) {
                walkChildren(el, col, ctx)
                return
            }
            col.capture(() => walkChildren(el, col, ctx), (inner) => wrap(inner, '**'))
            return
        case 'em':
        case 'i':
            col.capture(() => walkChildren(el, col, ctx), (inner) => wrap(inner, '*'))
            return
        case 'code':
        case 'kbd':
        case 'samp':
            col.capture(() => walkChildren(el, col, ctx), (inner) => (inner.trim() === '' ? inner : '`' + inner.trim() + '`'))
            return
        case 's':
        case 'del':
        case 'strike':
            col.capture(() => walkChildren(el, col, ctx), (inner) => wrap(inner, '~~'))
            return
        case 'mark':
            col.capture(() => walkChildren(el, col, ctx), (inner) => wrap(inner, '=='))
            return
        default:
            if (CONTAINERS.has(tag)) {
                col.flush()
                walkChildren(el, col, ctx)
                col.flush()
            } else {
                // Anything else (`span`, `u`, `sub`, `time`, a custom element) is its content.
                walkChildren(el, col, ctx)
            }
    }
}

/** The selection's HTML as blocks: lists nested, sections flat (the outline writer nests them). */
export function htmlToBlocks(doc: Document, options: HtmlBlocksOptions = {}): HtmlConversion {
    const base = doc.querySelector('base[href]')?.getAttribute('href') ?? null
    const ctx: Ctx = { images: [], displaySize: options.displaySize, base: base && resolve(base, null) ? base : null }
    const col = new Collector()
    // From the document itself, not its body: `html` and `body` are containers and `head` is dropped,
    // so the walk finds the content wherever the parser hung it (linkedom puts a bare fragment's
    // nodes straight under the document, and Chrome's wrapper starts with a <meta> before <html>).
    walkChildren(doc, col, ctx)
    col.flush()
    return { blocks: col.out, images: ctx.images }
}

/**
 * A heading owns its section: every block after it, through to the next heading of the same or a
 * higher level, becomes its child. Lists already nest under the paragraph before them by the paste
 * rule; here a paragraph nests under its heading, so the paste reads as an outline of the page.
 */
export function nestSections(blocks: readonly HtmlBlock[]): HtmlBlock[] {
    const out: HtmlBlock[] = []
    const open: { level: number; block: HtmlBlock }[] = []
    for (const block of blocks) {
        const copy: HtmlBlock = { ...block, children: [...block.children] }
        if (copy.heading) while (open.length && open[open.length - 1].level >= copy.heading) open.pop()
        const parent = open.length ? open[open.length - 1].block : null
        ;(parent ? parent.children : out).push(copy)
        if (copy.heading) open.push({ level: copy.heading, block: copy })
    }
    return out
}

/**
 * A list nests under the text block before it: the paragraph that introduces a list owns it, as the
 * block-per-line paste rule reads a bullet after a prose line (ADR 0089). Applied to every sibling
 * list in the tree, so a list inside a section nests under the section's paragraph, not its heading.
 */
function nestListsUnderText(blocks: readonly HtmlBlock[]): HtmlBlock[] {
    const out: HtmlBlock[] = []
    let last: HtmlBlock | null = null
    for (const block of blocks) {
        const copy: HtmlBlock = { ...block, children: nestListsUnderText(block.children) }
        if (copy.kind === 'item' && last) last.children.push(copy)
        else {
            out.push(copy)
            last = copy.kind === 'text' ? copy : null
        }
    }
    return out
}

/** The tree as an outline: every block a bullet, continuation lines at the content column, sections and lists nested. */
export function blocksAsOutline(blocks: readonly HtmlBlock[]): string {
    const lines: string[] = []
    const write = (block: HtmlBlock, depth: number) => {
        const pad = ' '.repeat(depth * 2)
        lines.push(`${pad}- ${block.lines[0]}`)
        for (const line of block.lines.slice(1)) lines.push(`${pad}  ${line}`)
        for (const child of block.children) write(child, depth + 1)
    }
    for (const block of nestListsUnderText(nestSections(blocks))) write(block, 0)
    return lines.join('\n')
}

/** The tree as flat markdown: paragraphs apart, list items bulleted and nested, sections left flat. */
export function blocksAsMarkdown(blocks: readonly HtmlBlock[]): string {
    const out: string[] = []
    const writeItems = (items: readonly HtmlBlock[], depth: number) => {
        for (const item of items) {
            const pad = ' '.repeat(depth * 2)
            out.push(`${pad}- ${item.lines[0]}`)
            for (const line of item.lines.slice(1)) out.push(`${pad}  ${line}`)
            writeItems(item.children, depth + 1)
        }
    }
    let previous: HtmlBlock['kind'] | null = null
    for (const block of blocks) {
        if (block.kind === 'item') {
            if (out.length && previous !== 'item') out.push('')
            writeItems([block], 0)
        } else {
            if (out.length) out.push('')
            out.push(...block.lines)
            if (block.children.length) writeItems(block.children, 0)
        }
        previous = block.kind
    }
    return out.join('\n')
}
