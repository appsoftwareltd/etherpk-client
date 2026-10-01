import { describe, expect, it } from 'vitest'
import { buildReportPage } from './report'
import type { ConvertedGraph } from './types'

function graph(report: ConvertedGraph['report']): ConvertedGraph {
    return { documents: [], assets: [], report } as unknown as ConvertedGraph
}

describe('buildReportPage', () => {
    it('counts files the server would not store apart from the conversions', () => {
        const page = buildReportPage(graph([
            { category: 'not-stored', detail: '"a.png" (1 MiB) was not uploaded: too large. Documents that reference it still point at the original file.' },
            { category: 'not-stored', detail: '"b.png" (1 MiB) was not uploaded: too large. Documents that reference it still point at the original file.' },
            { category: 'degradation', concept: 'Note', detail: 'Callout became a quote' },
        ]), 'obsidian', '2026-09-27')
        expect(page.text).toContain('2 files could not be uploaded - they are listed first.')
        expect(page.text).toContain('1 conversion could not be performed losslessly')
        expect(page.text).not.toContain('3 conversions')
    })

    it('says nothing about uploads when every file was stored', () => {
        const page = buildReportPage(graph([{ category: 'drop', concept: 'Note', detail: 'Comment removed: "x"' }]), 'obsidian', '2026-09-27')
        expect(page.text).toContain('1 conversion could not be performed losslessly')
        expect(page.text).not.toContain('could not be uploaded')
    })

    it('names the source with the article its name takes', () => {
        const opening = (format: Parameters<typeof buildReportPage>[1]) => buildReportPage(graph([]), format, '2026-09-30').text
        expect(opening('logseq')).toContain('from a Logseq source on 2026-09-30.')
        expect(opening('obsidian')).toContain('from an Obsidian source on 2026-09-30.')
        expect(opening('etherpk')).toContain('from an EtherPK source on 2026-09-30.')
        expect(opening('markdown')).toContain('from a plain markdown source on 2026-09-30.')
        expect(opening('asnotes')).toContain('from an AS Notes source on 2026-09-30.')
    })

    it('says the conversion was clean when only uploads failed', () => {
        const page = buildReportPage(graph([{ category: 'not-stored', detail: '"a.png" was not uploaded: too large.' }]), 'logseq', '2026-09-27')
        expect(page.text).toContain('1 file could not be uploaded - it is listed first.')
        expect(page.text).toContain('Every document converted cleanly')
    })
})
