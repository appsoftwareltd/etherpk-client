/**
 * The [[Import Report]]: an ordinary page generated into the new graph recording every
 * lossy conversion, wikilinked to the affected documents so it is navigable via
 * backlinks - and deletable once read.
 */

import { portableFileStem } from '$lib/document/wikilink'

import { buildFrontmatter, dedupeConcept } from './convert-shared'
import type { ConvertedDocument, ConvertedGraph, ImportFormat, ReportEntry } from './types'

const SECTIONS: Array<[ReportEntry['category'], string]> = [
    // First: the only section describing something the user may still be able to act on.
    ['not-stored', 'Files that could not be uploaded'],
    ['collision', 'Collisions'],
    ['rename', 'Renames'],
    ['degradation', 'Degradations'],
    ['drop', 'Dropped content'],
    ['unresolved', 'Unresolved references'],
    ['unsupported', 'Unsupported constructs'],
    ['unreferenced', 'Unreferenced assets'],
]

const FORMAT_LABEL: Record<ImportFormat, string> = {
    logseq: 'Logseq',
    obsidian: 'Obsidian',
    etherpk: 'EtherPK',
    markdown: 'plain markdown',
}

/** Build the report page and return it (concept deduped against the converted set). */
export function buildReportPage(
    graph: ConvertedGraph,
    format: ImportFormat,
    isoDate: string,
): ConvertedDocument {
    const taken = new Set(graph.documents.map((d) => d.concept.toLowerCase()))
    const concept = dedupeConcept(`Import Report ${isoDate}`, (key) => taken.has(key))

    const lines: string[] = [
        `Imported ${graph.documents.length} documents and ${graph.assets.length} assets from a ${FORMAT_LABEL[format]} source on ${isoDate}.`,
        '',
    ]
    if (graph.report.length === 0) {
        lines.push('Every document converted cleanly - nothing was degraded or dropped.')
    } else {
        lines.push(
            `${graph.report.length} conversions could not be performed losslessly; they are listed below. This page is an ordinary page - delete it once read.`,
        )
        for (const [category, heading] of SECTIONS) {
            const entries = graph.report.filter((r) => r.category === category)
            if (entries.length === 0) continue
            lines.push('', `## ${heading}`, '')
            for (const entry of entries) {
                lines.push(entry.concept ? `- [[${entry.concept}]]: ${entry.detail}` : `- ${entry.detail}`)
            }
        }
    }

    return {
        kind: 'page',
        concept,
        fileName: `${portableFileStem(concept)}.md`,
        text: `${buildFrontmatter({ title: concept })}${lines.join('\n')}\n`,
    }
}
