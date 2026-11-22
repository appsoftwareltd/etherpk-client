import { describe, expect, it } from 'vitest'

import { baseName, directoryHolding, dirOf, extensionOf, headingSlugs, joinPath, normalisePath, relativeLink, resolveLink } from './plain-path'

describe('paths in a Plain Folder', () => {
    it('normalises a path to forward slashes, NFC, with no dot segments', () => {
        expect(normalisePath('guide/./watering.md')).toBe('guide/watering.md')
        expect(normalisePath('guide/images/../soil.md')).toBe('guide/soil.md')
        expect(normalisePath('/guide//soil.md')).toBe('guide/soil.md')
        expect(normalisePath('')).toBe('')
        // macOS can list a name decomposed; link text is usually composed.
        expect(normalisePath('café.md')).toBe('café.md')
    })

    it('answers null for a path that leaves the folder', () => {
        expect(normalisePath('../secrets.md')).toBeNull()
        expect(normalisePath('guide/../../secrets.md')).toBeNull()
    })

    it('splits a path into its folder, name and extension', () => {
        expect(dirOf('guide/images/bed.png')).toBe('guide/images')
        expect(dirOf('README.md')).toBe('')
        expect(baseName('guide/images/bed.png')).toBe('bed.png')
        expect(extensionOf('guide/Bed.PNG')).toBe('png')
        expect(extensionOf('Makefile')).toBe('')
        expect(extensionOf('.gitignore')).toBe('')
        expect(joinPath('guide', 'soil.md')).toBe('guide/soil.md')
        expect(joinPath('', 'soil.md')).toBe('soil.md')
    })
})

describe('a directory that holds a path', () => {
    it('is the outermost of those given that the path is in, or is', () => {
        const graphs = ['docs/public', 'docs/public/nested', 'notes']
        expect(directoryHolding(graphs, 'docs/public/pages/Garden.md')).toBe('docs/public')
        expect(directoryHolding(graphs, 'docs/public/nested/pages/x.md')).toBe('docs/public')
        expect(directoryHolding(graphs, 'notes')).toBe('notes')
        expect(directoryHolding(graphs, 'notes-old/a.md')).toBeNull()
        expect(directoryHolding([], 'README.md')).toBeNull()
    })
})

describe('a markdown link between two files', () => {
    it('resolves from the folder of the file that holds it', () => {
        expect(resolveLink('guide/watering.md', 'soil.md')).toEqual({ kind: 'file', path: 'guide/soil.md', fragment: null })
        expect(resolveLink('guide/watering.md', '../README.md')).toEqual({ kind: 'file', path: 'README.md', fragment: null })
        expect(resolveLink('README.md', './guide/images/bed%20layout.png')).toEqual({ kind: 'file', path: 'guide/images/bed layout.png', fragment: null })
    })

    it('reads a leading slash as the folder root, as a repository host does', () => {
        expect(resolveLink('guide/watering.md', '/README.md')).toEqual({ kind: 'file', path: 'README.md', fragment: null })
    })

    it('keeps the heading a link names', () => {
        expect(resolveLink('README.md', 'guide/soil.md#clay-soil')).toEqual({ kind: 'file', path: 'guide/soil.md', fragment: 'clay-soil' })
        expect(resolveLink('guide/soil.md', '#clay-soil')).toEqual({ kind: 'file', path: 'guide/soil.md', fragment: 'clay-soil' })
        expect(resolveLink('README.md', 'guide/soil.md?plain=1#top')).toEqual({ kind: 'file', path: 'guide/soil.md', fragment: 'top' })
    })

    it('says so when a link leaves the folder, and leaves an address alone', () => {
        expect(resolveLink('README.md', '../other/notes.md')).toEqual({ kind: 'outside' })
        expect(resolveLink('README.md', 'https://example.com/a.md')).toEqual({ kind: 'external' })
        expect(resolveLink('README.md', 'mailto:someone@example.com')).toEqual({ kind: 'external' })
        expect(resolveLink('README.md', '//example.com/a.md')).toEqual({ kind: 'external' })
    })

    it('takes a destination that is not valid percent-encoding as written', () => {
        expect(resolveLink('README.md', '100%.md')).toEqual({ kind: 'file', path: '100%.md', fragment: null })
    })

    it('writes the shortest relative link, escaped so markdown reads it back', () => {
        expect(relativeLink('guide/watering.md', 'guide/soil.md')).toBe('soil.md')
        expect(relativeLink('guide/watering.md', 'README.md')).toBe('../README.md')
        expect(relativeLink('README.md', 'guide/images/bed layout.png')).toBe('guide/images/bed%20layout.png')
        expect(relativeLink('a/b/c.md', 'a/d/e (2).md')).toBe('../d/e%20%282%29.md')
        expect(relativeLink('README.md', 'notes/what#why?.md')).toBe('notes/what%23why%3F.md')
    })
})

describe('heading slugs, as a repository host writes them', () => {
    it('lower-cases, drops punctuation and joins words with hyphens', () => {
        expect(headingSlugs(['Clay soil', 'What to plant, and when?', 'Bed 1: beans & peas'])).toEqual(['clay-soil', 'what-to-plant-and-when', 'bed-1-beans--peas'])
    })

    it('numbers a repeated heading', () => {
        expect(headingSlugs(['Tools', 'Tools', 'Tools'])).toEqual(['tools', 'tools-1', 'tools-2'])
    })

    it('keeps letters of any script', () => {
        expect(headingSlugs(['Café notes', '園芸'])).toEqual(['café-notes', '園芸'])
    })
})
