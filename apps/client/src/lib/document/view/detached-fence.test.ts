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

/** A host that keeps its key listener, so a test can press Mod+Z in the tab. */
function keyHost() {
    let listener: ((event: KeyboardEvent) => void) | null = null
    const host = {
        addEventListener: (_type: string, given: (event: KeyboardEvent) => void) => void (listener = given),
        removeEventListener: () => void (listener = null),
    } as unknown as HTMLElement
    const press = (key: string, options: { shift?: boolean } = {}) => {
        const event = { key, ctrlKey: true, metaKey: false, altKey: false, shiftKey: options.shift === true, target: null, composedPath: () => [], preventDefault: vi.fn() }
        listener?.(event as unknown as KeyboardEvent)
        return event.preventDefault.mock.calls.length > 0
    }
    return { host, press, listening: () => listener !== null }
}

function open(seed = text, id = 'k1', protectedDocument = false, host: HTMLElement = {} as HTMLElement) {
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
        host,
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

// No editor's history holds a tab's or a window's edits, so the host keeps the widget's own there:
// Undo and Redo in the widget, and Mod+Z and Mod+Y in the tab, for a widget with no history of its own.
describe('undoing in a tab or a window', () => {
    it("takes back the widget's last edit, and puts it back", () => {
        const { doc, latest } = open()
        const before = doc.getText()
        latest().edit([{ kind: 'insert', line: 2, text: '{"e":2}' }])
        const after = doc.getText()
        expect(latest().undo?.()).toBe(true)
        expect(doc.getText()).toBe(before)
        expect(latest().body).toEqual(['{"id":"k1"}', '{"e":1}'])
        expect(latest().redo?.()).toBe(true)
        expect(doc.getText()).toBe(after)
        expect(latest().redo?.()).toBe(false)
    })

    it('undoes edits made together as one step, and a new edit ends what could be redone', () => {
        const { doc, latest } = open()
        const before = doc.getText()
        latest().edit([{ kind: 'replace', line: 1, expect: '{"e":1}', text: '{"e":1,"v":2}' }, { kind: 'insert', line: 2, text: '{"e":2}' }])
        latest().undo?.()
        expect(doc.getText()).toBe(before)
        latest().edit([{ kind: 'insert', line: 2, text: '{"e":3}' }])
        expect(latest().redo?.()).toBe(false)
    })

    it('refuses to undo over a change another editor made to the same lines since', () => {
        const { store, doc, latest } = open()
        latest().edit([{ kind: 'insert', line: 2, text: '{"e":2}' }])
        store.setText('Garden', doc.getText().replace('{"e":2}', '{"e":5}'))
        const changed = doc.getText()
        expect(latest().undo?.()).toBe(false)
        expect(doc.getText()).toBe(changed)
    })

    it('answers Mod+Z and Mod+Y in the tab', () => {
        const keys = keyHost()
        const { doc, latest } = open(text, 'k1', false, keys.host)
        const before = doc.getText()
        latest().edit([{ kind: 'insert', line: 2, text: '{"e":2}' }])
        expect(keys.press('z')).toBe(true)
        expect(doc.getText()).toBe(before)
        expect(keys.press('y')).toBe(true)
        expect(keys.press('z', { shift: true })).toBe(false)
        expect(doc.getText()).not.toBe(before)
    })
})
