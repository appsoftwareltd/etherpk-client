/**
 * A {@link DocumentStore} decorator that hands out {@link ProtectedEditorDocument}s, so every
 * editor surface projects a [[Protected Document]]'s plaintext while the key is held and shows
 * ciphertext otherwise (ADR 0059).
 *
 * **The invariant that makes this safe.** The [[Derived Index]] does not read documents through
 * `open()` — it uses the store's separate index surface (`snapshotForIndex`, `streamForIndex`,
 * `snapshotDocument`, `onChange`), and the workspace passes it the *raw* store. Decorating
 * `open()` therefore cannot put plaintext into the index, which is plaintext at rest in OPFS and
 * outlives the session. If a future change ever routes indexing through `open()`, this decorator
 * becomes a plaintext leak and the guard in `index-db.ts` will not catch it, because by then the
 * text will no longer look like a fence.
 *
 * Documents are cached per id so one open document has one projection: two panels showing the
 * same protected page must share a buffer, or each would re-encrypt over the other. The cache is
 * scoped to the editor's **retain**, not to the store's lifetime: on a Server Backend the inner
 * store retires a document's sync engine once nothing retains it, and a wrapper bound to a retired
 * engine shows a frozen copy that never syncs. Where the inner store has no retain (Filesystem),
 * its documents are stable handles and the wrappers live as long as it does.
 */
import type { DocumentStore, EditorDocument } from '../types'
import { type DocumentProtectionKind, documentProtection } from './cipher-fence'
import { ProtectedEditorDocument, type ProtectedDocumentDeps } from './protected-document'

export interface ProtectedDocumentStore extends DocumentStore {
    /** Withheld for a Protected Document — see the implementation for why. */
    getYText?: (target: string) => unknown
    getAwareness?: (target: string) => unknown
    retainDocument?: (target: string) => () => void

    /** Project every open protected document. Called when the graph unlocks. */
    unlockAll(): Promise<void>
    /** Commit and drop every projection. Called when the key is discarded. */
    relockAll(): Promise<void>
    /** Hide every projection, keeping the bodies (ADR 0058 masking). Synchronous: nothing may render first. */
    maskAll(): void
    /** Show every kept body again. */
    unmaskAll(): void
    /** Flush pending plaintext without dropping it — masking and navigate-away. */
    commitAll(): Promise<void>
    /**
     * Rebuild one document's projection from its stored text. For a protection change written
     * through the RAW store — protect, remove protection — which the projection cannot see: a
     * store notifies only remote and external writes, and a stale projection would re-encrypt
     * the old body over the new plaintext on its next save, silently protecting the page again.
     * A no-op for a document that is not open.
     */
    reproject(target: string): Promise<void>
    /**
     * Protect an OPEN document in one step - the fence to the store, the sealed body projected
     * over it - so its editor never sees the fence (see `ProtectedEditorDocument.protect`). False
     * when the document is not open, in which case nothing is looking and the caller writes the
     * fence through the raw store, or when it is already protected.
     */
    protect(target: string, armoured: string, body: string): boolean
    /** Whether any open projection holds unwritten plaintext. */
    readonly hasPendingWrites: boolean
    /**
     * What kind of protection an ALREADY-OPEN document has, or undefined if it is not open.
     *
     * Cache-only on purpose. This answers a tab renderer, which runs for every panel on every
     * repaint, and `open()` is not a free read on a Server Backend — it retains a sync engine. The
     * same call in `isProtected` once made warm tabs re-derive the whole graph.
     */
    protectionKindFor(target: string): DocumentProtectionKind | undefined
    dispose(): void
}

/**
 * The capabilities `DocumentView` duck-types off the store. They are optional on the interface but
 * load-bearing in practice: without `getYText` a synced graph silently loses multiplayer, because
 * the View reads "no Y.Text" as "not collaborative".
 */
interface StoreCapabilities {
    getYText?: (target: string) => unknown
    getAwareness?: (target: string) => unknown
    retainDocument?: (target: string) => () => void
    whenReady?: (target: string) => Promise<void>
}

export function createProtectedDocumentStore(
    inner: DocumentStore,
    deps: ProtectedDocumentDeps,
): ProtectedDocumentStore {
    const open = new Map<string, ProtectedEditorDocument>()
    const capabilities = inner as DocumentStore & StoreCapabilities
    /** Editor retains per target — the wrapper cache follows these (see the module comment). */
    const retains = new Map<string, number>()
    /**
     * Targets whose editor was handed a real `Y.Text`. On a Server Backend the text may not have
     * seeded when the editor asked, so "not protected" can be "not loaded yet"; `whenReady` is
     * where that gets corrected.
     */
    const collabBound = new Set<string>()
    /**
     * Wrappers released by their last viewer and still writing their pending plaintext. They are
     * out of the cache — a reopen must get a fresh wrapper over the live engine — but a forced
     * commit before a lock has to wait for them, or the key goes while they are mid-write.
     */
    const closing = new Set<Promise<void>>()

    /**
     * Whether the STORED text is a Protected Document — read from the inner document, never from
     * the projection, which by definition is plaintext with no fence in it.
     *
     * A Protected Document's editor text is its decrypted body, not the stored fence, so it cannot
     * be collab-bound (ADR 0002): the projection is what the editor edits.
     *
     * Answered from the already-open wrapper wherever possible. `open()` is not a free read on a
     * Server Backend: it retains a sync engine, and calling it here purely to inspect text made
     * warm tabs re-derive the graph. `getYText` is only ever asked immediately after `open`, so
     * the cache is populated in every real call path and the fallback is for safety alone.
     */
    const isProtected = (target: string): boolean => {
        const wrapped = open.get(target)
        if (wrapped) return wrapped.isProtected
        try {
            return documentProtection(inner.open(target).getText()).kind !== 'none'
        } catch {
            return false
        }
    }

    const overrides: Record<string | symbol, unknown> = {
        open(target: string): EditorDocument {
            // Always through the inner store, even on a cache hit: on a Server Backend that is what
            // ensures the document's sync engine exists, exactly as the raw store did on every mount.
            const innerDoc = inner.open(target)
            const existing = open.get(target)
            if (existing) {
                // Idempotent, and the key may have arrived since this wrapper last looked.
                void existing.unlock()
                return existing
            }
            const wrapped = new ProtectedEditorDocument(innerDoc, deps)
            open.set(target, wrapped)
            // Project immediately where the key is already held, so opening an unlocked graph's
            // protected page shows its content rather than a lock card that resolves a tick later.
            void wrapped.unlock()
            // A document only becomes answerable to `protectionKindFor` once it is open, so
            // anything drawn from that — the tab padlocks — has to be told when that happens.
            deps.onOpened?.(target)
            return wrapped
        },

        /**
         * The wrapper lives exactly as long as something retains the document. Released by its last
         * viewer, it leaves the cache at once — so a reopen gets a fresh wrapper over whatever engine
         * the inner store has by then — and its pending plaintext is written before the inner retain
         * is let go, or the engine could be retired mid-write.
         */
        retainDocument: capabilities.retainDocument
            ? (target: string) => {
                  const release = capabilities.retainDocument!(target)
                  retains.set(target, (retains.get(target) ?? 0) + 1)
                  let released = false
                  return () => {
                      if (released) return
                      released = true
                      const next = (retains.get(target) ?? 1) - 1
                      if (next > 0) {
                          retains.set(target, next)
                          release()
                          return
                      }
                      retains.delete(target)
                      collabBound.delete(target)
                      const wrapped = open.get(target)
                      open.delete(target)
                      if (!wrapped) {
                          release()
                          return
                      }
                      const done: Promise<void> = wrapped
                          .commit()
                          .catch(() => {})
                          .finally(() => {
                              wrapped.dispose()
                              closing.delete(done)
                              release()
                          })
                      closing.add(done)
                  }
              }
            : undefined,

        /**
         * The content is real once this resolves. If the document was handed a `Y.Text` because
         * its text had not seeded when the editor asked, and it turns out to hold protected
         * content, that editor is bound to the CRDT and can never show a projection — the
         * workspace is told, and remounts it on the non-collaborative path.
         */
        whenReady: capabilities.whenReady
            ? async (target: string) => {
                  await capabilities.whenReady!(target)
                  const wrapped = open.get(target)
                  if (!wrapped) return
                  if (collabBound.has(target) && wrapped.isProtected) {
                      collabBound.delete(target)
                      deps.onCollabBoundProtected?.(target)
                  }
                  // On a Server Backend the text seeds after `open`, so this is the first moment
                  // the document is known to be protected - announce it again for whatever
                  // `onOpened` decides from that (the padlock, coming back from a mask).
                  if (wrapped.isProtected) deps.onOpened?.(target)
                  void wrapped.unlock()
              }
            : undefined,

        /**
         * Withheld for a Protected Document, forwarded for everything else.
         *
         * Withholding it is what makes ADR 0002's "protected content cannot be co-edited"
         * structural rather than a rule someone has to remember: with no `Y.Text` the editor takes
         * the non-collaborative path, binds to the projected plaintext, and writes back through
         * `applyChange` as the whole-document replacement ADR 0028 requires. Handing over the real
         * `Y.Text` would bind CodeMirror straight to the ciphertext and bypass the projection.
         */
        getYText: capabilities.getYText
            ? (target: string) => {
                  if (isProtected(target)) {
                      collabBound.delete(target)
                      return undefined
                  }
                  const ytext = capabilities.getYText!(target)
                  if (ytext !== undefined) collabBound.add(target)
                  return ytext
              }
            : undefined,

        /**
         * Withheld for a Protected Document, which is where presence suppression comes from: with
         * no awareness there are no remote cursors on it, and — the point — this client never
         * advertises its own caret, so a Player cannot see that you are sitting in a protected
         * document even though they can see the document exists.
         */
        getAwareness: capabilities.getAwareness
            ? (target: string) => (isProtected(target) ? undefined : capabilities.getAwareness!(target))
            : undefined,

        async unlockAll() {
            await Promise.all([...open.values()].map((doc) => doc.unlock()))
        },

        async relockAll() {
            await Promise.all([...open.values()].map((doc) => doc.relock()))
        },

        maskAll() {
            for (const doc of open.values()) doc.mask()
        },

        unmaskAll() {
            for (const doc of open.values()) doc.unmask()
        },

        async commitAll() {
            await Promise.all([...[...open.values()].map((doc) => doc.commit()), ...closing])
        },

        async reproject(target: string) {
            await open.get(target)?.reproject()
        },

        protect(target: string, armoured: string, body: string): boolean {
            return open.get(target)?.protect(armoured, body) ?? false
        },

        get hasPendingWrites() {
            return [...open.values()].some((doc) => doc.isDirty)
        },

        protectionKindFor(target: string): DocumentProtectionKind | undefined {
            // Answered off the wrapper, which already holds the inner document: calling
            // `inner.open()` again would take another retain on a Server Backend.
            return open.get(target)?.protectionKind
        },

        dispose() {
            for (const doc of open.values()) doc.dispose()
            open.clear()
        },
    }

    /**
     * Everything not overridden delegates to the inner store.
     *
     * Hand-listing the methods to forward was tried first and is wrong: a `DocumentStore` is used
     * through far more than its declared interface — `listDocuments`, `scan`, `rename`, the index
     * surface — and the first version silently dropped all of them, so the sidebar died with
     * `store.listDocuments is not a function` and the workspace hung on "Loading document".
     * Delegating by default means a store method added later keeps working without anyone
     * remembering this file exists.
     *
     * `Reflect.get` binds to the inner store, not the proxy, so the delegated methods still reach
     * the private state they belong to.
     */
    return new Proxy(inner, {
        get(target, property) {
            if (property in overrides) return overrides[property]
            const value = Reflect.get(target, property, target) as unknown
            return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value
        },
        has(target, property) {
            return property in overrides || Reflect.has(target, property)
        },
    }) as unknown as ProtectedDocumentStore
}
