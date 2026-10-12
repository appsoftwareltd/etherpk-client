import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createContributionRegistry, setActiveContributionRegistry } from '$lib/surface'

import { editorFixture } from '../testing/editor-state-fixture'
import { interactiveFenceAugmentation } from './interactive-fence'
import { type InteractiveFence, registerInteractiveFence } from './interactive-fence-contract'
import { fenceForPaste, pasteAsFence } from './paste-to-fence'
import { isProtectedDocumentFacet } from './protected-document'

// Text pasted alone on an empty line becomes the fence an extension claims it for (the first Hook,
// `fromPaste`), and Mod+Z straight after gives back the text that was pasted. A video takes a link
// as its one line, and a plan takes copied shapes as a header and one line per shape.

const youtube = 'https://www.youtube.com/watch?v=abcdefghijk'
const copiedShapes = JSON.stringify({ type: 'garden/clipboard', shapes: [{ id: 'b1' }, { id: 'b2' }] })

function widget(fromPaste: InteractiveFence['fromPaste']): InteractiveFence {
    return { height: () => 360, mount: () => ({ update: () => {}, destroy: () => {} }), fromPaste }
}

const video = widget((text) => (text.trim().startsWith('https://www.youtube.com/') && !/\s/.test(text.trim()) ? [text.trim()] : null))
const plan = widget((text) => {
    try {
        const parsed = JSON.parse(text) as { type?: string; shapes?: { id: string }[] }
        return parsed.type === 'garden/clipboard' ? ['{"id":"k1"}', ...(parsed.shapes ?? []).map((shape) => JSON.stringify(shape))] : null
    } catch {
        return null
    }
})

beforeEach(() => {
    const registry = createContributionRegistry()
    registerInteractiveFence(registry, 'video', video)
    registerInteractiveFence(registry, 'garden.plan', plan)
    setActiveContributionRegistry(registry)
})

afterEach(() => setActiveContributionRegistry(null))

const open = (doc: string, protectedDocument = false) =>
    editorFixture(doc, { extensions: [interactiveFenceAugmentation(), isProtectedDocumentFacet.of(() => protectedDocument)] })

describe('which fence a paste becomes', () => {
    it('is the first registration that answers, with the lines it gave', () => {
        expect(fenceForPaste(`  ${youtube}\n`)).toEqual({ info: 'video', lines: [youtube] })
        expect(fenceForPaste(copiedShapes)).toEqual({ info: 'garden.plan', lines: ['{"id":"k1"}', '{"id":"b1"}', '{"id":"b2"}'] })
        expect(fenceForPaste('https://example.com/garden')).toBeNull()
        expect(fenceForPaste('   \n')).toBeNull()
    })

    it('splits an answer at its line breaks and writes no line that would close the fence', () => {
        const registry = createContributionRegistry()
        registerInteractiveFence(registry, 'garden', widget(() => ['beans\npeas', '```', '  ``` closer']))
        setActiveContributionRegistry(registry)
        expect(fenceForPaste('anything')).toEqual({ info: 'garden', lines: ['beans', 'peas', "'''", "  ''' closer"] })
    })

    it('passes over a registration that throws', () => {
        const registry = createContributionRegistry()
        const failing = vi.spyOn(console, 'error').mockImplementation(() => {})
        registerInteractiveFence(
            registry,
            'broken',
            widget(() => {
                throw new Error('no')
            }),
        )
        registerInteractiveFence(registry, 'video', video)
        setActiveContributionRegistry(registry)
        expect(fenceForPaste(youtube)).toEqual({ info: 'video', lines: [youtube] })
        failing.mockRestore()
    })
})

describe('pasting text a fence claims', () => {
    it('on an empty line becomes the fence holding its lines, the caret after it', () => {
        const editor = open('Intro\n|\nAfter')
        expect(pasteAsFence(editor, youtube)).toBe(true)
        expect(editor.fixture()).toBe(`Intro\n\`\`\`video\n${youtube}\n\`\`\`\n|After`)
    })

    it('of several lines, becomes the fence the extension made of it', () => {
        const editor = open('Intro\n|\nAfter')
        expect(pasteAsFence(editor, copiedShapes)).toBe(true)
        expect(editor.text()).toBe(['Intro', '```garden.plan', '{"id":"k1"}', '{"id":"b1"}', '{"id":"b2"}', '```', 'After'].join('\n'))
    })

    it('on an empty bullet opens the fence beside its dot', () => {
        const editor = open('- Garden\n- |\n- After')
        expect(pasteAsFence(editor, youtube)).toBe(true)
        expect(editor.text()).toBe(`- Garden\n- \`\`\`video\n  ${youtube}\n  \`\`\`\n- After`)
    })

    it('is undone back to the text that was pasted with Mod+Z, the caret after it, and redone to the fence', () => {
        const editor = open('Intro\n|\nAfter')
        pasteAsFence(editor, youtube)
        editor.key('Mod-z')
        expect(editor.fixture()).toBe(`Intro\n${youtube}|\nAfter`)
        editor.key('Mod-y')
        expect(editor.text()).toBe(`Intro\n\`\`\`video\n${youtube}\n\`\`\`\nAfter`)
        const shapes = open('Intro\n|\nAfter')
        pasteAsFence(shapes, copiedShapes)
        shapes.key('Mod-z')
        expect(shapes.fixture()).toBe(`Intro\n${copiedShapes}|\nAfter`)
        // A second Mod+Z takes the pasted text away too.
        shapes.key('Mod-z')
        expect(shapes.fixture()).toBe('Intro\n|\nAfter')
    })

    it('inside text, on a task, with a selection or in a Protected Document is left to the ordinary paste', () => {
        for (const [doc, protectedDocument] of [
            ['Watch this: |', false],
            ['- [ ] |', false],
            ['«Garden»', false],
            ['Intro\n|\nAfter', true],
        ] as const) {
            const editor = open(doc, protectedDocument)
            expect(pasteAsFence(editor, youtube)).toBe(false)
            expect(editor.fixture()).toBe(doc)
        }
    })

    it('is left to the ordinary paste when no registration takes the text', () => {
        const editor = open('Intro\n|\nAfter')
        expect(pasteAsFence(editor, 'https://example.com/garden')).toBe(false)
        expect(editor.fixture()).toBe('Intro\n|\nAfter')
    })
})
