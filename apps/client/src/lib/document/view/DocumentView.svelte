<script module lang="ts">
    // Process-wide mount ordinal — the remount oracle. Mirrors DevView's
    // mount-counter: the lifecycle test asserts it does NOT increment when the
    // View goes inactive and back, which a text assertion alone cannot prove
    // (the in-memory store retains flushed edits, so a remount would re-seed them).
    let mountCount = 0
</script>

<script lang="ts">
    /**
     * The `document` View: a CodeMirror editor over the active store's document
     * for this ViewRef's target. Mounted by the Layout (and the /dev/editor
     * harness). CodeMirror is bound to the backend, which owns the text.
     */
    import { onDestroy, onMount, untrack } from 'svelte'

    import LoadingSweep from '$lib/components/LoadingSweep.svelte'
    import { viewKey, type ViewRef } from '$lib/layout'
    import { NOTICE_AUTO_DISMISS_MS } from '$lib/notice-dismissal'
    import { registerPositionAdapter, tryGetActiveReadingPositions } from '$lib/navigation'
    import { openContextMenu, tryGetActiveEventBus } from '$lib/surface'
    import { iconSvg } from '$lib/surface/icons'

    import { setActiveDocument } from '../active-document'
    import {
        canCreateDocuments,
        createDraftDocument,
        promoteDraft,
        type DraftDocument,
    } from '../draft'
    import { tryGetActiveAssetStore } from '../active-asset-store'
    import { clearActiveEditorView, setActiveEditorView } from '../active-editor'
    import { markEditorTornDown, recordEditorSuccessor } from './editor-succession'
    import { refreshEditorContext } from '../editor-context.svelte'
    import { initEditorFont, zoomEditorFont } from '../editor-font'
    import { getActiveDocumentStore } from '../active-store'
    import { getActiveGraphIndex } from '../backlinks'
    import { draftConceptNowExists } from '../draft-presence'
    import { conceptIsMissing, openConcept } from '../open-concept'
    import { documentBody } from '../protection/cipher-fence'
    import { frontmatterLineOffset, subscribeReveal, takeReveal } from '../reveal'
    import { DocumentNotFoundError, type EditorDocument } from '../types'
    import { currentWorkspaceServices, type ProtectionControls } from '$lib/workspace/workspace-services'
    import { createDocumentEditor, type DocumentEditor } from './cm-document'
    import { frontmatterIdentityTick } from './augmentations/frontmatter'
    import { carrySpellCheck, spellCheckChanged } from './augmentations/spell-check'
    import { analysisFor } from './analysis/editor-analysis'
    import { editorExtensions } from './editor-extensions'
    import { EDIT_REFUSAL_MESSAGE, EDIT_REFUSAL_TITLE, type EditRefusal } from './edit-refused'
    import { applyEditorPosition, editorPosition, revealEditorPosition } from './view-position'
    import type * as Y from 'yjs'

    // `ytext` opts the editor into the collaborative buffer (Server engine / ADR 0010
    // gate): the Y.Text becomes the source of truth via y-codemirror.next.
    let {
        view: viewProp,
        ytext,
        panelId,
    }: { view: ViewRef; ytext?: Y.Text; panelId?: string } = $props()

    /**
     * This View's ViewRef, **captured at construction**.
     *
     * A Svelte prop is a live getter back into the parent's expression, and this component
     * reads its ref outside the render pass: at mount, from store and index callbacks, and —
     * the one that bites — from `onDestroy`, where the Reading Position is written under
     * `viewKey(view)`. By then the parent has already moved on. The mobile presenter renders
     * `view={activeMain.view}` straight off the layout model, so closing the LAST tab left
     * `activeMain` undefined and the teardown read threw out of Svelte's destroy pass,
     * wedging the presenter — nothing mounted into it again until a reload (live, mobile,
     * 2026-09-09). Closing a tab with others still open was quieter but no better: the
     * departing editor wrote its Reading Position under the INCOMING tab's key.
     *
     * Capturing is not a workaround but the contract both presenters already keep — the
     * dockview adapter mounts each panel with a fixed ViewRef and never updates it, and the
     * mobile presenter re-keys on `panelId` precisely because a View reads its target once.
     */
    const view = untrack(() => viewProp)

    let host = $state<HTMLDivElement>()
    let mountIndex = $state(0)
    // True while the document's backing content is still loading (a Server Backend cache
    // seed queued behind the background materialisation walk) — the editor would otherwise
    // sit silently empty, which reads as "my notes are gone" (live, 2026-07-28).
    let seeding = $state(false)
    let seedShowTimer: ReturnType<typeof setTimeout> | undefined
    // True while a cache seed is outstanding, and set when the workspace asked for the caret
    // before it landed — see focusIfEmpty.
    let seedPending = false
    let focusWhenSeeded = false
    let editor: DocumentEditor | undefined
    let doc: EditorDocument | undefined

    /**
     * The graph's lock control, for the pane's own Lock button. Raw and re-read on every lock
     * event, for the sidebar's reasons: `status` is a rune getter underneath, and the record is
     * read off the graph-open critical path so this View can mount before it has landed.
     */
    let protection = $state.raw<ProtectionControls | undefined>(currentWorkspaceServices()?.protection)
    /**
     * The pane floats a Lock button while the key is held, on EVERY document View - a Protected
     * Document, an ordinary page, a Draft over nothing. The key is graph-wide (ADR 0058), so
     * "am I unlocked?" is a question about the graph, not the page in front of you, and the
     * nudge to lock before walking away is most useful on the page you wandered off to after
     * reading the protected one. It first showed only over protected documents, which hid the
     * unlocked state exactly where the user had stopped looking at it. Masked counts as held -
     * the sidebar control reads "Unlocked · Lock now" in the same state, and this does the same.
     */
    const showLock = $derived(protection?.status === 'unlocked' || protection?.status === 'masked')

    /** Live answer from the mounted document: protection is added and removed while it is open. */
    function isProtectedNow(): boolean {
        return (doc as { isProtected?: boolean } | undefined)?.isProtected ?? false
    }
    /**
     * Width of the editor's vertical scrollbar, in px, when one is showing. The Lock button's
     * right inset adds it, so the button keeps its margin from the text rather than sitting flush
     * against (or under) a classic scrollbar on a long document. Zero for overlay scrollbars
     * and short documents. Measured, because CSS cannot ask whether a scrollbar is painted.
     */
    let scrollbarInset = $state(0)
    let scrollbarObserver: ResizeObserver | undefined

    /**
     * Watch the scroller's content box: it narrows by exactly the scrollbar's width when one
     * appears, which is the one moment the inset changes. A ResizeObserver reports the content
     * box, so it fires for that even though the scroller's outer size is unchanged.
     */
    function observeScrollbar(scroller: HTMLElement): void {
        scrollbarObserver?.disconnect()
        const measure = () => {
            const inset = scroller.offsetWidth - scroller.clientWidth
            if (inset !== scrollbarInset) scrollbarInset = inset
        }
        if (typeof ResizeObserver === 'undefined') {
            measure()
            return
        }
        scrollbarObserver = new ResizeObserver(measure)
        scrollbarObserver.observe(scroller)
    }
    /** Whether the live editor is bound to a `Y.Text` — decided once, at mount. */
    let collabBound = false
    let unsubscribe: (() => void) | undefined
    let detachWheelZoom: (() => void) | undefined
    let detachPositionAdapter: (() => void) | undefined
    let detachScrollReport: (() => void) | undefined
    let reportTimer: ReturnType<typeof setTimeout> | undefined
    // The debounced Reading-Position reporter; the CM updateListener extension is
    // built before it exists, hence the indirection.
    let reportPosition: (() => void) | undefined
    let detachRetry: (() => void) | undefined
    let releaseDocument: (() => void) | undefined
    let mountError = $state<string | null>(null)
    /**
     * The reason a guard refused the last edit, while its notice is showing. A keystroke that
     * does nothing reads as a broken editor, so the refusal is said in a strip at the foot of
     * the pane - never a dialog, since the commonest trigger is a habitual Backspace and focus
     * must stay in the editor. It clears on the next edit the editor accepts (the user has moved
     * on), on Dismiss, or after the shared notice delay; a repeat refusal restarts the delay.
     */
    let editRefusal = $state<EditRefusal | null>(null)
    let refusalTimer: ReturnType<typeof setTimeout> | undefined

    function showRefusal(reason: EditRefusal): void {
        editRefusal = reason
        if (refusalTimer) clearTimeout(refusalTimer)
        refusalTimer = setTimeout(clearRefusal, NOTICE_AUTO_DISMISS_MS)
    }

    function clearRefusal(): void {
        if (refusalTimer) clearTimeout(refusalTimer)
        refusalTimer = undefined
        editRefusal = null
    }
    // [[Draft]] state (ADR 0050). `draft` is set only while this View is showing a
    // Pageless Concept that has no page yet; promoting clears it and remounts.
    let draft: DraftDocument | undefined
    let promoting = false
    let detachDraftWatch: (() => void) | undefined
    // Set when the concept gained a page underneath a Draft that already has typed text.
    // An EMPTY Draft swaps silently instead — there is nothing to lose, and leaving a stale
    // empty page in front of someone while the real content exists is simply wrong.
    let supersededNotice = $state(false)
    /** Carried across a promotion remount so the caret survives the frontmatter prefix. */
    let pendingCaret: number | undefined
    let detachReveal: (() => void) | undefined
    /**
     * A [[Search]] result asked for a specific line. Held briefly rather than applied and
     * forgotten, because opening a result ALSO activates this View, and activation delivers
     * the remembered Reading Position a moment later — which would put the caret back at the
     * top of the document. While this is set it outranks that restore. It expires so a stale
     * reveal can never hijack an unrelated activation later.
     */
    let pendingRevealLine: number | undefined
    let revealExpiry: ReturnType<typeof setTimeout> | undefined

    onMount(() => {
        mountIndex = ++mountCount
        // Apply the persisted editor font size (no-op after the first editor/bar mount).
        initEditorFont()
        // Mounting does not make this the active document: on a reload every restored tab mounts,
        // the ones behind the front tab included, and the last to mount won, so the Backlinks View
        // followed a tab nobody could see. The workspace names the active document when a tab
        // becomes the front one (noteMainViewActivated), and focusing this editor does (onFocus).
        // A Draft has to notice its concept gaining a page underneath it. Both signals are
        // needed: the store knows about a local create, the index about one that arrived by
        // [[Sync]].
        const store = getActiveDocumentStore() as {
            onDocumentsChanged?: (l: () => void) => () => void
        }
        const detachStoreWatch = store.onDocumentsChanged?.(onGraphDocumentsChanged)
        const detachIndexWatch = getActiveGraphIndex()?.onUpdated(onGraphDocumentsChanged)
        // Protection changing is a REMOUNT, not a repaint. Whether this editor is collab-bound is
        // decided once, at mount, from whether the store hands over a `Y.Text` — and a Protected
        // Document is deliberately withheld one so it binds to the decrypted projection instead.
        // A document protected while its tab was open would otherwise stay bound to the CRDT, and
        // unlocking it later would update a buffer nothing is listening to.
        const detachProtectionWatch = tryGetActiveEventBus()?.on(
            'document:protection-changed',
            ({ documentId }) => {
                if (documentId === view.target) remount()
            },
        )
        // A collaborative editor cannot show a projection: it is bound to the CRDT, and the
        // plaintext lives in a document wrapper it never subscribed to. That only happens when the
        // text had not seeded when this editor mounted and turned out to hold protected content;
        // the store normally catches it at `whenReady`, and this is the net under that — on the
        // next lock transition, remount onto the non-collaborative path.
        let lastLocked = currentWorkspaceServices()?.protection?.status === 'locked'
        const detachLockWatch = tryGetActiveEventBus()?.on('protection:changed', () => {
            protection = currentWorkspaceServices()?.protection
            const protectedDoc = isProtectedNow()
            if (collabBound && protectedDoc) remount()
            // The key came or went (masking is neither): the plaintext edits' undo steps must
            // not outlive it, and the fence's must not be replayed into a fresh projection.
            const locked = currentWorkspaceServices()?.protection?.status === 'locked'
            if (locked !== lastLocked) {
                lastLocked = locked
                if (protectedDoc) editor?.clearHistory()
            }
        })
        detachDraftWatch = () => {
            detachStoreWatch?.()
            detachIndexWatch?.()
            detachProtectionWatch?.()
            detachLockWatch?.()
        }
        // Already open: a reveal for this document moves the live caret rather than waiting
        // for a mount that will never happen.
        detachReveal = subscribeReveal((request) => {
            if (request.target !== view.target || !editor) return
            takeReveal(view.target)
            holdReveal(request.line)
        })
        if (tryMountDocument()) return
        // The concept isn't in the registry YET — a deep link that landed before the
        // graph's registry hydrated (cold cache, catchup still streaming). This pane sat
        // BLANK forever (live, 2026-07-28); show the loading state and retry as
        // documents arrive.
        seeding = true
        const withDocs = getActiveDocumentStore() as { onDocumentsChanged?: (l: () => void) => () => void }
        const retry = () => {
            if (editor || !tryMountDocument()) return
            seeding = false
            detachRetry?.()
            detachRetry = undefined
        }
        const detachStore = withDocs.onDocumentsChanged?.(retry)
        // Also retry when the index finishes building. A concept that has no page at all never
        // produces a documents:changed, so waiting only on the store left this pane on
        // "Loading document…" forever instead of offering the Draft it should.
        const detachIndex = getActiveGraphIndex()?.onUpdated(retry)
        if (detachStore || detachIndex) {
            detachRetry = () => {
                detachStore?.()
                detachIndex?.()
            }
        }
        // A store that cannot signal arrivals cannot retry — don't spin forever over it.
        if (!detachRetry) seeding = false
    })

    /**
     * Whether a missing concept should open as a [[Draft]] rather than wait for the registry.
     *
     * The index is the authority on what exists, and it is the same signal the editor's
     * missing-link styling reads. Without one - or while it is still building - "no page" and
     * "not indexed yet" are indistinguishable, so we wait instead of offering to invent a page
     * that may be seconds from arriving.
     */
    function draftAllowed(): boolean {
        if (!canCreateDocuments(getActiveDocumentStore())) return false
        const index = getActiveGraphIndex()
        if (!index || index.isBuilding()) return false
        return !index.conceptExists(view.target)
    }

    /**
     * First keystroke in a Draft: create the page, seeded with the buffer, then rebind this
     * View to the real document. CodeMirror keeps accepting input throughout - its own state
     * IS the buffer, so nothing is racing the user's typing (ADR 0050).
     */
    async function promote(): Promise<void> {
        const store = getActiveDocumentStore()
        if (promoting || !draft || !canCreateDocuments(store)) return
        promoting = true
        const promotingDraft = draft
        try {
            const promoted = await promoteDraft(store, promotingDraft)
            // Read the caret AFTER the await, with the Draft's editor still mounted, so
            // characters typed during the create are already accounted for.
            const caret = editor
                ? editor.view.state.selection.main.head
                : promotingDraft.getText().length
            pendingCaret = promoted.bodyOffset + caret
            remount(promoted.bodyOffset)
        } catch (error) {
            mountError =
                error instanceof Error ? error.message : 'This page could not be created.'
            currentWorkspaceServices()?.health.report({
                code: 'draft-promotion-failed',
                document: view.target,
                message: mountError,
            })
        } finally {
            promoting = false
        }
    }

    /**
     * Land the caret on a source line — a [[Search]] result opening at the block that matched.
     * The line is converted here because only the editor knows where a line starts, and it is
     * clamped because the document may have changed since the index recorded it.
     */
    function revealLine(line: number): void {
        const cm = editor?.view
        if (!cm) return
        // The index derives from the BODY, so its line numbers sit below any frontmatter the
        // editor is also showing. Clamped as well: the document may have changed since.
        const offset = frontmatterLineOffset(cm.state.doc.toString())
        const clamped = Math.min(Math.max(line + offset + 1, 1), cm.state.doc.lines)
        // The line's START; `caretClamp` (a transaction filter, so programmatic moves go
        // through it too) then nudges it right to the content column, past a bullet marker.
        // Scrolled into view rather than to a remembered offset — see revealEditorPosition.
        revealEditorPosition(cm, cm.state.doc.line(clamped).from)
    }

    /**
     * Apply a held reveal, if there is one. True when it took the place of a restore.
     *
     * Applying does NOT consume it, and that is the whole point. Opening a [[Search]] result
     * for an ALREADY-OPEN document reveals first and *then* activates the View — and
     * activation delivers the remembered [[Reading Position]], which would put the caret
     * straight back where the user last was. The reveal has to outrank that restore, so it
     * stays held (and re-appliable, which also covers content arriving late) until its window
     * expires. Every apply is idempotent.
     */
    function applyPendingReveal(): boolean {
        if (pendingRevealLine === undefined || !editor) return false
        revealLine(pendingRevealLine)
        // Take the focus as well. "Show me this result" means the caret it just placed should
        // be usable — and when the result lives in the document the user is ALREADY in,
        // nothing else will do it: the View never changes, so the Layout sees no activation to
        // focus, and the closing modal leaves the focus on nothing at all.
        focusEditor()
        return true
    }

    /**
     * Put DOM focus in the editor, retried over a few frames.
     *
     * Retried because focus into a hidden subtree silently no-ops, and the editor may still be
     * inside a dockview panel that is mid-activation - or one that has just been rebuilt by a
     * [[Draft]] promotion, where the element the user was typing into no longer exists.
     */
    function focusEditor(): void {
        const view = editor?.view
        if (!view) return
        let attempts = 10
        const tryFocus = () => {
            if (!view.dom.isConnected) return
            view.focus()
            if (!view.hasFocus && --attempts > 0) requestAnimationFrame(tryFocus)
        }
        tryFocus()
    }

    /**
     * Take the caret, but only if this document has nothing in it to read — the workspace's
     * `focusIfEmpty` half of the activation policy (`PositionAdapter.focusIfEmpty`).
     *
     * An empty document has nothing to read, so the one useful thing to do in it is type; a
     * blank pane you must aim at first is a worse answer than putting the cursor where it was
     * always going to go. This is what a page just created, a [[Draft]] over a [[Pageless
     * Concept]], and a day nobody has written yet all have in common.
     *
     * Empty means the BODY, not the file: a page on a [[Filesystem Backend]] carries
     * [[Frontmatter]] from the moment it exists, and a locked [[Protected Document]] is a
     * fence, which is content. Neither is a blank page waiting to be written, and only this
     * View can tell the difference — which is exactly why the workspace asks rather than
     * deciding for itself.
     *
     * Content that has not ARRIVED is not content there is none of, so an outstanding
     * [[Server Backend]] cache seed defers the answer rather than reading the empty buffer it
     * is about to fill.
     */
    function focusIfEmpty(): void {
        if (!editor) return
        if (seedPending) {
            focusWhenSeeded = true
            return
        }
        if (documentBody(editor.view.state.doc.toString()).trim() !== '') return
        focusEditor()
    }

    function clearHeldReveal(): void {
        pendingRevealLine = undefined
        if (revealExpiry) clearTimeout(revealExpiry)
        revealExpiry = undefined
    }

    function holdReveal(line: number): void {
        pendingRevealLine = line
        if (revealExpiry) clearTimeout(revealExpiry)
        // The reveal outranks any Reading Position restore for this long: enough to span
        // mounting, a backend hydrating its content, and the Layout activating the panel.
        // Bounded so a reveal can never hijack an unrelated activation later in the session.
        revealExpiry = setTimeout(clearHeldReveal, 3000)
        applyPendingReveal()
    }

    /**
     * Tear the editor down and build it again over whatever the store now holds.
     *
     * The document is held across the swap. On a Server Backend the projection wrapper lives
     * exactly as long as something retains the document (protected-store.ts), and letting the
     * old mount's retain go before the new one took its own evicted the wrapper: a document
     * protected while open remounted onto a FRESH wrapper and showed the fence card until it
     * had decrypted, all over again, the body that was on screen a moment before.
     */
    /**
     * `shift` is how far the text moved between the two editors - a promotion's body offset.
     * Every other remount shows different text, so it passes nothing and a carried position is
     * clamped into the new body instead (editor-succession.ts).
     */
    function remount(shift = 0): void {
        const bridge = (
            getActiveDocumentStore() as { retainDocument?: (target: string) => () => void }
        ).retainDocument?.(view.target)
        // Whoever captured the outgoing view and is still waiting on something - an asset upload
        // is the known case - must be able to find the incoming one: a dispatch into a destroyed
        // view is dropped silently. The teardown marks the outgoing view a dead end; recording the
        // successor afterwards is what turns that into a hop.
        const outgoing = editor?.view
        // Still the same tab: if the user had edited, spelling stays checked (ADR 0095).
        const carrySpelling = outgoing && carrySpellCheck(outgoing)
        try {
            teardownEditor({ capturePosition: false })
            draft = undefined
            supersededNotice = false
            mountIndex = ++mountCount
            tryMountDocument()
        } finally {
            bridge?.()
        }
        if (outgoing && editor) {
            const incoming = editor.view
            recordEditorSuccessor(outgoing, incoming, {
                shift,
                // Asked when a position is mapped, because a Filesystem document mounts over an
                // empty buffer and only shows its frontmatter once the read lands.
                bodyStart: () => {
                    const { frontmatterEnd } = analysisFor(incoming.state)
                    return frontmatterEnd >= 0 ? frontmatterEnd + 1 : 0
                },
            })
            carrySpelling?.(incoming)
        }
    }

    /**
     * A Draft whose concept gained a page underneath it (a [[Player]], a second tab, an
     * [[Import]]). An empty Draft has nothing to lose and swaps silently; one with typed text
     * keeps what the user wrote and offers the swap, because replacing it would destroy work
     * with no undo path across the remount.
     */
    function onGraphDocumentsChanged(): void {
        // The registry moved - a rename arrived, aliases changed - so the frontmatter's mismatch
        // mark is recomputed against it (ADR 0061). Nothing in the text changed to trigger that.
        // Deferred: this listener can fire INSIDE this editor's own update (typing into a deleted
        // document resurrects its registry entry from the change handler), and CodeMirror refuses
        // a dispatch while an update is in progress - the plugin crashed and the resurrection
        // with it.
        // Only a document with a block has a mark to recompute; an effect-only transaction
        // into every other open editor would rebuild their decorations for nothing.
        const current = editor
        if (current && analysisFor(current.view.state).frontmatterEnd >= 0) {
            queueMicrotask(() => {
                if (editor === current) current.view.dispatch({ effects: frontmatterIdentityTick.of() })
            })
        }
        if (!draft || promoting) return
        // The store first, then the index: a local create (today's entry written by a Quick Notes
        // move, say) is in the registry now and in the index later, and a Draft left waiting on
        // the index sat blank until a reload (draft-presence.ts).
        if (!draftConceptNowExists(getActiveDocumentStore(), getActiveGraphIndex(), view.target)) return
        if (draft.hasContent()) supersededNotice = true
        else remount()
    }

    function tryMountDocument(): boolean {
        try {
            mountDocument()
            return true
        } catch (error) {
            if (error instanceof DocumentNotFoundError) return false
            const message =
                error instanceof Error ? error.message : 'The document could not be opened.'
            currentWorkspaceServices()?.health.report({
                code: 'document-open-failed',
                document: view.target,
                message,
            })
            mountError = message
            return true
        }
    }

    /** Open the document and build the editor over it. Throws if the concept is unknown. */
    function mountDocument(): void {
        const activeStore = getActiveDocumentStore()
        const retained = (
            activeStore as { retainDocument?: (target: string) => () => void }
        ).retainDocument?.(view.target)
        try {
            doc = activeStore.open(view.target)
            releaseDocument = retained
        } catch (error) {
            retained?.()
            if (!(error instanceof DocumentNotFoundError) || !draftAllowed()) throw error
            // A [[Pageless Concept]]: mount a Draft over an in-memory buffer and carry on
            // through the SAME editor construction below, so a Draft gets every augmentation,
            // wikilink completion and outliner behaviour a real document has (ADR 0050).
            // Nothing is written until the first keystroke promotes it.
            draft = createDraftDocument(view.target, () => void promote())
            doc = draft
        }
        // Loading state until the content is real. Delayed a beat so an already-seeded
        // document (the common case) never flashes a spinner. In collab mode yCollab
        // reflects the seed into the editor when it lands; this overlay only says so.
        // A Draft has no backing content to wait for; asking would resolve instantly anyway,
        // but saying so keeps the loading overlay off a surface that is already complete.
        const pendingSeed = draft ? undefined : activeStore.whenReady?.(view.target)
        if (pendingSeed) {
            seedPending = true
            seedShowTimer = setTimeout(() => (seeding = true), 150)
            void pendingSeed
                .catch((error) => {
                    const message =
                        error instanceof Error
                            ? error.message
                            : 'The document cache could not be read.'
                    currentWorkspaceServices()?.health.report({
                        code: 'document-seed-failed',
                        document: view.target,
                        message,
                    })
                    mountError = `This document opened without its cached content: ${message}`
                })
                .finally(() => {
                    if (seedShowTimer) clearTimeout(seedShowTimer)
                    seeding = false
                    seedPending = false
                    // The content is in (or failed), so an empty buffer now means an empty
                    // document — which is the one case that wanted the caret.
                    if (focusWhenSeeded) {
                        focusWhenSeeded = false
                        focusIfEmpty()
                    }
                })
        }
        // Collab (Server Backend): the ytext prop (/dev/editor) OR the active store's
        // getYText capability (ServerDocumentStore). When collab, the Y.Text IS the store's
        // text — so onChange is suppressed (would double-apply) and the setExternalText
        // subscription is skipped below (yCollab owns remote reflection; a whole-buffer
        // rewrite would echo-storm the sync engine).

        const collabYText =
            ytext ?? (activeStore as { getYText?: (t: string) => Y.Text | undefined }).getYText?.(view.target)
        const isCollab = collabYText !== undefined
        collabBound = isCollab
        // Presence (remote cursors) — the store's per-doc awareness, when available.
        const awareness = isCollab
            ? (activeStore as { getAwareness?: (t: string) => import('y-protocols/awareness').Awareness | undefined }).getAwareness?.(view.target)
            : undefined
        editor = createDocumentEditor({
            parent: host!,
            doc: doc.getText(),
            onChange: isCollab ? () => {} : (change) => doc!.applyChange(change),
            ...(collabYText ? { collab: { ytext: collabYText, awareness } } : {}),
            // The feature stack lives in editor-extensions.ts (order-tested); the View supplies
            // only the services the features need and its own focus / update hooks.
            extensions: editorExtensions({
                assetStore: () => tryGetActiveAssetStore(),
                graphIndex: () => getActiveGraphIndex(),
                // [[Frontmatter]] is a proposal against the registry (ADR 0061); the workspace
                // owns the registry, the dialogs and the write-back, so everything goes there.
                frontmatter: {
                    proposal: (blockText) =>
                        currentWorkspaceServices()?.frontmatter?.proposalFor(view.target, blockText) ?? [],
                    documentName: () => currentWorkspaceServices()?.frontmatter?.identityOf(view.target)?.concept ?? null,
                    onEpisodeEnd: () => currentWorkspaceServices()?.frontmatter?.episodeEnded(view.target),
                    onRestore: () => currentWorkspaceServices()?.frontmatter?.restore(view.target),
                },
                // Each editor asks its OWN document, and asks live: protection is added and
                // removed while a document is open.
                isProtectedDocument: isProtectedNow,
                backend: () => currentWorkspaceServices()?.backend ?? null,
                editRefused: showRefusal,
                conceptIsMissing,
                openConcept: (concept) => void openConcept(concept, panelId),
                // An edited link is a rename proposal (ADR 0065); the workspace owns the
                // question. A right-click or long-press on one raises its Context Menu.
                wikilinkEdited: (before, after) =>
                    currentWorkspaceServices()?.wikilinkRename?.edited(view.target, before, after),
                wikilinkContextMenu: (concept, x, y) =>
                    openContextMenu({ kind: 'wikilink', concept, panelId }, x, y),
                onFocus(cmView) {
                    // Focusing this editor makes its document and view the active ones.
                    setActiveDocument(view.target)
                    setActiveEditorView(cmView)
                    refreshEditorContext(cmView)
                },
                onUpdate(update) {
                    // An accepted edit means the user has moved past the refused one.
                    if (update.docChanged && editRefusal) clearRefusal()
                    // Keep the Command Bar's outliner-block context in step with the caret.
                    if (update.selectionSet || update.docChanged) {
                        refreshEditorContext(update.view)
                        reportPosition?.()
                    }
                    // Underlines are redrawn when the spell service answers, not only on a
                    // caret move, and the bar's Fix spelling group follows them (ADR 0095).
                    else if (update.view.hasFocus && update.transactions.some((tr) => tr.effects.some((e) => e.is(spellCheckChanged)))) {
                        refreshEditorContext(update.view)
                    }
                    // Content arriving is what a held reveal is waiting for. This covers the
                    // COLLAB path, where yCollab reflects remote text directly and the
                    // store's `subscribe` is deliberately never wired up.
                    if (update.docChanged) applyPendingReveal()
                },
            }),
        })
        // Command Menu handlers reach this editor through the active-view accessor.
        setActiveEditorView(editor.view)
        refreshEditorContext(editor.view)
        // Desktop zoom: Ctrl+wheel over the editor changes the (shared) editor font size.
        // A manual non-passive listener so preventDefault stops the browser page-zoom.
        const dom = editor.view.dom
        const onWheelZoom = (event: WheelEvent) => {
            if (!event.ctrlKey) return
            event.preventDefault()
            zoomEditorFont(event.deltaY < 0 ? 1 : -1)
        }
        dom.addEventListener('wheel', onWheelZoom, { passive: false })
        detachWheelZoom = () => dom.removeEventListener('wheel', onWheelZoom)
        observeScrollbar(editor.view.scrollDOM)
        // Reflect external/remote changes into the editor — but NOT in collab mode, where
        // yCollab already reflects remote Y.Text updates; a setExternalText whole-buffer
        // rewrite would be seen as a local edit and echo-storm the sync engine.
        if (!isCollab) {
            unsubscribe = doc.subscribe((text) => {
                // A fence arriving or leaving by [[Sync]] or an external write changes the
                // answer without a remount; the Lock button must follow it.
                editor!.setExternalText(text)
                // The content this View was opened to show may only have arrived now; a held
                // reveal could not be honoured against the empty buffer it mounted over.
                applyPendingReveal()
            })
        }

        // Navigation History (ADR 0023): expose capture/restore for Visits, apply
        // this View's Reading Position, and keep it fresh (debounced) as the user
        // scrolls or moves the caret. All of it no-ops outside a graph workspace.
        const positionKey = viewKey(view)
        const readingPositions = tryGetActiveReadingPositions()
        // Reading Position FIRST, adapter registration SECOND: registering
        // delivers any pending per-Visit restore (Back reopening this View),
        // which must win over the mount-time Reading Position.
        // A promotion remount carries the caret across the frontmatter prefix a
        // [[Filesystem Backend]] writes ahead of the body; it outranks any remembered
        // Reading Position, which describes the Draft that no longer exists.
        const reveal = takeReveal(view.target)
        if (reveal) {
            holdReveal(reveal.line)
        } else if (pendingCaret !== undefined) {
            const head = pendingCaret
            pendingCaret = undefined
            // A promotion rebuilt this editor, so the element the user was mid-keystroke in no
            // longer exists. Without this they lose focus after the character that created the
            // page and have to click back in — a Draft must feel like any other document.
            focusEditor()
            // Same reason as a reveal: the caret is where the user was typing, so it is
            // scrolled INTO view rather than the document being yanked to the top.
            revealEditorPosition(editor.view, head)
        } else {
            const remembered = readingPositions?.get(positionKey)
            if (remembered) applyEditorPosition(editor.view, remembered)
        }
        detachPositionAdapter = registerPositionAdapter(positionKey, {
            capture: () => (editor ? editorPosition(editor.view) : null),
            // A pending reveal outranks a remembered position: the user asked for a specific
            // block, and this callback is exactly what would otherwise undo that.
            restore: (position) => {
                if (applyPendingReveal()) return
                if (editor) applyEditorPosition(editor.view, position)
            },
            // Called when this View becomes the active document (tab click, open,
            // history traversal) so the caret is visible without a click. CM keeps
            // its selection across a plain DOM focus — position is untouched.
            // Retried over a few frames: a just-activated dockview panel can still
            // be hidden when this fires, and DOM focus inside a hidden subtree
            // silently no-ops.
            focus: focusEditor,
            // The weaker request, for a presenter that must not raise a soft keyboard over a
            // document someone opened to read.
            focusIfEmpty,
        })
        reportPosition = () => {
            if (reportTimer) clearTimeout(reportTimer)
            reportTimer = setTimeout(() => {
                if (editor) readingPositions?.set(positionKey, editorPosition(editor.view))
            }, 200)
        }
        const scroller = editor.view.scrollDOM
        scroller.addEventListener('scroll', reportPosition, { passive: true })
        detachScrollReport = () => scroller.removeEventListener('scroll', reportPosition!)
    }

    /**
     * Release everything `mountDocument` acquired. Shared by unmount and by a promotion
     * remount, which differs in one respect: a Draft's position describes a document that is
     * about to stop existing, so it is not written to the Reading Position store.
     */
    function teardownEditor({ capturePosition }: { capturePosition: boolean }): void {
        unsubscribe?.()
        unsubscribe = undefined
        detachWheelZoom?.()
        detachWheelZoom = undefined
        scrollbarObserver?.disconnect()
        scrollbarObserver = undefined
        scrollbarInset = 0
        // The next mount answers for itself; a remount that fails to open must not keep the
        // previous document's Lock button floating over its loading state.
        if (seedShowTimer) clearTimeout(seedShowTimer)
        seedShowTimer = undefined
        // A remount asks its own seed question; the previous mount's answer, still in flight,
        // is not an answer about the document this View is about to open.
        seedPending = false
        focusWhenSeeded = false
        if (reportTimer) clearTimeout(reportTimer)
        reportTimer = undefined
        if (revealExpiry) clearTimeout(revealExpiry)
        revealExpiry = undefined
        // Final capture: the debounce would otherwise drop the last ≤200ms of
        // scroll/caret movement from the Reading Position on unmount.
        if (editor && capturePosition) {
            tryGetActiveReadingPositions()?.set(viewKey(view), editorPosition(editor.view))
        }
        detachScrollReport?.()
        detachScrollReport = undefined
        detachPositionAdapter?.()
        detachPositionAdapter = undefined
        if (editor) {
            clearActiveEditorView(editor.view)
            // A dead end for anything still holding this view - an upload in flight - unless a
            // remount records its successor over this mark next (editor-succession.ts).
            markEditorTornDown(editor.view)
        }
        refreshEditorContext(null)
        editor?.destroy()
        editor = undefined
        releaseDocument?.()
        releaseDocument = undefined
    }

    onDestroy(() => {
        clearRefusal()
        detachRetry?.()
        detachDraftWatch?.()
        detachReveal?.()
        teardownEditor({ capturePosition: true })
    })
</script>

<div
    class={['document-view', showLock && 'document-view--lock']}
    data-testid="document-view"
    data-doc-target={view.target}
    style:--gk-scrollbar-inset="{scrollbarInset}px"
>
    <div class="document-view__mounts" data-testid="document-mounts">{mountIndex}</div>
    <div class="document-view__editor" data-testid="document-editor" bind:this={host}></div>
    {#if showLock}
        <button
            type="button"
            class="document-view__lock"
            data-testid="document-lock"
            aria-label="Lock protected documents"
            title="Lock protected documents"
            onclick={() => protection?.lockNow()}
        >
            <!-- In-repo constant markup from the icon table, never document content - the same
                 justification the sidebar's padlock carries. -->
            <!-- eslint-disable-next-line svelte/no-at-html-tags -->
            {@html iconSvg('lock', { size: 20 })}
        </button>
    {/if}
    {#if mountError}
        <div class="document-view__error" data-testid="document-error" role="alert">
            {mountError}
        </div>
    {/if}
    {#if supersededNotice}
        <div class="document-view__notice" data-testid="draft-superseded" role="status">
            <span>This page now exists. Opening it keeps what you have typed here.</span>
            <button type="button" data-testid="draft-superseded-open" onclick={() => remount()}>Open it</button>
        </div>
    {/if}
    {#if editRefusal}
        <!-- Floats over the foot of the pane rather than sitting in the flow, so the block the
             message is about does not jump under the caret. `role="status"`: announced, not
             focus-stealing, so the next keystroke still lands in the editor. -->
        <div class="document-view__refusal" data-testid="edit-refused" role="status">
            <p><strong>{EDIT_REFUSAL_TITLE}.</strong> {EDIT_REFUSAL_MESSAGE[editRefusal]}</p>
            <button type="button" data-testid="edit-refused-dismiss" onclick={clearRefusal}>Dismiss</button>
        </div>
    {/if}
    {#if seeding}
        <div class="document-view__loading" data-testid="document-loading" role="status">
            <LoadingSweep label="Loading document" />
            <span>Loading document…</span>
        </div>
    {/if}
</div>

<style>
    .document-view {
        position: relative; /* anchors the loading overlay (and the clipped mount counter) */
        height: 100%;
        display: flex;
        flex-direction: column;
        background: var(--gk-surface-0);
        color: var(--gk-text-default);
    }
    .document-view__editor {
        flex: 1;
        min-height: 0;
        overflow: auto;
    }
    /* Content-loading overlay: sits over the (empty) editor, never steals its clicks. */
    .document-view__loading {
        position: absolute;
        inset: 0;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 0.5rem;
        pointer-events: none;
        font-size: 0.8125rem;
        color: var(--gk-text-muted, var(--gk-text-default));
    }
    .document-view__loading :global(.loading-sweep) {
        max-width: 8rem;
    }
    /* A Draft whose concept gained a page underneath it — offered, never forced. */
    .document-view__notice {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 0.75rem;
        border-bottom: 1px solid var(--gk-border-soft);
        background: var(--gk-surface-2);
        padding: 0.5rem 0.75rem;
        font-size: 0.8125rem;
    }
    .document-view__notice button {
        flex-shrink: 0;
        border-radius: 0.25rem;
        border: 1px solid var(--gk-border-strong);
        padding: 0.125rem 0.5rem;
        cursor: pointer;
    }
    /* A refused edit's reason: a strip at the foot of the pane, the same margin each side (the
       right one grown by the scrollbar, like the Lock button), above the editor rather than in
       its flow (rule 9: nothing moves under the caret). */
    .document-view__refusal {
        position: absolute;
        left: 1rem;
        right: calc(1rem + var(--gk-scrollbar-inset, 0px));
        bottom: 1rem;
        z-index: 2;
        display: flex;
        align-items: flex-start;
        gap: 0.75rem;
        border: 1px solid var(--gk-border-strong);
        border-radius: 0.5rem;
        background: var(--gk-surface-1);
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.18);
        padding: 0.5rem 0.75rem;
        font-size: 0.8125rem;
        line-height: 1.4;
    }
    .document-view__refusal p {
        flex: 1;
        margin: 0;
    }
    .document-view__refusal button {
        flex-shrink: 0;
        border-radius: 0.25rem;
        border: 1px solid var(--gk-border-strong);
        padding: 0.125rem 0.5rem;
        cursor: pointer;
    }
    /* Over an unlocked Protected Document the Lock button owns the bottom-right corner, so the
       strip sits above it (button height plus the gap) rather than giving up its right margin. */
    .document-view--lock .document-view__refusal {
        bottom: calc(1rem + 2.75rem + 0.75rem);
    }
    .document-view__error {
        border-bottom: 1px solid var(--gk-danger-border, #fecaca);
        background: var(--gk-danger-surface, #fef2f2);
        color: var(--gk-danger-text, #991b1b);
        padding: 0.5rem 0.75rem;
        font-size: 0.8125rem;
    }
    /* Let CodeMirror fill the pane. */
    .document-view__editor :global(.cm-editor) {
        height: 100%;
    }
    /* The Lock button over an unlocked Protected Document: bottom right, the same distance from
       each edge. Anchored to the pane rather than the viewport, so on a phone it sits just above
       the Command Bar (the pane ends where the bar begins) and on desktop inside its own split.
       The right inset grows by the scrollbar's measured width (see `observeScrollbar`), so a
       long document's classic scrollbar does not eat the margin. */
    .document-view__lock {
        position: absolute;
        right: calc(1rem + var(--gk-scrollbar-inset, 0px));
        bottom: 1rem;
        z-index: 2;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 2.75rem;
        height: 2.75rem;
        border-radius: 9999px;
        border: 1px solid var(--gk-border-strong);
        background: var(--gk-surface-1);
        color: var(--gk-accent);
        /* A small lift, not the theme's dialog shadow, which is far too deep for a 44px button. */
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.18);
        cursor: pointer;
        touch-action: manipulation;
        transition:
            background-color 120ms ease,
            transform 120ms ease;
    }
    /* Room to scroll the last line clear of the button: a long document's end would otherwise
       sit under it, unreadable and unclickable. Only while the button is showing. */
    .document-view--lock .document-view__editor :global(.cm-content) {
        padding-bottom: 4.5rem;
    }
    .document-view__lock:hover {
        background: var(--gk-surface-2);
    }
    .document-view__lock:active {
        transform: scale(0.96);
    }
    .document-view__lock:focus-visible {
        outline: 2px solid var(--gk-accent);
        outline-offset: 2px;
    }
    .document-view__lock :global(svg) {
        display: block;
    }
    @media (prefers-reduced-motion: reduce) {
        .document-view__lock {
            transition: none;
        }
    }
    /* Mount-counter: present in the DOM for the lifecycle test, visually hidden. */
    .document-view__mounts {
        position: absolute;
        width: 1px;
        height: 1px;
        overflow: hidden;
        clip: rect(0 0 0 0);
    }
</style>
