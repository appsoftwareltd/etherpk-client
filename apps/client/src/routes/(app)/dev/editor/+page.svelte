<script lang="ts">
    import { onMount } from 'svelte'
    import * as Y from 'yjs'

    import {
        DocumentView,
        type IndexDoc,
        type IndexSource,
        type RemoteGraphIndex,
        createInMemoryDocumentStore,
        createRemoteGraphIndex,
        inlineTransport,
        getActiveEditorView,
        getActiveGraphSettings,
        registerAugmentationRenderers,
        registerEditorCommands,
        registerLinkCommands,
        setActiveAssetStore,
        setActiveDocumentStore,
        setActiveGraphIndex,
        setActiveGraphSettings,
    } from '$lib/document'
    import {
        createCommandRegistry,
        createContributionRegistry,
        setActiveCommandRegistry,
        setActiveContributionRegistry,
    } from '$lib/surface'
    import { createAssetStore, createMemoryDirectoryAdapter } from '$lib/storage'
    import { performanceRecorder } from '$lib/diagnostics/performance'
    import {
        editorAnalysisDiagnostics,
        resetEditorAnalysisDiagnostics,
    } from '$lib/document/view/analysis/editor-analysis'
    import {
        resetWikilinkDecorationDiagnostics,
        wikilinkDecorationDiagnostics,
    } from '$lib/document/view/augmentations/wikilink'
    import type { ViewRef } from '$lib/layout'
    import CommandBar from '$lib/layout/renderers/CommandBar.svelte'

    const store = createInMemoryDocumentStore({
        'doc-a':
            '# Doc A\n\nHello with a [[Wikilink]] and [[[[Physics]] Quantum Mechanics]].\n\n```\n[[NotALink]]\n```\n',
    })
    setActiveDocumentStore(store)

    // ?yjs=1 — the ADR 0010 gate: the editor buffer is a Y.Text through y-codemirror.next,
    // seeded from the store BEFORE mount so CM and Y.Text agree from the first frame.
    // The `window` guard is load-bearing: this route SSRs in dev, so this instance script
    // runs once server-side (no window → non-yjs) and again during hydration before
    // DocumentView's onMount creates the editor.
    const yjsMode =
        typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('yjs')
    const ydoc = yjsMode ? new Y.Doc() : undefined
    const ytext = ydoc?.getText('content')
    if (ytext) ytext.insert(0, store.open('doc-a').getText())

    // An in-memory Asset store so the upload routes (slash command, drag-and-drop) work
    // in the harness without a real directory.
    const assetStore = createAssetStore(createMemoryDirectoryAdapter({ now: () => Date.now() }))
    setActiveAssetStore(assetStore)

    // The Command + Contribution registries so the `/` Command Menu has commands to offer
    // (mirrors the /g/[graphId] composition root). Editor commands reach the focused editor
    // through the active-view accessor that DocumentView publishes on mount.
    const commandRegistry = createCommandRegistry()
    const contributions = createContributionRegistry()
    setActiveCommandRegistry(commandRegistry)
    setActiveContributionRegistry(contributions)
    const detachEditorCommands = registerEditorCommands(commandRegistry, contributions)
    const detachLinkCommands = registerLinkCommands(commandRegistry, contributions)
    // The built-in Augmentation renderers (mermaid, math) — ADR 0022.
    const detachRenderers = registerAugmentationRenderers(contributions)

    // A fixed graph index so the wikilink-completion popover has concepts to offer:
    // existing pages + an alias + a journal, plus a "pageless" concept referenced
    // only by a wikilink ([[Relativity]] has no page).
    const indexDocs: IndexDoc[] = [
        { concept: 'Physics', kind: 'page', aliases: ['Phys'], text: '' },
        { concept: 'Quantum Mechanics', kind: 'page', aliases: [], text: '' },
        { concept: 'Project', kind: 'page', aliases: [], text: '' },
        // A real page whose name nests a wikilink (a scoped concept) — must be linkable.
        { concept: 'This is a [[Mini Inside]] new page tab', kind: 'page', aliases: [], text: '' },
        { concept: '2026-06-25', kind: 'journal', aliases: [], text: '- see [[Relativity]]' },
    ]
    const indexListeners = new Set<(change?: { concept: string }) => void>()
    const indexSource: IndexSource = {
        snapshotForIndex: async () => indexDocs,
        snapshotDocument: (concept) => indexDocs.find((doc) => doc.concept === concept) ?? null,
        onChange(listener) {
            indexListeners.add(listener)
            return () => indexListeners.delete(listener)
        },
    }
    let graphIndex: RemoteGraphIndex | undefined

    const view: ViewRef = { kind: 'document', target: 'doc-a' }
    let externalText = $state('# Doc A (external)\n\nReplaced from outside.')
    let readout = $state('')
    let indexReady = $state(false)

    function pushExternal() {
        store.setText('doc-a', externalText)
    }
    function readBack() {
        readout = store.open('doc-a').getText()
    }

    onMount(() => {
        // Dev-only seed: `?displaysize=300` primes the graph's default image display size before
        // the editor mounts, so e2e can prove the Graph Settings → upload path without a real
        // etherpk/settings.json. Client-only (it reads location), so it lives here rather than at
        // module scope.
        const params = new URLSearchParams(window.location.search)
        const displaySize = params.get('displaysize')
        setActiveGraphSettings({
            ...(displaySize ? { defaultMaxImageDisplaySize: displaySize } : {}),
        })

        // Test hooks (e2e only): seed arbitrary document content, and read the caret's position
        // relative to its line — so a Playwright test can assert exactly where a click lands.
        const w = window as unknown as Record<string, unknown>
        w.__setDoc = (text: string) => store.setText('doc-a', text)
        w.__getDoc = () => getActiveEditorView()?.state.doc.toString() ?? null
        // Raw change (no keymap) — e2e uses it to simulate a paste and prove the fence-guard backstop.
        w.__insertRaw = (pos: number, text: string) => {
            const view = getActiveEditorView()
            if (view) view.dispatch({ changes: { from: pos, insert: text } })
        }
        w.__setCaret = (pos: number) => {
            const view = getActiveEditorView()
            if (!view) return
            view.focus()
            view.dispatch({ selection: { anchor: pos } })
        }
        w.__setSelection = (anchor: number, head: number) => {
            const view = getActiveEditorView()
            if (!view) return
            view.focus()
            view.dispatch({ selection: { anchor, head } })
        }
        // CM's own coords→pos mapping at a viewport point — for diagnosing click-placement drift
        // (stale height map vs DOM hit-test) without reaching into the view from a test.
        w.__posAtCoords = (x: number, y: number) => getActiveEditorView()?.posAtCoords({ x, y }) ?? null
        // Per-line drift between CM's HEIGHT MAP (lineBlockAt — what click mapping consults) and
        // the real DOM (coordsAtPos) — pinpoints which block above a line mis-measures.
        w.__lineDrift = () => {
            const view = getActiveEditorView()
            if (!view) return null
            const out: Array<{ n: number; hmTop: number; realTop: number; drift: number }> = []
            for (let n = 1; n <= view.state.doc.lines; n++) {
                const pos = view.state.doc.line(n).from
                const coords = view.coordsAtPos(pos)
                if (!coords) continue
                const block = view.lineBlockAt(pos)
                const realTop = coords.top - view.documentTop
                out.push({ n, hmTop: Math.round(block.top), realTop: Math.round(realTop), drift: Math.round(block.top - realTop) })
            }
            return out
        }
        w.__caret = () => {
            const view = getActiveEditorView()
            if (!view) return null
            const head = view.state.selection.main.head
            const line = view.state.doc.lineAt(head)
            return { head, lineFrom: line.from, lineTo: line.to, col: head - line.from, lineText: line.text }
        }
        // Override the default code language used by fence completion (ADR 0018).
        w.__setDefaultCodeLanguage = (lang: string) => {
            setActiveGraphSettings({ ...getActiveGraphSettings(), defaultCodeLanguage: lang })
        }
        // Read a line's computed clamp styling. Resolve via the source position (not nth `.cm-line`),
        // so a block widget above the line doesn't shift the index.
        w.__lineStyle = (n: number) => {
            const view = getActiveEditorView()
            if (!view) return null
            let el: Node | null = view.domAtPos(view.state.doc.line(n).from).node
            if (el && el.nodeType === Node.TEXT_NODE) el = el.parentElement
            while (el && !(el as HTMLElement).classList?.contains('cm-line')) el = (el as HTMLElement).parentElement
            if (!el) return null
            const s = getComputedStyle(el as HTMLElement)
            return { paddingLeft: s.paddingLeft, textIndent: s.textIndent }
        }
        w.__measureEditorTransaction = async (kind: 'edit' | 'selection') => {
            const editor = getActiveEditorView()
            if (!editor) throw new Error('Editor is not mounted')
            const dimensions = {
                lines: editor.state.doc.lines,
                bytes: new TextEncoder().encode(editor.state.doc.toString()).byteLength,
            }
            const startedAt = performance.now()
            if (kind === 'edit') {
                const at = editor.state.selection.main.head
                performanceRecorder.measure('editor.transaction', dimensions, () => {
                    editor.dispatch({ changes: { from: at, insert: 'x' } })
                })
            } else {
                const next = Math.min(editor.state.doc.length, editor.state.selection.main.head + 1)
                performanceRecorder.measure('editor.selection', dimensions, () => {
                    editor.dispatch({ selection: { anchor: next } })
                })
            }
            const transactionMs = performance.now() - startedAt
            const frameStartedAt = performance.now()
            await performanceRecorder.measureAsync('editor.next-frame', dimensions, () =>
                new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
            )
            return {
                kind,
                transactionMs,
                nextFrameMs: performance.now() - frameStartedAt,
                ...dimensions,
            }
        }
        w.__performanceMetrics = () => performanceRecorder.snapshot()
        w.__editorDiagnostics = () => ({
            ...editorAnalysisDiagnostics(),
            wikilinkDecorationBuilds: wikilinkDecorationDiagnostics().builds,
        })
        w.__resetEditorDiagnostics = () => {
            resetEditorAnalysisDiagnostics()
            resetWikilinkDecorationDiagnostics()
        }
        w.__changeIndexDoc = (concept: string, text: string) => {
            const doc = indexDocs.find((candidate) => candidate.concept === concept)
            if (!doc) throw new Error(`Unknown index fixture: ${concept}`)
            doc.text = text
            for (const listener of indexListeners) listener({ concept })
        }

        void (async () => {
            graphIndex = createRemoteGraphIndex(indexSource, inlineTransport(), { graphId: 'dev-editor' })
            await graphIndex.refresh()
            setActiveGraphIndex(graphIndex)
            indexReady = true
        })()
        return () => {
            detachRenderers()
            detachEditorCommands()
            detachLinkCommands()
            setActiveGraphIndex(null)
            graphIndex?.dispose()
            setActiveDocumentStore(null)
            setActiveAssetStore(null)
            assetStore.dispose()
            setActiveGraphSettings({})
            setActiveCommandRegistry(null)
            setActiveContributionRegistry(null)
        }
    })
</script>

<svelte:head><title>/dev/editor</title></svelte:head>

<div class="harness">
    <div class="bar" data-testid="editor-command-bar">
        <button data-testid="editor-read-back" onclick={readBack}>read store</button>
        <button data-testid="editor-push-external" onclick={pushExternal}>push external</button>
        {#if indexReady}<span data-testid="editor-index-ready">index ready</span>{/if}
        {#if yjsMode}<span data-testid="editor-yjs-mode">yjs</span>{/if}
        <pre data-testid="editor-readout">{readout}</pre>
    </div>
    <div class="surface">
        {#key view.target}
            <DocumentView {view} {ytext} />
        {/key}
    </div>
    <!-- The mobile Command Bar, mounted here so its button → Command → editor path is
         exercised against a real DocumentView and the registered editor Commands. -->
    <CommandBar />
</div>

<style>
    .harness {
        /* Fill the (app) content area beneath the full-width top navbar
           (h-14 = 3.5rem), matching /dev/layout. inset:0 would overlap the
           sticky navbar and intercept clicks on the command bar. */
        position: fixed;
        inset: 3.5rem 0 0 0;
        display: grid;
        grid-template-rows: auto 1fr auto;
        background: var(--gk-surface-1);
        color: var(--gk-text-default);
    }
    .bar {
        display: flex;
        gap: 0.5rem;
        align-items: center;
        padding: 0.4rem 0.5rem;
        border-bottom: 1px solid var(--gk-border-soft);
    }
    .bar pre {
        margin: 0;
        font:
            12px/1.4 ui-monospace,
            monospace;
        opacity: 0.8;
    }
    .surface {
        min-height: 0;
    }
</style>
