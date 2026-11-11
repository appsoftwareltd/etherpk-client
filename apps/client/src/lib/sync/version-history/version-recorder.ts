/**
 * Makes a graph's [[Document Version]]s on this device (ADR 0184).
 *
 * Two kinds:
 *
 * - **Before an operation.** A delete, a rename or merge, a replace-all, removing protection, a
 *   restore and an agent's first write each call {@link VersionRecorder.record} first. The text is
 *   read at that moment, before the operation changes it, sealed, and put in the outbox. The
 *   operation does not wait on the network: the outbox sends the version straight after, or when
 *   the connection returns.
 * - **Idle.** After a local edit, once the document has had no edit for `idleMs` and at least
 *   ten minutes have passed since this device's last version of it. Edits still waiting when the
 *   document is closed, the page is left or the graph closes are kept then, through
 *   {@link VersionRecorder.settle}: otherwise the last edits of a session would be in no version
 *   until the next session's first edit had already changed them.
 *
 * A sent version is read back and opened before it is marked verified: the server lists only
 * verified versions, so one that cannot be read never appears.
 */
import { IDLE_VERSION_GAP_MS, type VersionReason } from '@appsoftwareltd/etherpk-shared'
import { keyringReader, type KeyringSource } from '#lib/crypto/index.js'
import { VersionApiError, VersionApiUnavailableError, type VersionApi } from './version-api'
import type { QueuedVersion, VersionOutbox } from './version-outbox'
import { openVersion, sealVersion, type DocumentVersionPayload, type VersionIdentity } from './version-payload'

/** A document's text and identity at one moment. */
export interface VersionSnapshot {
    text: string
    identity: VersionIdentity
}

export interface VersionSource {
    /**
     * The document as it stands now, read synchronously, or null when it cannot be read as its
     * real content (unknown, not loaded, or locked): a version of a guess would be worse than none.
     */
    read(docId: string): VersionSnapshot | null
}

/** `queued`: sealed and in the outbox. `unreadable`: nothing was made. */
export type RecordOutcome = 'queued' | 'unreadable'

export interface VersionRecorderDeps {
    graphId: string
    keyring: KeyringSource
    api: VersionApi
    outbox: VersionOutbox
    source: VersionSource
    newVersionId?: () => string
    now?: () => number
    setTimer?: (run: () => void, ms: number) => unknown
    clearTimer?: (timer: unknown) => void
    /** How long a document goes without a local edit before an idle version. */
    idleMs?: number
    /** The least time between this device's versions of one document. */
    gapMs?: number
    /** How long to wait before sending again after the server could not be reached. */
    retryMs?: number
    /** The server refused a version for good (an inactive plan, a full allowance). It is dropped. */
    onRefused?: (error: VersionApiError, version: QueuedVersion) => void
}

export interface VersionRecorder {
    /**
     * Seal the document as it stands now and queue it. With `wait`, resolve only once the outbox
     * has tried to send it: the Headless Client waits, because it keeps no outbox across a restart.
     */
    record(docId: string, reason: VersionReason, options?: { wait?: boolean; snapshot?: VersionSnapshot }): Promise<RecordOutcome>
    /**
     * Drop what is waiting for `docId`, sent or idle: after it is protected, its earlier versions
     * are removed and none made before the protect may arrive afterwards (ADR 0184).
     */
    forget(docId: string): Promise<void>
    /** A local edit to `docId`: an idle version follows once the edits stop. */
    noteLocalEdit(docId: string): void
    /**
     * Keep now the edits to `docId` (or to every document) that are in no version yet, instead of
     * waiting for the idle version: the document was closed, or the person left the page. The
     * text is read synchronously, so a page being hidden has what it needs before it goes.
     */
    settle(docId?: string): void
    /** Send everything waiting in the outbox. Never rejects. */
    flush(): Promise<void>
    dispose(): void
}

interface DocumentTimer {
    dirty: boolean
    timer: unknown
    lastRecordedAt: number
}

const IDLE_MS = 30_000
const RETRY_MS = 60_000

class VersionMismatchError extends Error {}

export function createVersionRecorder(deps: VersionRecorderDeps): VersionRecorder {
    const keyring = keyringReader(deps.keyring)
    const now = deps.now ?? Date.now
    const setTimer = deps.setTimer ?? ((run: () => void, ms: number) => setTimeout(run, ms))
    const clearTimer = deps.clearTimer ?? ((timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>))
    const newVersionId = deps.newVersionId ?? (() => crypto.randomUUID())
    const idleMs = deps.idleMs ?? IDLE_MS
    const gapMs = deps.gapMs ?? IDLE_VERSION_GAP_MS
    const retryMs = deps.retryMs ?? RETRY_MS
    const documents = new Map<string, DocumentTimer>()
    let retryTimer: unknown = null
    let flushing: Promise<void> | null = null
    /** Versions read and being sealed, which a flush waits for so it sends them too. */
    const sealing = new Set<Promise<unknown>>()
    let flushAgain = false
    let disposed = false

    const stateOf = (docId: string): DocumentTimer => {
        let state = documents.get(docId)
        if (!state) {
            state = { dirty: false, timer: null, lastRecordedAt: Number.NEGATIVE_INFINITY }
            documents.set(docId, state)
        }
        return state
    }

    async function record(
        docId: string,
        reason: VersionReason,
        options: { wait?: boolean; snapshot?: VersionSnapshot } = {},
    ): Promise<RecordOutcome> {
        if (disposed) return 'unreadable'
        // Read before the first await: the caller changes the text as soon as this returns a promise.
        const snapshot = options.snapshot ?? deps.source.read(docId)
        if (!snapshot) return 'unreadable'
        const payload: DocumentVersionPayload = { v: 1, identity: snapshot.identity, text: snapshot.text }
        const versionId = newVersionId()
        const queuedAt = now()
        stateOf(docId).lastRecordedAt = queuedAt
        const queued = (async () => {
            const sealed = await sealVersion({ keyring: keyring(), graphId: deps.graphId, docId, versionId, payload })
            await deps.outbox.put(deps.graphId, { docId, versionId, reason, epochId: sealed.epochId, envelope: sealed.envelope, queuedAt })
        })()
        sealing.add(queued)
        try {
            await queued
        } finally {
            sealing.delete(queued)
        }
        const sending = flush()
        if (options.wait) await sending
        return 'queued'
    }

    /** Send one version, read it back, check it opens to what was sealed, and mark it verified. */
    async function send(version: QueuedVersion): Promise<void> {
        const status = await deps.api.upload(version.docId, version)
        if (status === 'skipped') return
        const ring = keyring()
        const open = (envelope: Uint8Array) =>
            openVersion({ keyring: ring, graphId: deps.graphId, docId: version.docId, versionId: version.versionId, envelope })
        const [sent, stored] = await Promise.all([open(version.envelope), deps.api.get(version.docId, version.versionId).then((got) => open(got.envelope))])
        if (JSON.stringify(sent) !== JSON.stringify(stored)) throw new VersionMismatchError('The stored version does not match')
        await deps.api.verify(version.docId, version.versionId)
    }

    /** The same version sealed again under the graph's current epoch, for a server that moved on. */
    async function resealed(version: QueuedVersion): Promise<QueuedVersion> {
        const ring = keyring()
        const payload = await openVersion({ keyring: ring, graphId: deps.graphId, docId: version.docId, versionId: version.versionId, envelope: version.envelope })
        const sealed = await sealVersion({ keyring: ring, graphId: deps.graphId, docId: version.docId, versionId: version.versionId, payload })
        return { ...version, epochId: sealed.epochId, envelope: sealed.envelope }
    }

    function scheduleRetry(): void {
        if (retryTimer !== null || disposed) return
        retryTimer = setTimer(() => {
            retryTimer = null
            void flush()
        }, retryMs)
    }

    /** Send one version, sealing it again once if the server has moved to a new epoch. */
    async function sendCurrent(version: QueuedVersion): Promise<QueuedVersion> {
        try {
            await send(version)
            return version
        } catch (error) {
            if (!(error instanceof VersionApiError) || error.code !== 'stale_epoch') throw error
            const again = await resealed(version)
            await deps.outbox.put(deps.graphId, again)
            await send(again)
            return again
        }
    }

    /**
     * What a failed send means: `retry` keeps the version and tries again later (no connection,
     * or a key this device has not collected yet); `drop` removes it, because sending it again
     * will not change the answer.
     */
    function onSendFailure(error: unknown, version: QueuedVersion): 'retry' | 'drop' {
        if (error instanceof VersionApiUnavailableError) return 'retry'
        if (error instanceof VersionApiError && error.code === 'future_epoch') return 'retry'
        if (error instanceof VersionApiError) deps.onRefused?.(error, version)
        return 'drop'
    }

    async function drain(): Promise<void> {
        for (const queued of await deps.outbox.list(deps.graphId)) {
            if (disposed) return
            try {
                const sent = await sendCurrent(queued)
                await deps.outbox.remove(deps.graphId, sent.versionId)
            } catch (error) {
                if (onSendFailure(error, queued) === 'retry') {
                    scheduleRetry()
                    return
                }
                await deps.outbox.remove(deps.graphId, queued.versionId)
            }
        }
    }

    function flush(): Promise<void> {
        if (disposed) return Promise.resolve()
        // A version asked for a moment ago is still being sealed: wait for it, then send it with the rest.
        if (sealing.size > 0) return Promise.allSettled([...sealing]).then(() => flush())
        if (flushing) {
            flushAgain = true
            return flushing
        }
        flushing = (async () => {
            do {
                flushAgain = false
                await drain().catch(() => scheduleRetry())
            } while (flushAgain && !disposed)
        })().finally(() => {
            flushing = null
        })
        return flushing
    }

    function onIdle(docId: string): void {
        const state = stateOf(docId)
        state.timer = null
        if (!state.dirty || disposed) return
        const wait = state.lastRecordedAt + gapMs - now()
        if (wait > 0) {
            state.timer = setTimer(() => onIdle(docId), wait)
            return
        }
        keepIdle(docId, state)
    }

    function keepIdle(docId: string, state: DocumentTimer): void {
        state.dirty = false
        void record(docId, 'idle').catch(() => undefined)
    }

    function settle(docId?: string): void {
        if (disposed) return
        for (const [id, state] of docId === undefined ? documents : [[docId, documents.get(docId)] as const]) {
            if (!state?.dirty) continue
            if (state.timer !== null) clearTimer(state.timer)
            state.timer = null
            keepIdle(id, state)
        }
    }

    return {
        record,
        noteLocalEdit(docId) {
            if (disposed) return
            const state = stateOf(docId)
            state.dirty = true
            if (state.timer !== null) clearTimer(state.timer)
            state.timer = setTimer(() => onIdle(docId), idleMs)
        },
        settle,
        flush,
        async forget(docId) {
            const state = documents.get(docId)
            if (state) {
                if (state.timer !== null) clearTimer(state.timer)
                documents.delete(docId)
            }
            // Wait for a send in progress, so a version it is sending is not uploaded after this.
            await flushing
            for (const version of await deps.outbox.list(deps.graphId)) {
                if (version.docId === docId) await deps.outbox.remove(deps.graphId, version.versionId)
            }
        },
        dispose() {
            disposed = true
            for (const state of documents.values()) if (state.timer !== null) clearTimer(state.timer)
            if (retryTimer !== null) clearTimer(retryTimer)
            documents.clear()
        },
    }
}
