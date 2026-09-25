import { describe, expect, it } from 'vitest'

import { detectFormat } from './detect'
import { isJunkPath, stripRootSegment } from './source'

describe('detectFormat', () => {
    it('detects Logseq by its config dir, even with journals+pages present', () => {
        expect(
            detectFormat(['logseq/config.edn', 'journals/2026_07_16.md', 'pages/foo.md']),
        ).toBe('logseq')
    })

    it('detects Obsidian by .obsidian/', () => {
        expect(detectFormat(['.obsidian/app.json', 'Notes/Foo.md'])).toBe('obsidian')
    })

    it('detects EtherPK by its etherpk/ subdir', () => {
        expect(
            detectFormat(['etherpk/settings.json', 'journals/2026-07-16.md', 'pages/Foo.md']),
        ).toBe('etherpk')
    })

    it('detects a bare journals+pages skeleton as EtherPK (an Export / Mirror)', () => {
        expect(detectFormat(['journals/2026-07-16.md', 'pages/Foo.md'])).toBe('etherpk')
    })

    it('detects a config-less Logseq graph by underscore-dated journals', () => {
        expect(detectFormat(['journals/2026_07_16.md', 'pages/foo.md'])).toBe('logseq')
    })

    it('falls back to plain markdown', () => {
        expect(detectFormat(['README.md', 'notes/one.md'])).toBe('markdown')
    })
})

describe('stripRootSegment', () => {
    it('drops the picked folder name webkitRelativePath prepends', () => {
        expect(stripRootSegment('vault/pages/Foo.md')).toBe('pages/Foo.md')
    })

    it('leaves a bare name untouched', () => {
        expect(stripRootSegment('Foo.md')).toBe('Foo.md')
    })
})

describe('isJunkPath', () => {
    it.each([
        '.git/HEAD',
        '.obsidian/app.json',
        '.trash/old.md',
        '.DS_Store',
        'notes/.DS_Store',
        'logseq/config.edn',
        'logseq/.recycle/gone.md',
        'a/node_modules/pkg/x.js',
    ])('excludes %s', (path) => {
        expect(isJunkPath(path)).toBe(true)
    })

    it.each(['pages/Foo.md', 'journals/2026_07_16.md', 'assets/img.png', 'Logseq notes.md'])(
        'keeps %s',
        (path) => {
            expect(isJunkPath(path)).toBe(false)
        },
    )
})
