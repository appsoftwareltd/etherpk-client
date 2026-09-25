/**
 * The projection seam (ADR 0059, narrowed by ADR 0060): an {@link EditorDocument} decorator that
 * shows a [[Protected Document]]'s body as **ordinary editable text** while the key is held, and
 * the stored fence otherwise.
 *
 * Putting it here rather than in the editor is what keeps the rest of the stack honest. The
 * editor, the outliner, wikilink completion, the slash menu and the Tasks View all keep talking to
 * one `EditorDocument` and never learn that protection exists; the store underneath keeps holding
 * ciphertext and never sees plaintext. Only this object knows both, and only while unlocked.
 *
 * **The projection is the frontmatter, then the decrypted body.** A Protected Document is a page
 * whose entire body is one fence; while unlocked the editor holds the stored frontmatter exactly
 * as it is on disk — visible, because it is the part that is *not* protected, and that should be
 * obvious — followed by the plaintext body. The frontmatter is ordinary editable text (ADR 0061):
 * an edit to it is written through **at once**, as a change to the prefix alone, because plaintext
 * metadata has no reason to wait for the settle that protects other members from ciphertext
 * churn, and because the workspace reads the stored text to decide whether the block proposes a
 * rename. The editor's guard keeps the block from vanishing; if an edit nevertheless crosses the
 * boundary, the text is re-split honestly and what is no longer frontmatter becomes body - and a
 * balanced block typed at the very top of a document that had none becomes frontmatter, in the
 * clear, because that is what the editor shows it as. A rename
 * that lands underneath is carried: the fence is recognised as the one already open, so the new
 * frontmatter is adopted and the body — edits and all — is kept.
 *
 * Two consequences worth stating plainly:
 *
 * - **The store never sees plaintext**, so protected content still contributes nothing to the
 *   [[Derived Index]] — no text, no tasks, and no wikilinks.
 * - **An untouched body is never written at all.** Only an edited body is re-encrypted, so a
 *   page nobody edited churns no envelope — which is what stops a re-save broadcasting a fresh
 *   ciphertext to other [[Player]]s for nothing.
 */
import type { ChangeOrigin, EditorDocument, TextChange } from '../types'
import {
    type CipherFence,
    type DocumentProtectionKind,
    documentProtection,
    frontmatterPrefix,
    protectDocumentText,
} from './cipher-fence'
import { containsCipherFence } from './fence-info'

export interface ProtectedDocumentDeps {
    /** Seal plaintext into an armoured envelope. Rejects while locked. */
    encrypt(plaintext: string): Promise<string>
    /** Open one armoured envelope. Rejects while locked or for another member's key. */
    decryptEnvelope(armoured: string): Promise<string>
    /** Report a failed commit; the workspace turns this into a notice. */
    onError?(error: Error): void
    /** A document was opened for the first time, so anything drawn from its protection is stale. */
    onOpened?(target: string): void
    /**
     * A document that was handed a `Y.Text` — because its text had not seeded when the editor
     * asked — turns out to be protected now that it has. That editor is bound to the CRDT and can
     * never show a projection; the workspace must remount it (store-level, but it lives on the
     * shared deps because the store and the documents are built together).
     */
    onCollabBoundProtected?(target: string): void
    /** Injected for tests. */
    now?: () => number
}

/**
 * How long an edited body must be quiet before it re-encrypts, and the longest continuous typing
 * can hold that off.
 *
 * Deliberately far longer than ordinary autosave (ADR 0059): every re-encryption publishes a fresh
 * envelope to every [[Player]], and at a keystroke cadence that is a live activity feed for a
 * document they cannot read. Forced commits — mask, lock, navigate-away, `pagehide` — ignore it.
 */
export const PROTECTED_SETTLE_MS = 20_000
export const PROTECTED_MAX_WAIT_MS = 60_000

/** How many times a forced commit retries after losing a race to an edit. See {@link ProtectedEditorDocument.commit}. */
const COMMIT_ATTEMPTS = 5

/** What one projection attempt did: installed a projection, found nothing to project, or lost to a newer attempt. */
type ProjectionResult = 'projected' | 'nothing' | 'superseded'

/** Replace `[from, to)` of `text` with `insert`. */
export function splice(text: string, from: number, to: number, insert: string): string {
    return text.slice(0, from) + insert + text.slice(to)
}

/** Apply a CodeMirror-shaped change to a plain string. */
export function applyTextChange(text: string, change: TextChange): string {
    return splice(text, change.from, change.to, change.insert)
}

export class ProtectedEditorDocument implements EditorDocument {
    #inner: EditorDocument
    #deps: ProtectedDocumentDeps
    /** The decrypted body, or null when nothing is projected. */
    #body: string | null = null
    /** The frontmatter shown above the body while projecting; edited in place, written through at once. */
    #prefix = ''
    /** The envelope the body was decrypted from — how a change underneath is told from a rename. */
    #armoured = ''
    /** The body has changed since it was decrypted, so committing must re-encrypt it. */
    #dirty = false
    /** A block promoted out of the body, not yet written through; the next commit writes it. */
    #prefixPending = false
    /**
     * Masked (ADR 0058): the key is still held and the body is still here, but the editor is
     * shown the stored text - the card - until the window comes back. Kept rather than dropped
     * so that coming back within the grace period costs no decryption and no credential.
     */
    #masked = false
    /**
     * When the body was first and last edited. Re-encryption waits for quiet (`last`) but not for
     * ever (`first`), so a body under continuous typing still reaches the store.
     */
    #firstDirtyAt: number | undefined
    #lastDirtyAt: number | undefined
    #listeners = new Set<(text: string) => void>()
    #unsubscribeInner: (() => void) | null = null
    #saveTimer: ReturnType<typeof setTimeout> | undefined
    /** Suppresses the echo when our own write reaches the inner document. */
    #writing = false
    /**
     * Bumped whenever the projection moves — an edit, or dropping it.
     *
     * Sealing is asynchronous, so a keystroke can always land between reading the body and
     * writing the sealed result. Committing that stale result would be merely wasteful in the
     * autosave path and unrecoverable in the forced commit before a lock, where the plaintext is
     * dropped immediately afterwards.
     */
    #epoch = 0
    /**
     * Identifies the current projection attempt, for the same reason at the other end: decrypting
     * is asynchronous, so two re-projections can be in flight at once (one per remote update), and
     * the one that started last holds the newest stored text however they happen to finish.
     */
    #projectSeq = 0

    constructor(inner: EditorDocument, deps: ProtectedDocumentDeps) {
        this.#inner = inner
        this.#deps = deps
    }

    get id(): string {
        return this.#inner.id
    }

    getText(): string {
        return this.#body === null || this.#masked ? this.#inner.getText() : this.#prefix + this.#body
    }

    /** Whether the editor is being shown the fence while the body is held (ADR 0058). */
    get isMasked(): boolean {
        return this.#masked && this.#body !== null
    }

    /** Hide the projection: the editor is handed the stored text, the body is kept. */
    mask(): void {
        if (this.#body === null || this.#masked) return
        this.#masked = true
        this.#notify(this.#inner.getText())
    }

    /** Show the kept body again - no decryption, no credential. */
    unmask(): void {
        if (!this.#masked) return
        this.#masked = false
        if (this.#body === null) return
        // The frontmatter may have been edited through the store while the fence was showing;
        // the body could not have been, so adopting the stored block is enough.
        if (!this.#prefixPending) this.#prefix = frontmatterPrefix(this.#inner.getText())
        this.#notify(this.getText())
    }

    applyChange(change: TextChange, origin: ChangeOrigin = 'editor'): void {
        if (this.#body === null || this.#masked) {
            // The editor's guard refuses these first; this is the invariant the guard cannot
            // hold on its own, because undo is dispatched past every filter. While nothing is
            // projected the stored fence is the document: an editor-origin change may not reach
            // its interior, and may not turn the document into something that is not protected.
            if (origin === 'editor' && !lockedEditAllowed(this.#inner.getText(), change)) return
            this.#inner.applyChange(change, origin)
            return
        }
        if (change.from < this.#prefix.length) {
            this.#applyToPrefix(change, origin)
            return
        }
        const offset = this.#prefix.length
        const body = applyTextChange(this.#body, { from: change.from - offset, to: change.to - offset, insert: change.insert })
        // A block typed at the very top of a document that had none is frontmatter, not body:
        // the editor presents it as frontmatter, so it must be frontmatter - in the clear, shown
        // in both lock states - rather than sealed into the ciphertext behind a panel that said
        // otherwise. Re-split by the one rule, exactly as a prefix edit does. But not written
        // through at once: the lines it took were body a keystroke ago, so the write waits for
        // the settle like the body's own, leaving room to notice and undo.
        const prefix = frontmatterPrefix(this.#prefix + body)
        if (prefix !== this.#prefix) {
            if (this.#prefix !== '' && !this.#prefixMayGrowTo(prefix, change)) return
            const next = this.#prefix + body
            this.#prefix = prefix
            this.#body = next.slice(prefix.length)
            this.#prefixPending = true
        } else {
            this.#body = body
        }
        const now = this.#now()
        this.#firstDirtyAt ??= now
        this.#lastDirtyAt = now
        this.#dirty = true
        this.#epoch++
        this.#schedule()
    }

    /**
     * An edit that starts inside the frontmatter. The edited text is re-split by the one rule
     * that decides what a block is, so an edit that closes the block early or crosses its end
     * moves text into the body rather than leaving the projection and the store disagreeing. The
     * new prefix goes to the store immediately; a body that changed waits for the settle like any
     * other body edit. An `external` origin is a write-back from outside the editor — the workspace
     * restoring a cancelled title — and is echoed to listeners, exactly as a store would.
     */
    #applyToPrefix(change: TextChange, origin: ChangeOrigin): void {
        const next = applyTextChange(this.#prefix + this.#body!, change)
        const prefix = frontmatterPrefix(next)
        // The block may hold only text typed into it. Deleting its closing delimiter above a
        // horizontal rule in the body would otherwise make every line down to the rule
        // frontmatter - plaintext, written through at once, to every member on a synced graph.
        if (origin === 'editor' && !this.#prefixMayGrowTo(prefix, change)) return
        const body = next.slice(prefix.length)
        this.#prefix = prefix
        this.#writePrefix(prefix)
        if (body !== this.#body) {
            this.#body = body
            const now = this.#now()
            this.#firstDirtyAt ??= now
            this.#lastDirtyAt = now
            this.#dirty = true
            this.#epoch++
            this.#schedule()
        }
        if (origin === 'external') this.#notify(this.getText())
    }

    /**
     * Whether a block that ends at `next.length` after `change` grew only by what the change
     * inserted: the new end may not lie beyond the old end plus the change's net length.
     */
    #prefixMayGrowTo(next: string, change: TextChange): boolean {
        const net = change.insert.length - (change.to - change.from)
        return next.length <= this.#prefix.length + net
    }

    /** Replace the stored frontmatter with `prefix`, leaving the fence untouched. */
    #writePrefix(prefix: string): void {
        const stored = this.#inner.getText()
        const current = frontmatterPrefix(stored)
        if (prefix === current) return
        this.#writing = true
        try {
            this.#inner.applyChange({ from: 0, to: current.length, insert: prefix }, 'editor')
        } finally {
            this.#writing = false
        }
    }

    subscribe(listener: (text: string) => void): () => void {
        this.#listeners.add(listener)
        this.#watchInner()
        return () => {
            this.#listeners.delete(listener)
            this.#releaseInner()
        }
    }

    /**
     * Listen to the stored document — but only while something depends on it.
     *
     * A subscription is **not free on a [[Server Backend]]**: it is a `ytext.observe` handler that
     * calls `toString()` on every remote transaction. A synced graph's collaborative editor
     * deliberately never subscribes — it binds to the `Y.Text` — so subscribing here at
     * construction turned catching up a 1,400-update document into 1,400 full-document string
     * materialisations on the main thread, which was enough to shift the whole warm-open sequence.
     */
    #watchInner(): void {
        if (this.#unsubscribeInner) return
        this.#unsubscribeInner = this.#inner.subscribe((text) => void this.#innerChanged(text))
    }

    /** Let go once nothing depends on it: no listeners of our own, and nothing projected. */
    #releaseInner(): void {
        if (this.#listeners.size > 0 || this.#body !== null) return
        this.#unsubscribeInner?.()
        this.#unsubscribeInner = null
    }

    /**
     * How the STORED document is protected — read from the inner document, never from the
     * projection, which by definition is plaintext with no fence in it.
     */
    get protectionKind(): DocumentProtectionKind {
        return documentProtection(this.#inner.getText()).kind
    }

    /** Whether the stored document is a Protected Document. */
    get isProtected(): boolean {
        return this.protectionKind === 'document'
    }

    get isProjecting(): boolean {
        return this.#body !== null
    }

    /**
     * Decrypt the body and project it. Called on open and whenever the graph unlocks. A fence we
     * cannot open — locked, or another member's — is left as it is, which the editor renders as
     * the locked card.
     */
    async unlock(): Promise<void> {
        if (this.#body !== null) return
        await this.#project(++this.#projectSeq)
    }

    /**
     * Drop the projection and build it again from the stored text. For a protection change written
     * through the raw store — protect, remove protection — which the projection cannot see: a
     * store notifies only remote and external writes, and a stale projection would re-encrypt the
     * old body over the new plaintext on its next save, silently protecting the page again.
     */
    async reproject(): Promise<void> {
        this.#discard()
        await this.#project(++this.#projectSeq)
        if (this.#body === null) this.#notify(this.#inner.getText())
    }

    /**
     * Protect the stored document in one step: the fence goes to the store and the body that was
     * just sealed is projected over it in the same synchronous span, so no listener ever sees
     * the fence. The stored bytes are ciphertext from this moment exactly as with a raw write;
     * only what the EDITOR is shown differs. Write-then-reproject flashed the locked card over a
     * page whose plaintext the user was looking at and was about to be shown again - for the
     * file flush, the cache compaction and a decrypt of what was in memory all along.
     *
     * The write is an `external` change, deliberately: on a Server Backend that puts it under the
     * store's own Yjs origin, which the collaborative undo manager does not track, so the
     * plaintext it deletes is not pinned against garbage collection (server-document-store.ts).
     * The echo is suppressed here rather than forwarded, because the fence is what must not
     * reach the editor. Returns false, writing nothing, for a document already protected.
     */
    protect(armoured: string, body: string): boolean {
        const stored = this.#inner.getText()
        if (documentProtection(stored).kind !== 'none') return false
        const next = protectDocumentText(stored, armoured)
        this.#clearTimer()
        this.#body = body
        this.#prefix = frontmatterPrefix(next)
        this.#armoured = armoured
        this.#dirty = false
        this.#prefixPending = false
        this.#firstDirtyAt = undefined
        this.#lastDirtyAt = undefined
        // Both counters: an in-flight seal or projection attempt must not land over this one.
        this.#epoch++
        this.#projectSeq++
        // Follow the stored document from now on, as any projection does - before the write, so
        // its echo is caught by `#writing` rather than arriving as a stranger's change.
        this.#watchInner()
        this.#writing = true
        try {
            this.#inner.applyChange({ from: 0, to: stored.length, insert: next }, 'external')
        } finally {
            this.#writing = false
        }
        // Nothing to notify: the projection reads exactly as the text every listener already
        // shows - the frontmatter kept verbatim, then the body - so an echo would only move carets.
        return true
    }

    /**
     * One projection attempt, against whatever the store holds right now.
     *
     * Only the newest attempt installs its result: decrypting is asynchronous, so two attempts can
     * be in flight at once — one per remote update — and the one that started last read the newest
     * stored text however they happen to finish.
     */
    async #project(seq: number): Promise<ProjectionResult> {
        const stored = this.#inner.getText()
        const protection = documentProtection(stored)
        if (protection.kind !== 'document') return this.#stopProjecting(seq)
        const [fence] = protection.fences
        const armoured = bodyOf(stored.slice(fence.from, fence.to), fence)
        const prefix = frontmatterPrefix(stored)
        if (this.#body !== null && armoured === this.#armoured) {
            // The fence is the one we already opened: only the frontmatter moved — a rename
            // landing underneath. Carry the new frontmatter and KEEP the body, edits and all;
            // decrypting again would throw away whatever the user has typed since.
            if (seq !== this.#projectSeq) return 'superseded'
            this.#prefix = prefix
            this.#epoch++
            this.#notify(this.getText())
            return 'projected'
        }
        let plaintext: string
        try {
            // No `fence.winner` check: `decryptEnvelope` resolves the envelope itself (including
            // last-write-wins across a merged body) and throws when it cannot, so testing it here
            // would only duplicate that and disagree with it.
            plaintext = await this.#deps.decryptEnvelope(armoured)
        } catch {
            // Locked, or another member's key: leave the fence for the editor to render as a card.
            return this.#stopProjecting(seq)
        }
        if (seq !== this.#projectSeq) return 'superseded'

        this.#body = plaintext
        this.#prefix = prefix
        this.#armoured = armoured
        this.#dirty = false
        this.#firstDirtyAt = undefined
        this.#lastDirtyAt = undefined
        this.#epoch++
        // A projection has to follow the stored document even when no editor is listening yet.
        this.#watchInner()
        this.#notify(this.getText())
        return 'projected'
    }

    /**
     * Nothing readable is there — the key has gone, protection was removed, or the document was
     * never protected. Drop any projection we were holding so `getText` falls through to the store.
     */
    #stopProjecting(seq: number): ProjectionResult {
        if (seq !== this.#projectSeq) return 'superseded'
        if (this.#body === null) return 'nothing'
        this.#clearTimer()
        this.#body = null
        this.#prefix = ''
        this.#epoch++
        this.#releaseInner()
        return 'nothing'
    }

    /**
     * Commit anything pending, then drop the plaintext. Called when the key is discarded, and
     * always after the lock machine's forced commit — so the commit here is normally a no-op and
     * exists to close the race where an edit landed between the two.
     */
    async relock(): Promise<void> {
        if (this.#body === null) return
        await this.commit()
        this.#discard()
        // Push the stored text back so the editor stops showing decrypted content the moment the
        // key is gone; without this it would sit there until the next navigation.
        this.#notify(this.#inner.getText())
    }

    /** Flush pending work without dropping the projection — mask, navigate-away, `pagehide`. */
    async commit(): Promise<void> {
        this.#clearTimer()
        if (this.#body === null) return
        try {
            for (let attempt = 0; attempt < COMMIT_ATTEMPTS; attempt++) {
                if (!this.isDirty) return
                if (await this.#commitPass(true)) return
            }
            // Only reachable if something edited the projection during every one of those passes.
            // A forced commit is triggered by inactivity or by an explicit Lock now, so this is not
            // a case a person can produce; if it ever happens, discarding the key still wins over
            // saving the keystroke, and the caller relocks either way.
            this.#deps.onError?.(new Error('Protected content changed faster than it could be saved.'))
        } catch (err) {
            this.#deps.onError?.(err as Error)
        }
    }

    get isDirty(): boolean {
        return this.#body !== null && this.#dirty
    }

    dispose(): void {
        this.#unsubscribeInner?.()
        this.#unsubscribeInner = null
        this.#discard()
        this.#listeners.clear()
    }

    #now(): number {
        return this.#deps.now?.() ?? Date.now()
    }

    #discard(): void {
        this.#clearTimer()
        this.#body = null
        this.#prefix = ''
        this.#dirty = false
        this.#prefixPending = false
        this.#masked = false
        // Both counters, so an in-flight seal or projection cannot resurrect what was just dropped.
        this.#epoch++
        this.#projectSeq++
        this.#releaseInner()
    }

    #clearTimer(): void {
        if (this.#saveTimer !== undefined) clearTimeout(this.#saveTimer)
        this.#saveTimer = undefined
    }

    /** Come back once the body may have settled; the pass itself decides whether it has. */
    #schedule(): void {
        if (this.#saveTimer !== undefined) clearTimeout(this.#saveTimer)
        this.#saveTimer = setTimeout(() => void this.#save(), PROTECTED_SETTLE_MS)
    }

    async #save(): Promise<void> {
        this.#saveTimer = undefined
        if (this.#body === null) return
        try {
            const settled = await this.#commitPass(false)
            // Either we lost a race, or the body is still waiting out its settle. Come back.
            if (!settled || this.#dirty) this.#schedule()
        } catch (err) {
            this.#deps.onError?.(err as Error)
        }
    }

    /**
     * Seal the body if it needs sealing and write the whole document through: the stored
     * frontmatter, verbatim, then one fence. `force` re-encrypts however recently the body was
     * touched — the forced commit before a lock, which must lose nothing.
     *
     * Returns false, having changed nothing, if the body moved while the seal was in flight. The
     * seal is computed **before** any state is touched: half-applying a stale pass would leave the
     * body marked clean against an envelope that no longer holds it.
     */
    async #commitPass(force: boolean): Promise<boolean> {
        const epoch = this.#epoch
        const body = this.#body
        if (body === null) return true
        if (!this.#dirty) return true
        if (!force && !this.#hasSettled()) return true

        const armoured = await this.#deps.encrypt(body)
        if (this.#epoch !== epoch) return false

        this.#armoured = armoured
        this.#dirty = false
        this.#firstDirtyAt = undefined
        this.#lastDirtyAt = undefined
        // A block the body was re-split into goes first; otherwise the STORED frontmatter wins,
        // not the projected one: they only differ when a rename landed after this pass read the
        // body, and then the stored one is the newer.
        if (this.#prefixPending) {
            this.#prefixPending = false
            this.#writePrefix(this.#prefix)
        }
        this.#writeThrough(protectDocumentText(this.#inner.getText(), armoured))
        return true
    }

    /**
     * Whether a dirty body should re-encrypt yet: quiet for the settle period, or — so that
     * continuous typing cannot keep it out of the store for ever — held off at the cap.
     */
    #hasSettled(): boolean {
        const now = this.#now()
        if (this.#lastDirtyAt === undefined) return true
        if (now - this.#lastDirtyAt >= PROTECTED_SETTLE_MS) return true
        return this.#firstDirtyAt !== undefined && now - this.#firstDirtyAt >= PROTECTED_MAX_WAIT_MS
    }

    #writeThrough(next: string): void {
        const current = this.#inner.getText()
        if (next === current) return
        this.#writing = true
        try {
            this.#inner.applyChange({ from: 0, to: current.length, insert: next }, 'editor')
        } finally {
            this.#writing = false
        }
    }

    /**
     * The stored text changed underneath us — a remote CRDT update, or a git reload. While
     * projecting we re-project rather than forwarding ciphertext to an editor showing plaintext.
     */
    async #innerChanged(text: string): Promise<void> {
        if (this.#writing) return
        if (this.#body === null) {
            this.#notify(text)
            // The stored text arrived, or changed, while nothing was projected. If the key is held
            // this is the moment to project: a document that seeds AFTER its editor mounts — every
            // synced document on a fresh page, every filesystem document on first open — would
            // otherwise sit on its locked card with the key in memory, because nothing else
            // re-attempts a projection until the next lock transition.
            if (containsCipherFence(text)) void this.#project(++this.#projectSeq)
            return
        }
        // Re-project against the new stored text, keeping the old projection on screen until the
        // new one is ready rather than discarding first and flashing ciphertext at the editor.
        // Deliberately NOT gated on the epoch: a remote change outranks an uncommitted local one,
        // which is ADR 0028's last-write-wins seen from this end.
        if ((await this.#project(++this.#projectSeq)) === 'nothing') this.#notify(text)
    }

    #notify(text: string): void {
        for (const listener of this.#listeners) listener(text)
    }
}

/**
 * Whether an editor-origin change may reach the stored document while nothing is projected.
 * Deleting the whole fence is how a body is deleted and needs no key; a change into the fence's
 * interior corrupts an envelope for good; a change that leaves the document no longer a
 * Protected Document - one character in front of the fence does it - drops every guard with it.
 */
export function lockedEditAllowed(stored: string, change: TextChange): boolean {
    const protection = documentProtection(stored)
    if (protection.kind !== 'document') return true
    const [fence] = protection.fences
    if (change.from === fence.from && change.to === fence.to && change.insert === '') return true
    const overlaps =
        change.from === change.to
            ? change.from > fence.from && change.from < fence.to
            : change.from < fence.to && change.to > fence.from
    if (overlaps) return false
    return documentProtection(applyTextChange(stored, change)).kind === 'document'
}

/**
 * The armoured body of a fence, given the fence's whole text. Each line is clamped to the fence
 * column the same way `cipherFences` does it, so a body holding two merged envelopes — one per
 * line — unarmours cleanly.
 */
function bodyOf(fenceText: string, fence: Pick<CipherFence, 'fenceColumn'>): string {
    return fenceText
        .split('\n')
        .slice(1, -1)
        .map((line) => (line.length >= fence.fenceColumn ? line.slice(fence.fenceColumn) : line.trimStart()))
        .join('\n')
        .trim()
}
