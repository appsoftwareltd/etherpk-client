/**
 * What a Save writes (ADR 0147): the turns the person kept, as ordinary outline blocks, so they are
 * searched, their links count and they publish like anything else in the document. Nothing marks
 * them as a chat, so a saved chat is never reopened from the document: to go on, the person starts
 * a chat with "This document", which then holds the saved turns.
 *
 * ```markdown
 * - **Agent Chat with Fake Model on 2026-10-15**
 *   - What should I plant beside the beans?
 *     - Marigolds, as your [[Garden]] notes suggest.
 * ```
 *
 * A question kept with its answer is a bullet with the answer beneath it. An answer kept without
 * its question goes straight under the header, and a question kept alone is a bullet on its own.
 *
 * The indent is two spaces a level, and the only bullet is `- `, as the outliner reads them. The
 * block lands by the rule a block put at the caret follows (block-insert.ts), shifted to the line's
 * own column by the Client.
 */
import MarkdownIt, { type Token } from 'markdown-it'

import { questionText, type Exchange } from '../chat/model'

const parser = new MarkdownIt()

/** Two spaces: one outline level. */
const LEVEL = '  '

/**
 * A line of a block that is blank but still the block's own: written at the block's content
 * column, never bare, since a bare blank line ends every branch it sits in (Editor Content Rules,
 * a blank line sits at its block's content column).
 */
const SOFT_BLANK = Symbol('blank line inside a block')

/** A line of an outline block. An empty string is a blank line inside a fence, which stays bare. */
type BlockLine = string | typeof SOFT_BLANK

/**
 * One block of the outline a Save writes: its own lines, the first on its bullet and the rest
 * continuation lines at the bullet's content column, and the blocks nested under it.
 */
interface OutlineBlock {
    kind: 'text' | 'heading' | 'code' | 'table' | 'quote' | 'rule' | 'item'
    lines: BlockLine[]
    children: OutlineBlock[]
}

const leaf = (kind: OutlineBlock['kind'], lines: BlockLine[]): OutlineBlock => ({ kind, lines, children: [] })

/** The index of the token that closes the one opened at `open`. */
function closing(tokens: readonly Token[], open: number): number {
    let depth = 0
    for (let i = open; i < tokens.length; i++) {
        depth += tokens[i].nesting
        if (depth === 0) return i
    }
    return tokens.length - 1
}

/**
 * A fence the editor pairs (`fenced-code.ts`): a run of backticks longer than any run in the
 * code, so no line of the code closes it, the info string's first word, since a fence line with
 * a space in its info is no fence to the editor, and a closer of the same run. An answer that
 * stopped inside its code still gets its closer, so the code never reads as outline.
 */
function fenceLines(content: string, info: string): string[] {
    const body = content.replace(/\n$/, '')
    const longest = Math.max(0, ...[...body.matchAll(/`+/g)].map((run) => run[0].length))
    const ticks = '`'.repeat(Math.max(3, longest + 1))
    const language = info.trim().split(/\s+/)[0] ?? ''
    return [`${ticks}${language}`, ...(body === '' ? [] : body.split('\n')), ticks]
}

/** A list item's marker at the start of a line, as many as open on it: `- `, `1. `, `- 1. `. */
const ITEM_MARKERS = /^\s*(?:(?:[-*+]|\d{1,9}[.)])(?:[ \t]+|$))+/

/**
 * The source lines a table or a quote was read from, without the indentation of the item they sit
 * in, and without the item's own marker on the item's first line. Blank lines after it are dropped.
 */
function sourceLines(token: Token, source: readonly string[], itemLine: number | null): string[] {
    if (!token.map) return []
    const lines = source.slice(token.map[0], token.map[1])
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop()
    return lines.map((line, i) => (i === 0 && token.map![0] === itemLine ? line.replace(ITEM_MARKERS, '') : line.trimStart()))
}

/**
 * The blocks between `start` and `end`, one container's children: each paragraph, heading, code
 * block, table, quote or rule a block, and each list item a block of its own (`item`).
 * `itemLine` is the source line the enclosing list item starts on, where its marker is.
 */
function readBlocks(tokens: readonly Token[], start: number, end: number, source: readonly string[], itemLine: number | null): OutlineBlock[] {
    const out: OutlineBlock[] = []
    for (let i = start; i < end; i++) {
        const token = tokens[i]
        const close = token.nesting === 1 ? closing(tokens, i) : i
        switch (token.type) {
            case 'paragraph_open': {
                // The inline content is the paragraph without its container's markers and indent.
                const text = tokens[i + 1]?.content ?? ''
                out.push(leaf('text', text.split('\n').map((line) => line.trimStart())))
                break
            }
            case 'heading_open': {
                // A setext heading's text can run over lines: a heading is one line.
                const text = (tokens[i + 1]?.content ?? '').split('\n').map((line) => line.trim()).join(' ')
                out.push(leaf('heading', [`${'#'.repeat(Number(token.tag.slice(1)) || 1)} ${text}`]))
                break
            }
            case 'fence':
                out.push(leaf('code', fenceLines(token.content, token.info)))
                break
            case 'code_block':
                out.push(leaf('code', fenceLines(token.content, '')))
                break
            case 'hr':
                out.push(leaf('rule', ['---']))
                break
            case 'table_open':
                out.push(leaf('table', sourceLines(token, source, itemLine)))
                break
            case 'blockquote_open':
                out.push(leaf('quote', sourceLines(token, source, itemLine)))
                break
            case 'bullet_list_open':
            case 'ordered_list_open':
                out.push(...listItems(tokens, i, close, source))
                break
            default:
                // Anything else markdown-it reads as a block keeps the lines it came from.
                if (token.nesting !== -1 && token.map && token.level === tokens[start].level) out.push(leaf('text', sourceLines(token, source, itemLine)))
        }
        i = close
    }
    return out
}

/** A list's items, each a block of its own, numbered ones keeping their numbers as text (`- 1. Dig`). */
function listItems(tokens: readonly Token[], open: number, close: number, source: readonly string[]): OutlineBlock[] {
    const ordered = tokens[open].type === 'ordered_list_open'
    const items: OutlineBlock[] = []
    for (let i = open + 1; i < close; i++) {
        const item = tokens[i]
        const end = closing(tokens, i)
        if (item.type === 'list_item_open') {
            const inner = readBlocks(tokens, i + 1, end, source, item.map?.[0] ?? null)
            items.push(...asOneBlock(inner, ordered ? `${item.info}${item.markup}` : ''))
        }
        i = end
    }
    return items
}

/**
 * Several blocks as one, as a list item or a question is one: the first block's lines on the
 * bullet, its later paragraphs, code, tables and quotes as continuation lines after a blank line at
 * the content column (so they stay apart, as markdown has them), and its lists and headings as
 * children, since neither can be a continuation line. Once a child is written, every later block is
 * a child too, so the order stays. `number` is a numbered item's number, kept as text.
 */
function asOneBlock(blocks: readonly OutlineBlock[], number = ''): OutlineBlock[] {
    const [first, ...rest] = blocks
    if (!first) return number ? [leaf('item', [number])] : []
    let head: OutlineBlock
    if (first.kind === 'item') {
        // An item that opens straight onto a list (`- - beans`): its own text is the number at most.
        if (!number) return [...blocks]
        head = { kind: 'item', lines: [number], children: [...blocks] }
        return [head]
    }
    if (number && first.kind !== 'text') {
        // `- 1. ```sh` opens no fence and `- 1. ## Steps` is no heading: the number has a line of its
        // own, and the block is the first thing under it.
        head = { kind: 'item', lines: [number], children: [first] }
    } else {
        const [line, ...more] = first.lines
        head = { kind: 'item', lines: [number && typeof line === 'string' ? `${number} ${line}` : line, ...more], children: [...first.children] }
    }
    for (const block of rest) {
        const continues = head.children.length === 0 && block.kind !== 'item' && block.kind !== 'heading'
        if (continues) head.lines.push(SOFT_BLANK, ...block.lines)
        else head.children.push(block)
    }
    return [head]
}

/** The blocks of a piece of markdown, and its link reference definitions as a last block, as they are no block markdown-it gives. */
function markdownBlocks(markdown: string): OutlineBlock[] {
    const source = markdown.replace(/\r\n?/g, '\n')
    const env: { references?: Record<string, { href: string; title: string }> } = {}
    const tokens = parser.parse(source, env)
    const blocks = readBlocks(tokens, 0, tokens.length, source.split('\n'), null)
    const references = Object.entries(env.references ?? {}).map(([label, { href, title }]) => `[${label}]: ${href}${title !== '' && !title.includes('"') ? ` "${title}"` : ''}`)
    if (references.length > 0) blocks.push(leaf('text', references))
    return blocks
}

/** `blocks` as outline lines, each a bullet `depth` levels in, its lines and children beneath it. */
function written(blocks: readonly OutlineBlock[], depth: number): string[] {
    const pad = LEVEL.repeat(depth)
    const out: string[] = []
    for (const block of blocks) {
        const [first = '', ...rest] = block.lines
        out.push(`${pad}- ${first === SOFT_BLANK ? '' : first}`.trimEnd())
        for (const line of rest) out.push(line === SOFT_BLANK ? `${pad}${LEVEL}` : line === '' ? '' : `${pad}${LEVEL}${line}`)
        out.push(...written(block.children, depth + 1))
    }
    return out
}

/**
 * An answer's markdown as outline lines at the top level: each paragraph, heading, code block,
 * table, quote or rule a bullet of its own, and each list item a bullet, nested ones at their
 * depth and numbered ones keeping their numbers as text, as a Rich Paste writes them. The lines
 * keep to the outline wherever they land: no bare blank line but inside a fence, no heading but on
 * a bullet's own line, and every code block a fence the editor pairs.
 */
export function answerOutline(markdown: string): string[] {
    return written(markdownBlocks(markdown), 0)
}

/** The turns of one exchange a Save writes: the person's, the model's, or both. */
export interface KeptTurns {
    exchange: Exchange
    question: boolean
    answer: boolean
}

/**
 * The block a Save writes for the kept turns, in the order they were asked. The header names the
 * models whose answers are kept, as they wrote what is saved, and is bold, so a saved chat stands
 * out among the bullets around it. An asterisk in a model's name is escaped, so it cannot end the
 * bold early.
 */
export function chatOutline(kept: readonly KeptTurns[], options: { date: string; imageMarkdown?: ReadonlyMap<string, string> }): string {
    const models = [...new Set(kept.filter((turns) => turns.answer).map((turns) => turns.exchange.modelLabel.replace(/\*/g, '\\*')))]
    const header = models.length > 0 ? `Agent Chat with ${models.join(' and ')} on ${options.date}` : `Agent Chat on ${options.date}`
    const out = [`- **${header}**`]
    for (const { exchange, question: keepQuestion, answer: keepAnswer } of kept) {
        const answer = keepAnswer ? markdownBlocks(exchange.answer) : []
        if (keepAnswer && exchange.sources.length > 0) answer.push(leaf('text', [`Sources: ${exchange.sources.map((source) => `[${source.title.replace(/[[\]]/g, '')}](${source.url})`).join(', ')}`]))
        if (!keepQuestion) {
            out.push(...written(answer, 1))
            continue
        }
        // The question is markdown in the document as the answer is, so it keeps to the outline by
        // the same rules: one block, whatever lines the person typed.
        const question = asOneBlock(markdownBlocks(questionText(exchange)))[0] ?? leaf('item', [''])
        const images = exchange.images.flatMap((image) => {
            const markdown = options.imageMarkdown?.get(image.id)
            return markdown ? [markdown] : []
        })
        // Its images go with its own lines, before anything nested under it.
        out.push(...written([{ ...question, lines: [...question.lines, ...images], children: [...question.children, ...answer] }], 1))
    }
    return out.join('\n')
}
