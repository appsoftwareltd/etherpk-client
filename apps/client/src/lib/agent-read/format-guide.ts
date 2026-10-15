/**
 * `context.documents.formatGuide()` (ADR 0147): how the graph's documents are written, as the
 * Client tells agents, for an [[Agent Chat]]'s model.
 *
 * It is the "Document syntax" section of the managed `AGENTS.md` section every graph folder carries
 * (`agents-md-section.md`, ADR 0070), cut from that same file, so a change to the format that
 * updates the section updates what a chat's model is told, and the two never drift. The rest of the
 * section is about files on a disk (folders, file names, editing safely), which a model reading the
 * graph through the Client has no use for, and every turn would pay for.
 */
import sectionMarkdown from '$lib/storage/fs/agents-md-section.md?raw'

/** The heading of the part that is kept. */
const SYNTAX_HEADING = '### Document syntax'

/** The part of a managed section under `heading`, up to the next heading of the same level. */
export function sectionUnder(markdown: string, heading: string): string {
    const lines = markdown.replace(/\r\n?/g, '\n').split('\n')
    const start = lines.findIndex((line) => line.trim() === heading)
    if (start === -1) return ''
    const level = heading.match(/^#+/)?.[0].length ?? 3
    const rest = lines.slice(start + 1)
    const end = rest.findIndex((line) => {
        const hashes = line.match(/^(#+)\s/)?.[1].length
        return hashes !== undefined && hashes <= level
    })
    return [lines[start], ...(end === -1 ? rest : rest.slice(0, end))].join('\n').trim()
}

let guide: string | undefined

export function formatGuide(): string {
    guide ??= sectionUnder(sectionMarkdown, SYNTAX_HEADING)
    return guide
}
