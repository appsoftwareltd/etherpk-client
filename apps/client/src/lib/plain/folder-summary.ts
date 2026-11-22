/**
 * The sentences the folder-choice dialog says about what a look inside a folder found
 * (classify-folder.ts). Kept apart from the dialog so the counting and the plurals are tested.
 */
import type { FolderCounts, FolderProbe } from './classify-folder'

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

/** "a, b and c" for any number of parts. */
function listed(parts: string[]): string {
    if (parts.length <= 1) return parts.join('')
    return `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`
}

/** What was counted, in the order a person cares about, leaving out what there is none of. */
function countParts(counts: FolderCounts): string[] {
    const parts: string[] = []
    if (counts.markdown > 0) parts.push(plural(counts.markdown, 'markdown file', 'markdown files'))
    if (counts.images > 0) parts.push(plural(counts.images, 'image', 'images'))
    if (counts.pdfs > 0) parts.push(plural(counts.pdfs, 'PDF', 'PDFs'))
    if (counts.ebooks > 0) parts.push(plural(counts.ebooks, 'EBook', 'EBooks'))
    if (counts.other > 0) parts.push(plural(counts.other, 'other file', 'other files'))
    return parts
}

/** The other notes tool a folder's marks name, for the sentence under the title. */
const TOOL: Partial<Record<FolderProbe['format'], string>> = { logseq: 'Logseq', obsidian: 'Obsidian', asnotes: 'AS Notes' }

/** One sentence saying what the folder is, under the dialog's title. */
export function folderSentence(probe: FolderProbe): string {
    if (probe.empty) return 'This folder is empty. Choose what to open it as.'
    const tool = TOOL[probe.format]
    if (tool) return `This folder looks like ${tool} notes, and is not an EtherPK graph.`
    if (probe.format === 'etherpk') return 'This folder is laid out like an EtherPK graph, but EtherPK has not opened it as one.'
    return 'This folder is not an EtherPK graph.'
}

/** What was found and what was left out, as the dialog's small print. Empty for an empty folder. */
export function folderFound(probe: FolderProbe): string {
    if (probe.empty) return ''
    const parts = countParts(probe.counts)
    const found = parts.length === 0 ? 'Found no files to open.' : `Found ${probe.truncated ? 'at least ' : ''}${listed(parts)}.`
    return probe.skipped.length === 0 ? found : `${found} Skipped ${listed(probe.skipped)}.`
}
