/**
 * A reply's markdown as a tree of nodes the chat draws as DOM (ADR 0147). Extension code writes no
 * HTML under the Client's Trusted Types (ADR 0130), and a model's reply is text a stranger could
 * have steered, so it is never treated as markup:
 *
 * - raw HTML in a reply is shown as the text it is;
 * - an image is never loaded, since its address could carry graph text to another host the moment
 *   it was drawn: it becomes a link to the image that the person can choose to open;
 * - a link is kept only to a web or mail address;
 * - a `[[wikilink]]`, nested ones whole, becomes a link that opens the document, as in the editor,
 *   except inside code, where it stays text.
 *
 * markdown-it parses; this module only turns its tokens into the nodes below.
 */
import MarkdownIt, { type Token } from 'markdown-it'

export type InlineNode =
    | { kind: 'text'; text: string }
    | { kind: 'strong' | 'em' | 'del'; children: InlineNode[] }
    | { kind: 'code'; text: string }
    | { kind: 'link'; href: string; children: InlineNode[] }
    | { kind: 'wikilink'; name: string }
    | { kind: 'image-link'; href: string; alt: string }
    | { kind: 'break' }

export type BlockNode =
    | { kind: 'paragraph'; children: InlineNode[] }
    | { kind: 'heading'; level: number; children: InlineNode[] }
    | { kind: 'list'; ordered: boolean; start: number; items: BlockNode[][] }
    | { kind: 'codeblock'; lang: string; text: string }
    | { kind: 'quote'; children: BlockNode[] }
    | { kind: 'table'; head: InlineNode[][]; rows: InlineNode[][][] }
    | { kind: 'rule' }

// html: false shows raw HTML as text; linkify: false keeps plain addresses as text the person reads.
const parser = new MarkdownIt({ html: false, linkify: false })

/** Private-use characters that stand for a wikilink while markdown-it reads the rest. */
const OPEN = ''
const CLOSE = ''
const SLOT = new RegExp(`${OPEN}(\\d+)${CLOSE}`, 'g')

/**
 * Every outermost `[[…]]` in `source`, nested ones whole (`[[[[Garden]] Beds]]`), swapped for a
 * slot markdown-it reads as plain text, so its brackets are never read as link syntax.
 */
function lift(source: string): { text: string; links: string[] } {
    const links: string[] = []
    let out = ''
    let i = 0
    while (i < source.length) {
        const start = source.indexOf('[[', i)
        if (start === -1) break
        let depth = 0
        let j = start
        let end = -1
        while (j < source.length) {
            if (source.startsWith('[[', j)) {
                depth += 1
                j += 2
            } else if (source.startsWith(']]', j)) {
                depth -= 1
                j += 2
                if (depth === 0) {
                    end = j
                    break
                }
            } else if (source[j] === '\n') {
                break
            } else j += 1
        }
        if (end === -1) {
            out += source.slice(i, start + 2)
            i = start + 2
            continue
        }
        out += source.slice(i, start) + OPEN + links.length + CLOSE
        links.push(source.slice(start, end))
        i = end
    }
    return { text: out + source.slice(i), links }
}

/** Text with each slot put back as the wikilink's own text: for code, where a link stays text. */
function restore(text: string, links: readonly string[]): string {
    return text.replace(SLOT, (_, index: string) => links[Number(index)] ?? '')
}

/** Text with each slot as a wikilink node, the rest as text. */
function textNodes(text: string, links: readonly string[]): InlineNode[] {
    const out: InlineNode[] = []
    let last = 0
    for (const match of text.matchAll(SLOT)) {
        if (match.index > last) out.push({ kind: 'text', text: text.slice(last, match.index) })
        const raw = links[Number(match[1])] ?? ''
        out.push({ kind: 'wikilink', name: raw.slice(2, -2) })
        last = match.index + match[0].length
    }
    if (last < text.length) out.push({ kind: 'text', text: text.slice(last) })
    return out
}

/** Join neighbouring text nodes, so a sentence markdown-it split is one node again. */
function merged(nodes: InlineNode[]): InlineNode[] {
    const out: InlineNode[] = []
    for (const node of nodes) {
        const previous = out[out.length - 1]
        if (node.kind === 'text' && previous?.kind === 'text') previous.text += node.text
        else out.push(node)
    }
    return out
}

function safeHref(href: string): string | null {
    try {
        const url = new URL(href)
        return url.protocol === 'https:' || url.protocol === 'http:' || url.protocol === 'mailto:' ? url.href : null
    } catch {
        return null
    }
}

/** The inline nodes of one inline token's children. */
function inlineNodes(tokens: readonly Token[], links: readonly string[]): InlineNode[] {
    const root: InlineNode[] = []
    // An open element's children, or null for a link to an address that is not kept, whose label
    // goes into the element around it as plain text.
    const stack: ((InlineNode & { children: InlineNode[] }) | null)[] = []
    const add = (...nodes: InlineNode[]) => {
        const open = stack.findLast((entry) => entry !== null)
        ;(open ? open.children : root).push(...nodes)
    }
    for (const token of tokens) {
        switch (token.type) {
            case 'text':
                add(...textNodes(token.content, links))
                break
            case 'code_inline':
                add({ kind: 'code', text: restore(token.content, links) })
                break
            case 'softbreak':
                add({ kind: 'text', text: ' ' })
                break
            case 'hardbreak':
                add({ kind: 'break' })
                break
            case 'image':
                add({ kind: 'image-link', href: safeHref(String(token.attrGet('src') ?? '')) ?? '', alt: restore(token.content, links) })
                break
            case 'strong_open':
            case 'em_open':
            case 's_open': {
                const kind = token.type === 'strong_open' ? 'strong' : token.type === 'em_open' ? 'em' : 'del'
                const node = { kind, children: [] as InlineNode[] } as InlineNode & { children: InlineNode[] }
                add(node)
                stack.push(node)
                break
            }
            case 'link_open': {
                // markdown-it already refuses script and data addresses; anything that is not the
                // web or mail is kept as its label alone.
                const href = safeHref(String(token.attrGet('href') ?? ''))
                const node = href === null ? null : { kind: 'link' as const, href, children: [] as InlineNode[] }
                if (node) add(node)
                stack.push(node)
                break
            }
            case 'strong_close':
            case 'em_close':
            case 's_close':
            case 'link_close':
                stack.pop()
                break
            default:
                if (token.content) add({ kind: 'text', text: restore(token.content, links) })
        }
    }
    return merged(root)
}

/** The block nodes of a range of block tokens. */
function blockNodes(tokens: readonly Token[], links: readonly string[]): BlockNode[] {
    const out: BlockNode[] = []
    let i = 0
    const inlineAt = (index: number) => inlineNodes(tokens[index]?.children ?? [], links)
    /** The index of the token that closes the one opened at `index`. */
    const closeOf = (index: number): number => {
        let depth = 0
        for (let j = index; j < tokens.length; j += 1) {
            depth += tokens[j].nesting
            if (depth === 0) return j
        }
        return tokens.length - 1
    }
    while (i < tokens.length) {
        const token = tokens[i]
        switch (token.type) {
            case 'paragraph_open': {
                // A list item's tight paragraph is hidden, but it is still the item's text.
                out.push({ kind: 'paragraph', children: inlineAt(i + 1) })
                i = closeOf(i) + 1
                continue
            }
            case 'heading_open':
                out.push({ kind: 'heading', level: Number(token.tag.slice(1)) || 1, children: inlineAt(i + 1) })
                i = closeOf(i) + 1
                continue
            case 'fence':
            case 'code_block':
                out.push({ kind: 'codeblock', lang: token.info.trim().split(/\s+/)[0] ?? '', text: restore(token.content, links) })
                break
            case 'hr':
                out.push({ kind: 'rule' })
                break
            case 'blockquote_open': {
                const end = closeOf(i)
                out.push({ kind: 'quote', children: blockNodes(tokens.slice(i + 1, end), links) })
                i = end + 1
                continue
            }
            case 'bullet_list_open':
            case 'ordered_list_open': {
                const end = closeOf(i)
                const items: BlockNode[][] = []
                let j = i + 1
                while (j < end) {
                    if (tokens[j].type === 'list_item_open') {
                        const itemEnd = closeOf(j)
                        items.push(blockNodes(tokens.slice(j + 1, itemEnd), links))
                        j = itemEnd + 1
                    } else j += 1
                }
                const start = token.type === 'ordered_list_open' ? Number(token.attrGet('start') ?? 1) || 1 : 1
                out.push({ kind: 'list', ordered: token.type === 'ordered_list_open', start, items })
                i = end + 1
                continue
            }
            case 'table_open': {
                const end = closeOf(i)
                const head: InlineNode[][] = []
                const rows: InlineNode[][][] = []
                let inHead = false
                let row: InlineNode[][] | null = null
                for (let j = i + 1; j < end; j += 1) {
                    const cell = tokens[j]
                    if (cell.type === 'thead_open') inHead = true
                    else if (cell.type === 'thead_close') inHead = false
                    else if (cell.type === 'tr_open') row = []
                    else if (cell.type === 'tr_close' && row) {
                        if (inHead) head.push(...row)
                        else rows.push(row)
                        row = null
                    } else if ((cell.type === 'th_open' || cell.type === 'td_open') && row) row.push(inlineAt(j + 1))
                }
                out.push({ kind: 'table', head, rows })
                i = end + 1
                continue
            }
            case 'inline':
                out.push({ kind: 'paragraph', children: inlineAt(i) })
                break
        }
        i += 1
    }
    return out
}

export function renderTree(markdown: string): BlockNode[] {
    const { text, links } = lift(markdown.replace(/\r\n?/g, '\n'))
    return blockNodes(parser.parse(text, {}), links)
}
