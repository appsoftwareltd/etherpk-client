import { describe, expect, it, vi } from 'vitest'

import { createInMemoryDocumentStore } from '../in-memory-store'
import type { InteractiveFence, InteractiveFenceContext } from './augmentations/interactive-fence-contract'
import { findFence, mountDetachedFence } from './detached-fence'

// A fence's widget drawn in a tab of its own or over the window, reading and changing the same text
// through the document store, the fence found by the id its registration reads.

const identify = (body: readonly string[]) => body[0]?.match(/"id":"([^"]+)"/)?.[1] ?? null
const plan = (id: string, ...rest: string[]) => ['```garden.plan', `{"id":"${id}"}`, ...rest, '```'].join('\n')
const text = ['- Beds', `  ${plan('k1', '{"e":1}').replaceAll('\n', '\n  ')}`, '', plan('k2', '{"e":9}'), 'After'].join('\n')

function widget() {
    const contexts: InteractiveFenceContext[] = []
    const fence: InteractiveFence = {
        height: () => 400,
        identify,
        mount: (_host, context) => {
            contexts.push(context)
            return { update: (next) => void contexts.push(next), destroy: vi.fn() }
        },
    }
    return { fence, contexts, latest: () => contexts[contexts.length - 1] }
}

function open(seed = text, id = 'k1', protectedDocument = false) {
    const store = createInMemoryDocumentStore({ Garden: seed })
    const doc = store.open('Garden')
    // An unlocked Protected Document's editor document says so, and its text is the plaintext.
    if (protectedDocument) Object.defineProperty(doc, 'isProtected', { value: true })
    const { fence, contexts, latest } = widget()
    const onGone = vi.fn()
    const mounted = mountDetachedFence({
        doc,
        ref: { document: 'Garden', info: 'garden.plan', id },
        fence,
        presentation: 'tab',
        host: {} as HTMLElement,
        dark: () => false,
        onScreen: () => true,
        onGone,
    })
    return { store, doc, mounted, contexts, latest, onGone }
}

describe('finding a fence by its own id', () => {
    it('finds the fence its id names, wherever it sits, its body without indentation', () => {
        expect(findFence(text, { info: 'garden.plan', id: 'k1' }, identify)).toMatchObject({ start: 1, body: ['{"id":"k1"}', '{"e":1}'] })
        expect(findFence(text, { info: 'garden.plan', id: 'k2' }, identify)).toMatchObject({ start: 6, body: ['{"id":"k2"}', '{"e":9}'] })
        expect(findFence(text, { info: 'garden.plan', id: 'k3' }, identify)).toBeNull()
    })
})

describe('a widget outside its editor', () => {
    it('is drawn with its body, in the presentation it was opened in', () => {
        const { latest } = open()
        expect(latest().presentation).toBe('tab')
        expect(latest().body).toEqual(['{"id":"k1"}', '{"e":1}'])
    })

    it('takes the keyboard once, as its tab or window opens, and an update never asks for it again', () => {
        const { latest } = open()
        const first = latest()
        expect(first.takeFocus()).toBe(true)
        expect(first.takeFocus()).toBe(false)
        first.edit({ kind: 'insert', line: 2, text: '{"e":2}' })
        expect(latest().takeFocus()).toBe(false)
    })

    it("writes its edits into the document at the fence's indentation, as the editor would", () => {
        const { doc, latest } = open()
        expect(latest().edit([{ kind: 'replace', line: 1, expect: '{"e":1}', text: '{"e":1,"v":2}' }, { kind: 'insert', line: 2, text: '{"e":2}' }])).toBe(true)
        expect(doc.getText()).toBe(['- Beds', '  ```garden.plan', '  {"id":"k1"}', '  {"e":1,"v":2}', '  {"e":2}', '  ```', '', plan('k2', '{"e":9}'), 'After'].join('\n'))
        expect(latest().body).toEqual(['{"id":"k1"}', '{"e":1,"v":2}', '{"e":2}'])
    })

    it('refuses edits that no longer apply, writing none of them', () => {
        const { doc, latest } = open()
        expect(latest().edit([{ kind: 'insert', line: 2, text: '{"e":2}' }, { kind: 'remove', line: 1, expect: '{"e":7}' }])).toBe(false)
        expect(doc.getText()).toBe(text)
    })

    it("hears another editor's change to its fence, found again after lines were added above it", () => {
        const { store, latest } = open()
        store.setText('Garden', `Intro\n\n${text.replace('{"e":1}', '{"e":5}')}`)
        expect(latest().body).toEqual(['{"id":"k1"}', '{"e":5}'])
    })

    it('is told when its fence is deleted elsewhere', () => {
        const { store, onGone } = open()
        store.setText('Garden', plan('k2'))
        expect(onGone).toHaveBeenCalledTimes(1)
        expect(onGone).toHaveBeenCalledWith('gone')
    })

    it('says so, and draws nothing, when its fence is not in the document', () => {
        const { mounted, contexts, onGone } = open(text, 'k9')
        expect(mounted).toBeNull()
        expect(contexts).toHaveLength(0)
        expect(onGone).toHaveBeenCalledWith('gone')
    })

    it('counts the fences with its info word before it, as the editor does', () => {
        expect(open(text, 'k2').latest().ordinal).toBe(1)
    })

    it('is not drawn over a Protected Document, locked or unlocked, as the editor draws no widget in one', () => {
        const locked = open(`${text}\n\`\`\`etherpk-cipher\nciphertext\n\`\`\``)
        expect(locked.mounted).toBeNull()
        expect(locked.onGone).toHaveBeenCalledWith('protected')
        const unlocked = open(text, 'k1', true)
        expect(unlocked.mounted).toBeNull()
        expect(unlocked.contexts).toHaveLength(0)
        expect(unlocked.onGone).toHaveBeenCalledWith('protected')
    })

    it('stops, writing nothing more, when its document is protected while it is open', () => {
        const { store, doc, latest, onGone } = open()
        store.setText('Garden', `${text}\n\`\`\`etherpk-cipher\nciphertext\n\`\`\``)
        expect(onGone).toHaveBeenCalledWith('protected')
        expect(latest().edit({ kind: 'insert', line: 2, text: '{"e":2}' })).toBe(false)
        expect(doc.getText()).toContain('{"e":1}\n  ```')
    })
})
