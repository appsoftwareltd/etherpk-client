import type { EditorState, TransactionSpec } from '@codemirror/state'
import { EditorView, type WidgetType } from '@codemirror/view'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createContributionRegistry, setActiveContributionRegistry } from '$lib/surface'

import { editorFixture, type HeadlessEditor } from '../testing/editor-state-fixture'
import { FenceRenderCoordinator, fenceRenderAugmentation } from './fence-render'
import {
    clearRenderCaches,
    fenceRenderResults,
    fenceResultKey,
    renderOwner,
    rendererCollapsedFences,
} from './rendered-common'
import { type AugmentationRenderer, registerAugmentationRenderer } from './renderers/contract'

/**
 * The render coordinator at the Node tier: a coordinator is a plain class over
 * `{ state, dispatch }`, so two of them can be driven over two headless states the way two panes
 * drive two views. Results are owned per editor, so a pane never sweeps, overwrites or reparents
 * another pane's diagram.
 */

/** The sources the fake renderer was asked for, in order. */
let rendered: string[] = []
/** Resolves every pending fake render; set by `deferredRenderer()`. */
let finishRenders: () => void = () => {}

function immediateRenderer(): AugmentationRenderer {
    return {
        editing: 'preview',
        render: (source) => {
            rendered.push(source)
            return Promise.resolve(fakeNode(source))
        },
    }
}

function deferredRenderer(): AugmentationRenderer {
    const waiting: Array<() => void> = []
    finishRenders = () => waiting.splice(0).forEach((f) => f())
    return {
        editing: 'preview',
        render: (source) => {
            rendered.push(source)
            return new Promise((resolve) => waiting.push(() => resolve(fakeNode(source))))
        },
    }
}

/** A stand-in for a renderer's output node: only `cloneNode` matters to the host. */
function fakeNode(label: string): HTMLElement {
    const node = {
        label,
        clones: 0,
        cloneNode() {
            node.clones++
            return { label: `${label} (clone)`, cloneNode: () => ({}) }
        },
    }
    return node as unknown as HTMLElement
}

/** The `{ state, dispatch }` surface a coordinator needs, over a headless editor. */
function host(editor: HeadlessEditor) {
    return {
        get state(): EditorState {
            return editor.state
        },
        dispatch: vi.fn((_spec: TransactionSpec) => {}),
    }
}

/** A fresh editor holding `doc`, its own render owner, and the caret outside the fence. */
function pane(doc: string): HeadlessEditor {
    return editorFixture(`${doc}\n\nafter|`, { extensions: [fenceRenderAugmentation()] })
}

/** Every coordinator a test mounted, destroyed with the "view" in afterEach as a real editor would. */
let mounted: FenceRenderCoordinator[] = []

function mount(over: ReturnType<typeof host>): FenceRenderCoordinator {
    const coordinator = new FenceRenderCoordinator(over)
    mounted.push(coordinator)
    return coordinator
}

function useRenderer(renderer: AugmentationRenderer, info = 'mermaid'): void {
    const registry = createContributionRegistry()
    setActiveContributionRegistry(registry)
    registerAugmentationRenderer(registry, info, renderer)
}

const MERMAID_A = '```mermaid\ngraph A\n```'
const MERMAID_B = '```mermaid\ngraph B\n```'

beforeEach(() => {
    rendered = []
    vi.useFakeTimers()
})

afterEach(() => {
    mounted.splice(0).forEach((c) => c.destroy())
    mounted = []
    setActiveContributionRegistry(null)
    clearRenderCaches()
    vi.useRealTimers()
    vi.unstubAllGlobals()
})

describe('render ownership across panes', () => {
    it('two panes with the same fence on the same line keep separate results', () => {
        useRenderer(immediateRenderer())
        const a = pane(MERMAID_A)
        const b = pane(MERMAID_B)
        mount(host(a))
        mount(host(b))

        const ownerA = a.state.facet(renderOwner)
        const ownerB = b.state.facet(renderOwner)
        expect(ownerA).not.toBe(ownerB)
        expect(fenceRenderResults.get(fenceResultKey(ownerA, 'mermaid', 0))?.source).toBe('graph A')
        expect(fenceRenderResults.get(fenceResultKey(ownerB, 'mermaid', 0))?.source).toBe('graph B')
        expect(fenceRenderResults.size).toBe(2)
    })

    it('destroying one pane cancels only its own pending render and drops only its own entries', () => {
        useRenderer(immediateRenderer())
        const a = pane(MERMAID_A)
        const b = pane(MERMAID_B)
        const coordinatorA = mount(host(a))
        mount(host(b))
        const keyA = fenceResultKey(a.state.facet(renderOwner), 'mermaid', 0)
        const keyB = fenceResultKey(b.state.facet(renderOwner), 'mermaid', 0)

        coordinatorA.destroy()

        // A closed tab leaves nothing of its document behind; B's timer is still armed.
        expect(fenceRenderResults.has(keyA)).toBe(false)
        expect(fenceRenderResults.get(keyB)?.pending).not.toBeNull()
        vi.runAllTimers()
        expect(rendered).toEqual(['graph B'])
    })

    it('a reconcile sweeps only the entries of its own pane', () => {
        useRenderer(immediateRenderer())
        const a = pane(MERMAID_A)
        const b = pane(MERMAID_B)
        const coordinatorA = mount(host(a))
        mount(host(b))
        const keyB = fenceResultKey(b.state.facet(renderOwner), 'mermaid', 0)

        // A's fence is deleted; every transaction in A used to delete B's entries too.
        a.dispatch(a.state.update({ changes: { from: 0, to: a.state.doc.length, insert: 'plain' } }))
        coordinatorA.update({ docChanged: true, selectionSet: false, transactions: [] })

        expect(fenceRenderResults.size).toBe(1)
        expect(fenceRenderResults.get(keyB)?.source).toBe('graph B')
    })

    it('a failed flip render in one pane does not uncollapse the same fence in another', () => {
        useRenderer({ editing: 'flip', render: () => Promise.reject(new Error('unused')) }, 'math')
        const a = pane('```math\n\\frac{\n```')
        const b = pane('```math\n\\frac{\n```')
        const ownerA = a.state.facet(renderOwner)
        fenceRenderResults.set(fenceResultKey(ownerA, 'math', 0), {
            owner: ownerA,
            source: '\\frac{',
            dark: false,
            version: 1,
            node: null,
            error: 'KaTeX parse error',
            pending: null,
            reqSeq: 1,
        })

        expect(rendererCollapsedFences(a.state)).toHaveLength(0)
        expect(rendererCollapsedFences(b.state)).toHaveLength(1)
    })
})

describe('clearing the caches', () => {
    it('a render resolving after its fence was swept and the caches cleared neither lands nor redraws', async () => {
        // The lock sequence: the relock swaps the ciphertext in (the coordinator sweeps the
        // plaintext entry), then the composition root clears the caches - with a render of the
        // plaintext still in flight from before either.
        useRenderer(deferredRenderer())
        const a = pane(MERMAID_A)
        const hostA = host(a)
        const coordinatorA = mount(hostA)
        const key = fenceResultKey(a.state.facet(renderOwner), 'mermaid', 0)
        vi.runAllTimers()
        expect(rendered).toEqual(['graph A'])
        const stale = fenceRenderResults.get(key)

        a.dispatch(a.state.update({ changes: { from: 0, to: a.state.doc.length, insert: 'cipher' } }))
        coordinatorA.update({ docChanged: true, selectionSet: false, transactions: [] })
        clearRenderCaches()
        finishRenders()
        await vi.runAllTimersAsync()

        // The stale completion found its entry gone and dropped out: nothing stored, nothing redrawn.
        expect(hostA.dispatch).toHaveBeenCalledTimes(0)
        expect(fenceRenderResults.size).toBe(0)
        expect(stale?.node).toBeNull()
    })

    it('a render resolving after its pane was destroyed is dropped', async () => {
        useRenderer(deferredRenderer())
        const a = pane(MERMAID_A)
        const hostA = host(a)
        const coordinatorA = mount(hostA)
        vi.runAllTimers()
        expect(rendered).toEqual(['graph A'])

        coordinatorA.destroy()
        finishRenders()
        await vi.runAllTimersAsync()

        expect(hostA.dispatch).toHaveBeenCalledTimes(0)
        expect(fenceRenderResults.size).toBe(0)
    })

    it('asks every live coordinator to render again what it still shows, keeping the version so no rebuild blanks it', async () => {
        useRenderer(immediateRenderer())
        const a = pane(MERMAID_A)
        const hostA = host(a)
        const coordinatorA = mount(hostA)
        const key = fenceResultKey(a.state.facet(renderOwner), 'mermaid', 0)
        await vi.runAllTimersAsync()
        expect(hostA.dispatch).toHaveBeenCalledTimes(1)
        const before = fenceRenderResults.get(key)
        expect(before).toMatchObject({ version: 1, node: expect.anything() })

        clearRenderCaches()

        // The same entry, its rendered node gone and a fresh render armed, at the version the
        // on-screen widget was built with: a rebuild in this window keeps CodeMirror's DOM.
        const during = fenceRenderResults.get(key)
        expect(during).toBe(before)
        expect(during).toMatchObject({ version: 1, node: null })
        expect(during?.pending).not.toBeNull()

        await vi.runAllTimersAsync()
        expect(rendered).toEqual(['graph A', 'graph A'])
        expect(hostA.dispatch).toHaveBeenCalledTimes(2)
        expect(fenceRenderResults.get(key)).toMatchObject({ version: 2, node: expect.anything() })

        // A destroyed coordinator is no longer asked, and its entries do not survive a clear.
        coordinatorA.destroy()
        clearRenderCaches()
        expect(fenceRenderResults.size).toBe(0)
    })

    it('a render in flight across the clear is superseded; only the refresh render lands', async () => {
        useRenderer(deferredRenderer())
        const a = pane(MERMAID_A)
        const hostA = host(a)
        mount(hostA)
        const key = fenceResultKey(a.state.facet(renderOwner), 'mermaid', 0)
        vi.runAllTimers()
        expect(rendered).toEqual(['graph A'])

        clearRenderCaches()
        // The pre-clear render resolves (and is dropped as superseded), and the refresh render
        // is asked for. Nothing has landed yet, so the entry is still at its first version.
        finishRenders()
        await vi.runAllTimersAsync()
        expect(rendered).toEqual(['graph A', 'graph A'])
        expect(hostA.dispatch).toHaveBeenCalledTimes(0)
        expect(fenceRenderResults.get(key)).toMatchObject({ version: 0, node: null })

        finishRenders()
        await vi.runAllTimersAsync()
        expect(hostA.dispatch).toHaveBeenCalledTimes(1)
        expect(fenceRenderResults.get(key)).toMatchObject({ version: 1, node: expect.anything() })
    })

    it('keeps a failed flip fence uncollapsed while its retry is in flight', async () => {
        useRenderer({ editing: 'flip', render: () => Promise.reject(new Error('KaTeX parse error')) }, 'math')
        const a = pane('```math\n\\frac{\n```')
        mount(host(a))
        await vi.runAllTimersAsync()
        expect(rendererCollapsedFences(a.state)).toHaveLength(0)

        clearRenderCaches()

        // Between the clear and the retry landing, the raw source stays - never a placeholder.
        expect(rendererCollapsedFences(a.state)).toHaveLength(0)
        await vi.runAllTimersAsync()
        expect(rendererCollapsedFences(a.state)).toHaveLength(0)
    })

    it('drops the entries of a pane that is no longer live', () => {
        fenceRenderResults.set(fenceResultKey(999, 'mermaid', 0), {
            owner: 999,
            source: 'graph TD',
            dark: false,
            version: 1,
            node: null,
            error: null,
            pending: null,
            reqSeq: 1,
        })
        clearRenderCaches()
        expect(fenceRenderResults.size).toBe(0)
    })
})

describe('the rendered widget', () => {
    /** Enough DOM for RenderedWidget.toDOM(): elements record their children and attributes. */
    class FakeElement {
        className = ''
        textContent = ''
        title = ''
        isConnected = false
        style: Record<string, string> = {}
        attrs = new Map<string, string>()
        children: unknown[] = []
        constructor(readonly tag: string) {}
        setAttribute(name: string, value: string) {
            this.attrs.set(name, value)
        }
        appendChild<T>(child: T): T {
            this.children.push(child)
            return child
        }
    }

    it('appends a clone of the stored node, never the stored node itself', () => {
        useRenderer(immediateRenderer())
        const a = pane(MERMAID_A)
        const owner = a.state.facet(renderOwner)
        const stored = fakeNode('graph A')
        fenceRenderResults.set(fenceResultKey(owner, 'mermaid', 0), {
            owner,
            source: 'graph A',
            dark: false,
            version: 1,
            node: stored,
            error: null,
            pending: null,
            reqSeq: 1,
        })
        // A selection transaction rebuilds the decorations over the stored result.
        a.select(a.state.doc.length)

        vi.stubGlobal('document', {
            documentElement: { dataset: {} },
            createElement: (tag: string) => new FakeElement(tag),
        })
        vi.stubGlobal('requestAnimationFrame', vi.fn())
        const widgets: WidgetType[] = []
        for (const set of a.state.facet(EditorView.decorations)) {
            if (typeof set === 'function') continue
            for (const cursor = set.iter(); cursor.value; cursor.next()) {
                const widget = cursor.value.spec.widget as WidgetType | undefined
                if (widget) widgets.push(widget)
            }
        }
        const rendered = widgets
            .map((w) => w.toDOM(null as unknown as EditorView) as unknown as FakeElement)
            .filter((el) => el.attrs.get('data-augmentation') === 'rendered')

        expect(rendered).toHaveLength(1)
        const [child] = rendered[0].children as Array<{ label: string }>
        expect(child.label).toBe('graph A (clone)')
        expect(child).not.toBe(stored)
        expect((stored as unknown as { clones: number }).clones).toBe(1)
    })
})
