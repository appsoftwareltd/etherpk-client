import { describe, expect, it } from 'vitest'

import { assetUrl, documentUrl, encodeConceptPath, graphUrl, themeUrl, viewUrl } from './document-url'

describe('encodeConceptPath', () => {
    it('encodes each segment but preserves slashes as path separators', () => {
        expect(encodeConceptPath('Meeting Notes')).toBe('Meeting%20Notes')
        expect(encodeConceptPath('a/b c')).toBe('a/b%20c')
    })
    it('encodes characters that would corrupt a URL', () => {
        expect(encodeConceptPath('50% done?')).toBe('50%25%20done%3F')
        expect(encodeConceptPath('a#b&c')).toBe('a%23b%26c')
    })
    it('passes plain names through readably', () => {
        expect(encodeConceptPath('Physics')).toBe('Physics')
        expect(encodeConceptPath('2026-07-13')).toBe('2026-07-13')
    })
})

describe('documentUrl / graphUrl', () => {
    it('builds the /g/[graphId]/d/[...concept] form', () => {
        expect(documentUrl('g1', 'Meeting Notes')).toBe('/g/g1/d/Meeting%20Notes')
    })
    it('encodes the graph id too', () => {
        expect(graphUrl('a b')).toBe('/g/a%20b')
    })
})

describe('assetUrl', () => {
    it('addresses an Asset by identity', () => {
        expect(assetUrl('g1', 'q3-report.a1b2c3d4.pdf')).toBe('/g/g1/a/q3-report.a1b2c3d4.pdf')
        expect(assetUrl('g1', '7f3a1b2c-0000-4000-8000-000000000001.pdf')).toBe(
            '/g/g1/a/7f3a1b2c-0000-4000-8000-000000000001.pdf',
        )
    })

    it('encodes an identity that needs it', () => {
        expect(assetUrl('g1', 'my file.aa.pdf')).toBe('/g/g1/a/my%20file.aa.pdf')
    })
})

describe('viewUrl', () => {
    it('addresses the two kinds that are places you go', () => {
        expect(viewUrl('g1', { kind: 'document', target: 'Physics' })).toBe('/g/g1/d/Physics')
        expect(viewUrl('g1', { kind: 'asset', target: 'chart.aa.png' })).toBe('/g/g1/a/chart.aa.png')
    })

    it('refuses the kinds that are chrome you look through', () => {
        // Sidebar residents are not Visits (ADR 0023), so they have no address.
        expect(viewUrl('g1', { kind: 'backlinks', target: 'Physics' })).toBeNull()
        expect(viewUrl('g1', { kind: 'tasks', target: 'tasks' })).toBeNull()
        expect(viewUrl('g1', { kind: 'document-tree', target: 'root' })).toBeNull()
    })
})

describe('themeUrl', () => {
    // A Theme in its editor is a main-region View like an Asset tab, and before it had an
    // address opening one pushed no history entry, so Back walked straight past it (ADR 0023,
    // 2026-09-20).
    it('addresses a graph Theme by its id', () => {
        expect(themeUrl('g1', 'docs-theme')).toBe('/g/g1/t/docs-theme')
    })

    it('encodes an id that needs it', () => {
        expect(themeUrl('g1', 'my theme')).toBe('/g/g1/t/my%20theme')
    })

    it('is what viewUrl gives a theme View', () => {
        expect(viewUrl('g1', { kind: 'theme', target: 'docs-theme' })).toBe('/g/g1/t/docs-theme')
    })
})
