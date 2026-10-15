/**
 * What a Save writes (ADR 0147): the turns the person kept, as ordinary outline blocks, so they are
 * searched, their links count and they publish like anything else in the document. Nothing marks
 * them as a chat, so a saved chat is never reopened from the document: to go on, the person starts
 * a chat with "This document", which then holds the saved turns.
 *
 * ```markdown
 * - Agent Chat with Fake Model on 2026-10-15
 *   - What should I plant beside the beans?
 *     - Marigolds, as your [[Garden]] notes suggest.
 * ```
 *
 * The indent is two spaces a level, and the only bullet is `- `, as the outliner reads them. The
 * block lands by the rule a block put at the caret follows (block-insert.ts), shifted to the line's
 * own column by the Client.
 */
import MarkdownIt from 'markdown-it'

import type { Turn } from '../chat/model'

const parser = new MarkdownIt()

/** Two spaces: one outline level. */
const LEVEL = '  '

/** `lines` moved `depth` levels in, blank lines left blank. */
function indent(lines: readonly string[], depth: number): string[] {
    const pad = LEVEL.repeat(depth)
    return lines.map((line) => (line === '' ? '' : pad + line))
}

/**
 * An answer's markdown as outline lines at the top level: each paragraph, heading, numbered list,
 * table or code block a bullet of its own, its other lines at the bullet's content column, and a
 * bulleted list's items bullets themselves, at any depth, written with `- `.
 */
export function answerOutline(markdown: string): string[] {
    const source = markdown.replace(/\r\n?/g, '\n')
    const lines = source.split('\n')
    const out: string[] = []
    for (const token of parser.parse(source, {})) {
        // Each top-level block opens (or is) one token at level 0 with the lines it came from.
        if (token.level !== 0 || token.nesting === -1 || !token.map) continue
        const block = lines.slice(token.map[0], token.map[1])
        while (block.length > 0 && block[block.length - 1].trim() === '') block.pop()
        if (block.length === 0) continue
        if (token.type === 'bullet_list_open') {
            // The outliner's only bullet is a dash; a marker inside a code block in an item is a
            // rare loss, and is still a list marker to any markdown reader.
            out.push(...block.filter((line) => line.trim() !== '').map((line) => line.replace(/^(\s*)[*+](\s)/, '$1-$2')))
            continue
        }
        out.push(`- ${block[0]}`, ...indent(block.slice(1), 1))
    }
    return out
}

/** The block a Save writes for `turns`, in the order they were asked. */
export function chatOutline(turns: readonly Turn[], options: { date: string; imageMarkdown?: ReadonlyMap<string, string> }): string {
    const models = [...new Set(turns.map((turn) => turn.modelLabel))]
    const out = [`- Agent Chat with ${models.join(' and ')} on ${options.date}`]
    for (const turn of turns) {
        const [first, ...rest] = turn.question.trim().split('\n')
        out.push(`${LEVEL}- ${first ?? ''}`)
        // The question's own lines, then its images, at the question's content column.
        const images = turn.images.flatMap((image) => {
            const markdown = options.imageMarkdown?.get(image.id)
            return markdown ? [markdown] : []
        })
        out.push(...indent([...rest.map((line) => line.trimEnd()), ...images], 2))
        const answer = answerOutline(turn.answer)
        if (turn.sources.length > 0) answer.push(`- Sources: ${turn.sources.map((source) => `[${source.title.replace(/[[\]]/g, '')}](${source.url})`).join(', ')}`)
        out.push(...indent(answer, 2))
    }
    return out.join('\n')
}
