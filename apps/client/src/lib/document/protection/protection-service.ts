/**
 * One graph's protection: the record, the key while it is held, and the lock lifecycle around it.
 *
 * This is the only place a Protection Key exists in memory, and it exists nowhere else at all —
 * not in `localStorage`, not in IndexedDB, not in the Local Cache. That is what ADR 0057's third
 * adversary (the device at rest) requires, and it is why every read here is asynchronous and can
 * fail with {@link ProtectionUnavailableError} rather than returning stale plaintext.
 *
 * Deliberately not a Svelte module: the clock, the settings and the commit callback are injected,
 * so the whole lifecycle is unit-testable without a browser. `protection-session.svelte.ts` wraps
 * this in runes and wires the real browser events to it.
 */
import {
    type ProtectionKdfParams,
    type ProtectionRecord,
    armourProtected,
    changeProtectionPassphrase,
    createProtectionRecord,
    keyFingerprint,
    newKdfParams,
    openProtected,
    resolveLastWriteWins,
    sealProtected,
    unarmourProtected,
    toBase64Url,
    unlockProtectionRecord,
} from '$lib/crypto'

import {
    type CipherFence,
    cipherFences,
    documentBody,
    documentProtection,
    protectDocumentText,
    replaceCipherFenceBody,
} from './cipher-fence'
import {
    type LockEvent,
    type LockSettings,
    type LockState,
    type LockStatus,
    initialLockState,
    lockReducer,
} from './lock-machine'
import type { ProtectionRecordRead, ProtectionRecordStore } from './protection-store'

export class ProtectionUnavailableError extends Error {
    constructor(message = 'this content is locked') {
        super(message)
        this.name = 'ProtectionUnavailableError'
    }
}

/**
 * Why a fence cannot be shown, which decides what the editor offers the reader.
 *
 * Whose key a fence wants is only answerable once the record has been read, so until then -
 * and after a read that failed - every fence with a fingerprint is `locked`, never
 * `other-member`: Unlock is an offer that waits for the record, whereas "no passphrase of yours
 * will open it" is a verdict, and a wrong one teaches the user to stop trying.
 */
export type FenceUnreadableReason =
    /** Ours, or not yet knowable, and the key is not in memory — offer to unlock. */
    | 'locked'
    /** Ours, key held, content on screen. */
    | 'readable'
    /** Another member's Protection Key. No passphrase of ours will ever open it. */
    | 'other-member'
    /** The body holds nothing that parses as an envelope. */
    | 'unreadable'

export interface FenceDescription {
    fence: CipherFence
    reason: FenceUnreadableReason
}

/**
 * What the last read of the record established. `unread` until `load()` lands; `unreadable`
 * when the read rejected (a locked vault, an unreachable server, a folder whose permission went);
 * the store's own answer otherwise. `isConfigured`, `fingerprint`, the refusals and the fence
 * classification all derive from this one value, so they cannot disagree with each other - the
 * three flags this replaced could.
 */
type RecordState = { kind: 'unread' } | { kind: 'unreadable'; cause: unknown } | ProtectionRecordRead

/** Why the record cannot be believed, with the sentence a user can act on. */
export interface RecordProblem {
    /** `unreadable`: the read failed; try again. `invalid`: it succeeded and found something this build cannot use. */
    kind: 'unreadable' | 'invalid'
    /** Lower case, so it reads after "Could not set the passphrase:" as well as on its own. */
    message: string
}

export interface ProtectionServiceDeps {
    store: ProtectionRecordStore
    now(): number
    settings(): LockSettings
    /**
     * Flush pending plaintext. Called before the key is discarded on every lock transition, and on
     * masking. The key is still held when this runs, so it cannot fail for want of one.
     */
    commit(): Promise<void>
    /** Argon2id cost for records this service creates. Tests override it; production uses the default. */
    kdfCost?: Omit<ProtectionKdfParams, 'salt'>
}

export class ProtectionService {
    /** The lock flush in flight, if any — see `#dispatch`. */
    #flushing: Promise<void> = Promise.resolve()
    #deps: ProtectionServiceDeps
    #read: RecordState = { kind: 'unread' }
    #state: LockState = initialLockState()

    constructor(deps: ProtectionServiceDeps) {
        this.#deps = deps
    }

    /** The usable record, or null. Null says nothing about why - ask `#read` for that. */
    get #record(): ProtectionRecord | null {
        return this.#read.kind === 'ok' ? this.#read.record : null
    }

    /**
     * Read the graph's record. Safe to call repeatedly; a graph opens Locked either way.
     *
     * A read that fails does not fail the graph open. On a Server Backend the record lives in the
     * account vault, and a device whose vault is locked cannot read it - which must mean "this
     * graph has no protection I can see", not "this graph will not open". But it is remembered as
     * unreadable rather than absent: nothing that would WRITE a record may take that answer at its
     * word, and every fence stays locked - never "another member's" - until a read succeeds. A
     * store that finds a record it cannot use answers `invalid` on its own, and is held to the
     * same rule.
     */
    async load(): Promise<void> {
        try {
            this.#read = await this.#deps.store.read()
        } catch (cause) {
            this.#read = { kind: 'unreadable', cause }
        }
    }

    get isConfigured(): boolean {
        return this.#read.kind === 'ok'
    }

    /**
     * Whether `isConfigured` and `fingerprint` can be believed: the record has been read, and the
     * read gave a straight answer - a record, or nothing there. False before `load()` lands - it
     * is off the graph-open critical path, a vault fetch on a Server Backend - after a read that
     * failed, and over a record this build cannot use. In all three a fence's owner is unknown,
     * which is not the same as someone else.
     */
    get isRecordKnown(): boolean {
        return this.#read.kind === 'ok' || this.#read.kind === 'missing'
    }

    /**
     * The last read did not yield a usable record: it failed, or what it found cannot be used.
     * Either way the graph may well hold a record this device cannot see right now, and
     * `isConfigured` means "could not see", not "none". {@link recordProblem} says which.
     */
    get isUnreadable(): boolean {
        return this.#read.kind === 'unreadable' || this.#read.kind === 'invalid'
    }

    /**
     * Why `isUnreadable`, for the message the host shows and the refusals below, or null when the
     * record is known or not yet read. Two problems, two sentences: a failed read wants another
     * try, a damaged file wants a backup, and a record from a newer build wants this build updated
     * - "check your connection" over a mangled `protection.json` sent people looking in the wrong
     * place entirely.
     */
    get recordProblem(): RecordProblem | null {
        switch (this.#read.kind) {
            case 'unreadable':
                return { kind: 'unreadable', message: 'could not read this graph’s protection record; check your connection and try again' }
            case 'invalid':
                return { kind: 'invalid', message: invalidRecordMessage(this.#read) }
            default:
                return null
        }
    }

    get status(): LockStatus {
        return this.#state.status
    }

    /** base64url of this graph's Protection Key fingerprint, or null when unconfigured. */
    get fingerprint(): string | null {
        return this.#record?.fingerprint ?? null
    }

    /** The moment a `tick` could next change the state, for the host to schedule against. */
    get wakeAt(): number | null {
        return this.#state.wakeAt
    }

    /** Turn protection on for this graph. Leaves it unlocked so the user can protect something now. */
    async enable(passphrase: string): Promise<void> {
        // Always re-read: a record that failed to load earlier is still a record, and writing a
        // fresh key over it would orphan every document sealed under the old one. Only a store
        // that is sure nothing is there lets this through.
        await this.load()
        const problem = this.recordProblem
        if (problem) throw new ProtectionUnavailableError(problem.message)
        if (this.#read.kind === 'ok') throw new Error('this graph already has a Protection Key')
        const kdf = { ...newKdfParams(), ...(this.#deps.kdfCost ?? {}) }
        const { record, key } = await createProtectionRecord(passphrase, kdf)
        await this.#writeRecord(record)
        this.#read = { kind: 'ok', record }
        this.#dispatch({ type: 'unlocked', key, now: this.#deps.now() })
    }

    /**
     * Re-wrap under a new passphrase. The key is unchanged, so no protected document is touched
     * and every fence already written stays readable.
     */
    async changePassphrase(current: string, next: string): Promise<void> {
        const record = this.#requireRecord()
        const kdf = { ...newKdfParams(), ...(this.#deps.kdfCost ?? {}) }
        const rewrapped = await changeProtectionPassphrase(record, current, next, kdf)
        await this.#writeRecord(rewrapped)
        this.#read = { kind: 'ok', record: rewrapped }
    }

    async unlock(passphrase: string): Promise<void> {
        const key = await unlockProtectionRecord(this.#requireRecord(), passphrase)
        this.#dispatch({ type: 'unlocked', key, now: this.#deps.now() })
    }

    /** Unlock from a device passkey wrap, which has already yielded the key. */
    unlockWithKey(key: Uint8Array): void {
        this.#dispatch({ type: 'unlocked', key, now: this.#deps.now() })
    }

    lockNow(): void {
        this.#dispatch({ type: 'lockNow', now: this.#deps.now() })
    }

    onHidden(): void {
        this.#dispatch({ type: 'hidden', now: this.#deps.now() })
    }

    onBlurred(): void {
        this.#dispatch({ type: 'blurred', now: this.#deps.now() })
    }

    onNavigatedAway(): void {
        this.#dispatch({ type: 'navigatedAway', now: this.#deps.now() })
    }

    onShown(): void {
        this.#dispatch({ type: 'shown', now: this.#deps.now() })
    }

    onActivity(): void {
        this.#dispatch({ type: 'activity', now: this.#deps.now() })
    }

    tick(): void {
        this.#dispatch({ type: 'tick', now: this.#deps.now() })
    }

    /** Seal plaintext into an armoured envelope ready for a fence body. */
    async encrypt(plaintext: string): Promise<string> {
        const key = this.#requireKey(true)
        return armourProtected(
            await sealProtected({
                key,
                fingerprint: await keyFingerprint(key),
                plaintext,
                writtenAt: this.#deps.now(),
            }),
        )
    }

    /** Turn a document into a [[Protected Document]] — the whole body becomes one fence. */
    async protectDocument(text: string): Promise<string> {
        const body = bodySourceOf(text)
        return protectDocumentText(text, await this.encrypt(body))
    }

    /** The plaintext body of a Protected Document. Throws while locked rather than guessing. */
    async readDocument(text: string): Promise<string> {
        const protection = documentProtection(text)
        const fence = protection.fences[0]
        if (!fence?.winner) throw new ProtectionUnavailableError('this document holds no readable protected content')
        return this.decrypt(fence)
    }

    async decrypt(fence: CipherFence): Promise<string> {
        if (!fence.winner) throw new ProtectionUnavailableError('this fence holds no readable envelope')
        const key = this.#requireKey()
        return (await openProtected({ key, envelope: fence.winner })).plaintext
    }

    /**
     * Open one armoured fence body. The projection works envelope by envelope rather than
     * document by document, because a document can hold several protected blocks and each is
     * decrypted and re-encrypted on its own.
     */
    async decryptArmoured(armoured: string): Promise<string> {
        const key = this.#requireKey()
        const envelope = resolveLastWriteWins(unarmourProtected(armoured))
        if (!envelope) throw new ProtectionUnavailableError('this fence holds no readable envelope')
        return (await openProtected({ key, envelope })).plaintext
    }

    /** Classify every fence in a document, so the editor knows what to render for each. */
    describeFences(text: string): FenceDescription[] {
        const mine = this.fingerprint
        const known = this.isRecordKnown
        const held = this.#state.key !== null && this.#state.status === 'unlocked'
        return documentProtection(text).fences.map((fence) => {
            if (!fence.fingerprint) return { fence, reason: 'unreadable' as const }
            // Not yet knowable is locked, the safe default (ADR 0057). Classifying against "no
            // record yet" drew "Protected by another member" over the user's own page for as long
            // as the vault fetch took, then silently swapped it for Unlock when the record landed.
            if (!known) return { fence, reason: 'locked' as const }
            const belongsToUs = mine !== null && toBase64Url(fence.fingerprint) === mine
            if (!belongsToUs) return { fence, reason: 'other-member' as const }
            return { fence, reason: held ? ('readable' as const) : ('locked' as const) }
        })
    }

    /**
     * Rewrite any fence holding more than one envelope down to its last-write-wins survivor,
     * returning the new text or null when nothing needed it. This is where ADR 0028's discard
     * physically happens; ADR 0059 records that the loser can be your own work.
     */
    collapseFences(text: string): string | null {
        const lines = text.split('\n')
        const fences = cipherFences(lines).filter((f) => f.needsCollapse && f.winner)
        if (fences.length === 0) return null
        // Back to front, so an earlier fence's line indices stay valid as later ones shrink.
        let next = lines
        for (const fence of [...fences].reverse()) {
            const edit = replaceCipherFenceBody(fence, armourProtected(fence.winner!))
            next = [...next.slice(0, edit.fromLine), edit.text, ...next.slice(edit.toLine + 1)]
        }
        return next.join('\n')
    }

    /**
     * The Protection Key while it is held, or null. Used to bind a passkey on this device, which
     * needs the key itself rather than anything derived from it.
     */
    heldKey(): Uint8Array | null {
        // Not merely "is there key material": during a lock's flush the key lingers for the
        // commit alone, and this graph is locked to everything else.
        return this.#state.status === 'locked' ? null : this.#state.key
    }

    /**
     * The record, or a refusal that says why there is none to use: a damaged file is not "no
     * Protection Key", and the unlock prompt must not say it is.
     */
    #requireRecord(): ProtectionRecord {
        const record = this.#record
        if (!record) throw new ProtectionUnavailableError(this.recordProblem?.message ?? 'this graph has no Protection Key')
        return record
    }

    /**
     * Write a record, refusing to replace one with a different fingerprint: a passphrase change
     * re-wraps the same key, and nothing else may put a second key where one already is.
     *
     * The read here, right before the write, is the one that counts: a record that landed since
     * the last load - from another device, or one an earlier failed read could not see - must
     * still stop this. A rejection propagates, so nothing is written over a read that failed, and
     * a record this build cannot use stops the write the same way it stops `enable`.
     */
    async #writeRecord(record: ProtectionRecord): Promise<void> {
        const current = await this.#deps.store.read()
        if (current.kind === 'invalid') throw new ProtectionUnavailableError(invalidRecordMessage(current))
        if (current.kind === 'ok' && current.record.fingerprint !== record.fingerprint) {
            throw new Error('this graph already has a Protection Key')
        }
        await this.#deps.store.write(record)
    }

    /**
     * The key, or a refusal. Reads refuse the moment the graph is locked; a write may still use
     * the key that lingers for the lock's own flush (see `#dispatch`) - that flush IS the write.
     */
    #requireKey(forWriting = false): Uint8Array {
        if (!this.#record) throw new ProtectionUnavailableError('this graph has no Protection Key')
        // Masked is not readable: nothing may be decrypted onto a screen the user has left.
        if (!forWriting && this.#state.status !== 'unlocked') throw new ProtectionUnavailableError('this content is locked')
        if (!this.#state.key) throw new ProtectionUnavailableError('this content is locked')
        return this.#state.key
    }

    #dispatch(event: LockEvent): void {
        const { state, effects } = lockReducer(this.#state, event, this.#deps.settings())
        const commit = effects.some((e) => e.kind === 'commit') ? this.#deps.commit().catch(() => {}) : null
        const discards = effects.some((e) => e.kind === 'discardKey')
        if (!discards || !commit) {
            this.#state = state
            return
        }
        // The reducer says the key goes. Adopt everything else now — the status reads as locked
        // at once, and nothing decrypts for the screen again — but keep the key material until
        // the flush that was fired with it has settled. The commit is asynchronous (it encrypts),
        // so nulling the key in the same synchronous step let it lose the race and fail with
        // "this content is locked", and the plaintext edit it was carrying was then discarded by
        // the relock. Seen in test. `describeFences` and `heldKey` answer from the status, so the
        // lingering key is visible to nothing but the commit.
        const lingering = this.#state.key
        this.#state = { ...state, key: lingering }
        this.#flushing = commit.finally(() => {
            if (this.#state.status === 'locked' && this.#state.key === lingering) {
                this.#state = { ...this.#state, key: null }
                // Overwritten, not merely dropped: a garbage-collected runtime makes no promise
                // about when the bytes go, and this one costs nothing.
                lingering?.fill(0)
            }
        })
    }

    /** Settles once a lock's flush has finished and the key is truly gone. For tests. */
    async flushed(): Promise<void> {
        await this.#flushing
    }
}

/**
 * The sentence for a record that is there but cannot be used. It names where the record lives,
 * because that is what the person has to go and look at, and gives the advice that fits the
 * problem - the two are not interchangeable (see `ProtectionRecordProblem`).
 */
function invalidRecordMessage(read: Extract<ProtectionRecordRead, { kind: 'invalid' }>): string {
    return read.problem === 'newer-version'
        ? `${read.location} was written by a newer version of EtherPK; update EtherPK to use it`
        : `${read.location} is damaged; restore it from a backup`
}

/** A document's body, refusing to double-protect something that already holds a fence. */
function bodySourceOf(text: string): string {
    if (documentProtection(text).kind !== 'none') throw new Error('this document is already protected')
    return documentBody(text)
}
