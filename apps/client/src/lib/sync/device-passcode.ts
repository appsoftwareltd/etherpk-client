/**
 * The Device Passcode (ADR 0129): an optional passcode, set per device, that keeps the keys this
 * device caches for its synced graphs, and its custom servers' access tokens, encrypted in
 * localStorage. It protects those secrets, not documents already cached on the device.
 *
 * Off, the secrets are stored as they always were. On, each is stored sealed under a key stretched
 * from the passcode with Argon2id (prefix `pc1:`), with the protected-documents settings and bounds.
 * A record beside them holds the stretch's settings and a check value, so a passcode can be checked
 * with nothing else cached. Unlocking derives the key, checks it, and opens every sealed secret into
 * memory, where reads stay synchronous: `getVaultWrapKey` is read on hot paths.
 *
 * Tabs of the origin share one unlock over a BroadcastChannel: a new tab asks the open ones for the
 * key before it asks the user, a lock or a turn-off in one tab applies to every tab, and a secret
 * written or forgotten in one tab is written or forgotten in the others' memory too.
 *
 * Where the secrets live is not this module's business: each store (`vault-session.ts` for vault
 * keys, `sync-connections.ts` for access tokens) registers itself, and this module asks it for its
 * entries when it seals, opens or removes them all.
 */
import {
    bytesEqual,
    contextAad,
    fromBase64Url,
    kdfParamsSane,
    newKdfParams,
    openSymmetric,
    sealSymmetric,
    stretchPassphrase,
    toBase64Url,
    utf8,
    type ProtectionKdfParams,
} from '$lib/crypto'
import { VaultLockedError } from './vault-locked'

/** Where the passcode's record lives: the stretch's settings and a check value, no secret. */
export const DEVICE_PASSCODE_RECORD_KEY = 'etherpk:device-passcode'
/** The shortest passcode taken. Shorter than {@link DEVICE_PASSCODE_ADVISED_LENGTH} is allowed, with advice. */
export const DEVICE_PASSCODE_MIN_LENGTH = 4
/** Below this a passcode stops someone at the keyboard, not someone with a copy of the device's data. */
export const DEVICE_PASSCODE_ADVISED_LENGTH = 8

const SEALED_PREFIX = 'pc1:'
const CHANNEL_NAME = 'etherpk-device-passcode'
const CHECK = utf8('etherpk/device-passcode/check/v1')
const CHECK_AAD = contextAad('device-passcode', 'check')
/** Each secret is sealed to its own place, so a sealed value cannot be moved to another. */
const secretAad = (id: string) => contextAad('device-passcode', 'secret', id)

export type DevicePasscodeState = 'off' | 'locked' | 'unlocked'

/** The device has a passcode and it has not been entered in this browser session. */
export class DevicePasscodeLockedError extends VaultLockedError {
    constructor() {
        super("The keys on this device are protected by its passcode, which has not been entered in this browser session")
        this.name = 'DevicePasscodeLockedError'
    }
}

export class WrongDevicePasscodeError extends Error {
    constructor() {
        super("That is not this device's passcode")
        this.name = 'WrongDevicePasscodeError'
    }
}

/** Somewhere sealed secrets live. Each lists its entries as stored, and writes or removes one. */
export interface DeviceSecretStore {
    entries(): Array<{ id: string; stored: string }>
    write(id: string, stored: string): void
    remove(id: string): void
}

interface PasscodeRecord {
    v: 1
    kdf: ProtectionKdfParams
    /** The check value, sealed under the passcode key. */
    check: string
}

/** The part of BroadcastChannel this module uses, so a test can stand one in. */
interface ChannelLike {
    postMessage(message: unknown): void
    onmessage: ((event: { data: unknown }) => void) | null
}

type Message =
    | { type: 'ask' }
    | { type: 'key'; key: string }
    | { type: 'unlocked'; key: string }
    | { type: 'locked' }
    | { type: 'off' }
    | { type: 'secret'; id: string; plain: string }
    | { type: 'forget'; id: string }

export interface DevicePasscodeDeps {
    storage: () => Storage | undefined
    channel: () => ChannelLike | null
    /** Test seam: Argon2id is slow on purpose. */
    stretch?: (passcode: string, kdf: ProtectionKdfParams) => Promise<Uint8Array>
    /** How long a new tab waits for an open one to hand over the key. */
    answerWithinMs?: number
}

export type DevicePasscode = ReturnType<typeof createDevicePasscode>

export function createDevicePasscode(deps: DevicePasscodeDeps) {
    const stretch = deps.stretch ?? stretchPassphrase
    const answerWithinMs = deps.answerWithinMs ?? 800
    const stores: DeviceSecretStore[] = []
    const listeners = new Set<(state: DevicePasscodeState) => void>()
    /** The passcode key, while this tab is unlocked. */
    let key: Uint8Array | null = null
    /** Every secret this tab has opened, by id, while unlocked. */
    const revealed = new Map<string, string>()
    /** Secrets written while locked: held in `revealed` and stored at the next unlock. */
    const pending = new Map<string, (stored: string) => void>()
    let keyWaiters: Array<(offered: Uint8Array) => void> = []
    let channel: ChannelLike | null | undefined

    function readRecord(): PasscodeRecord | null {
        const raw = deps.storage()?.getItem(DEVICE_PASSCODE_RECORD_KEY)
        if (!raw) return null
        try {
            const record = JSON.parse(raw) as PasscodeRecord
            return record?.v === 1 && record.kdf && typeof record.check === 'string' ? record : null
        } catch {
            return null
        }
    }

    function state(): DevicePasscodeState {
        if (!readRecord()) return 'off'
        return key ? 'unlocked' : 'locked'
    }

    function emit(): void {
        const now = state()
        for (const listener of listeners) listener(now)
    }

    function ensureChannel(): ChannelLike | null {
        if (channel !== undefined) return channel
        channel = deps.channel()
        if (channel) channel.onmessage = (event) => void onMessage(event.data as Message)
        return channel
    }

    function post(message: Message): void {
        ensureChannel()?.postMessage(message)
    }

    async function keyOpensRecord(candidate: Uint8Array, record: PasscodeRecord): Promise<boolean> {
        try {
            const { plaintext } = await openSymmetric({ keyForEpoch: () => candidate, envelope: fromBase64Url(record.check), aad: CHECK_AAD })
            return bytesEqual(plaintext, CHECK)
        } catch {
            return false
        }
    }

    async function seal(id: string, plain: string, withKey: Uint8Array): Promise<string> {
        const envelope = await sealSymmetric({ key: withKey, epochId: 0, plaintext: utf8(plain), aad: secretAad(id) })
        return SEALED_PREFIX + toBase64Url(envelope)
    }

    async function open(id: string, stored: string, withKey: Uint8Array): Promise<string | null> {
        try {
            const { plaintext } = await openSymmetric({
                keyForEpoch: () => withKey,
                envelope: fromBase64Url(stored.slice(SEALED_PREFIX.length)),
                aad: secretAad(id),
            })
            return new TextDecoder().decode(plaintext)
        } catch {
            // Sealed under a key that is gone: unreadable, and treated as absent.
            return null
        }
    }

    async function newRecord(passcode: string): Promise<{ record: PasscodeRecord; key: Uint8Array }> {
        if (passcode.length < DEVICE_PASSCODE_MIN_LENGTH) {
            throw new RangeError(`A passcode needs at least ${DEVICE_PASSCODE_MIN_LENGTH} characters`)
        }
        const kdf = newKdfParams()
        const next = await stretch(passcode, kdf)
        const check = toBase64Url(await sealSymmetric({ key: next, epochId: 0, plaintext: CHECK, aad: CHECK_AAD }))
        return { record: { v: 1, kdf, check }, key: next }
    }

    /** The key `passcode` stretches to under the record, or the refusal for a wrong one. */
    async function keyFor(passcode: string, record: PasscodeRecord): Promise<Uint8Array> {
        // A record outside the bounds is unreadable, never instructions: only Forgot helps then.
        if (!kdfParamsSane(record.kdf)) throw new WrongDevicePasscodeError()
        const candidate = await stretch(passcode, record.kdf)
        if (!(await keyOpensRecord(candidate, record))) throw new WrongDevicePasscodeError()
        return candidate
    }

    /**
     * Take `next` as this tab's key: open every sealed secret into memory, seal any still plain (a
     * crash part way through setting the passcode leaves some), and store what waited for a key.
     */
    async function adopt(next: Uint8Array): Promise<void> {
        for (const store of stores) {
            for (const { id, stored } of store.entries()) {
                if (stored.startsWith(SEALED_PREFIX)) {
                    const plain = await open(id, stored, next)
                    if (plain !== null && !pending.has(id)) revealed.set(id, plain)
                } else {
                    revealed.set(id, stored)
                    store.write(id, await seal(id, stored, next))
                }
            }
        }
        for (const [id, persist] of pending) {
            const plain = revealed.get(id)
            if (plain !== undefined) persist(await seal(id, plain, next))
        }
        pending.clear()
        key = next
        emit()
    }

    function dropKey(): void {
        key = null
        revealed.clear()
        pending.clear()
        emit()
    }

    async function onMessage(message: Message): Promise<void> {
        switch (message.type) {
            case 'ask':
                if (key) post({ type: 'key', key: toBase64Url(key) })
                return
            case 'key':
                for (const waiter of keyWaiters) waiter(fromBase64Url(message.key))
                return
            case 'unlocked': {
                // Another tab unlocked, set or changed the passcode: take its key when it opens the record.
                const record = readRecord()
                const offered = fromBase64Url(message.key)
                if (!record || (key && bytesEqual(key, offered))) return
                if (await keyOpensRecord(offered, record)) await adopt(offered)
                return
            }
            case 'locked':
            case 'off':
                dropKey()
                return
            case 'secret':
                if (key) revealed.set(message.id, message.plain)
                return
            case 'forget':
                revealed.delete(message.id)
                pending.delete(message.id)
                return
        }
    }

    return {
        state,

        /** Hear every change of state, in this tab or another. Returns an unsubscribe. */
        onChange(listener: (state: DevicePasscodeState) => void): () => void {
            ensureChannel()
            listeners.add(listener)
            return () => listeners.delete(listener)
        },

        registerStore(store: DeviceSecretStore): void {
            stores.push(store)
        },

        /** Whether a value as stored is sealed under the passcode. */
        isSealed(stored: string | null | undefined): boolean {
            return typeof stored === 'string' && stored.startsWith(SEALED_PREFIX)
        },

        /**
         * The secret `id` as stored, readable: as it is while the passcode is off, from memory while
         * unlocked. Null when it is sealed and this tab is locked, or not stored at all.
         */
        reveal(id: string, stored: string | null): string | null {
            ensureChannel()
            if (pending.has(id)) return revealed.get(id) ?? null
            // Written here a moment ago and on its way to storage.
            if (stored === null) return key ? (revealed.get(id) ?? null) : null
            if (!stored.startsWith(SEALED_PREFIX)) return stored
            return key ? (revealed.get(id) ?? null) : null
        },

        /**
         * Store `plain` as the secret `id` through `persist`: as it is while the passcode is off,
         * sealed while it is on. Written while locked, it is held in memory and stored sealed at the
         * next unlock. Other tabs read the new value at once.
         */
        async store(id: string, plain: string, persist: (stored: string) => void): Promise<void> {
            ensureChannel()
            if (!readRecord()) {
                persist(plain)
                return
            }
            revealed.set(id, plain)
            if (!key) {
                pending.set(id, persist)
                return
            }
            persist(await seal(id, plain, key))
            post({ type: 'secret', id, plain })
        },

        /** Drop `id` from memory here and in every tab, once its stored entry has been removed. */
        forget(id: string): void {
            revealed.delete(id)
            pending.delete(id)
            post({ type: 'forget', id })
        },

        /** Set a passcode on a device that has none: every stored secret is sealed under it. */
        async set(passcode: string): Promise<void> {
            if (readRecord()) throw new Error('This device already has a passcode')
            const made = await newRecord(passcode)
            // The record first: a crash part way through leaves secrets sealed or still plain, and the
            // next unlock seals what is left.
            deps.storage()?.setItem(DEVICE_PASSCODE_RECORD_KEY, JSON.stringify(made.record))
            await adopt(made.key)
            post({ type: 'unlocked', key: toBase64Url(made.key) })
        },

        /** Unlock this tab with the passcode. Rejects with {@link WrongDevicePasscodeError}. */
        async unlock(passcode: string): Promise<void> {
            const record = readRecord()
            if (!record) return
            await adopt(await keyFor(passcode, record))
            post({ type: 'unlocked', key: toBase64Url(key!) })
        },

        /**
         * Ask the open tabs for the key, waiting a moment for an answer. Resolves to whether this tab
         * is unlocked (or has no passcode) afterwards.
         */
        async unlockFromOtherTabs(): Promise<boolean> {
            const record = readRecord()
            if (!record || key) return true
            const offered = await new Promise<Uint8Array | null>((resolve) => {
                const waiter = (candidate: Uint8Array) => {
                    clearTimeout(timer)
                    keyWaiters = keyWaiters.filter((other) => other !== waiter)
                    resolve(candidate)
                }
                const timer = setTimeout(() => {
                    keyWaiters = keyWaiters.filter((other) => other !== waiter)
                    resolve(null)
                }, answerWithinMs)
                keyWaiters.push(waiter)
                post({ type: 'ask' })
            })
            if (offered && !key && (await keyOpensRecord(offered, record))) await adopt(offered)
            return key !== null
        },

        /** Change the passcode, given the current one: every secret is sealed again under the new one. */
        async change(current: string, next: string): Promise<void> {
            const record = readRecord()
            if (!record) throw new Error('This device has no passcode to change')
            const old = await keyFor(current, record)
            const made = await newRecord(next)
            for (const store of stores) {
                for (const { id, stored } of store.entries()) {
                    const plain = stored.startsWith(SEALED_PREFIX) ? await open(id, stored, old) : stored
                    if (plain === null) continue
                    store.write(id, await seal(id, plain, made.key))
                    revealed.set(id, plain)
                }
            }
            deps.storage()?.setItem(DEVICE_PASSCODE_RECORD_KEY, JSON.stringify(made.record))
            key = made.key
            emit()
            post({ type: 'unlocked', key: toBase64Url(made.key) })
        },

        /** Turn the passcode off, given the current one: every secret is stored as it is again. */
        async turnOff(current: string): Promise<void> {
            const record = readRecord()
            if (!record) return
            const old = await keyFor(current, record)
            for (const store of stores) {
                for (const { id, stored } of store.entries()) {
                    if (!stored.startsWith(SEALED_PREFIX)) continue
                    const plain = await open(id, stored, old)
                    if (plain !== null) store.write(id, plain)
                }
            }
            for (const [id, persist] of pending) {
                const plain = revealed.get(id)
                if (plain !== undefined) persist(plain)
            }
            deps.storage()?.removeItem(DEVICE_PASSCODE_RECORD_KEY)
            dropKey()
            post({ type: 'off' })
        },

        /**
         * The passcode is forgotten, and every secret sealed under it goes with it. The device is
         * unlocked again as a new device is, with the Recovery Code or by approval, and a custom
         * server needs a new access token.
         */
        forgotten(): void {
            for (const store of stores) {
                for (const { id, stored } of store.entries()) if (stored.startsWith(SEALED_PREFIX)) store.remove(id)
            }
            deps.storage()?.removeItem(DEVICE_PASSCODE_RECORD_KEY)
            dropKey()
            post({ type: 'off' })
        },

        /** Lock every tab now: the keys stay sealed in storage and leave memory. */
        lock(): void {
            if (!readRecord()) return
            dropKey()
            post({ type: 'locked' })
        },
    }
}

/** The device's one Device Passcode, over this origin's localStorage and BroadcastChannel. */
export const devicePasscode = createDevicePasscode({
    storage: () => (typeof localStorage === 'undefined' ? undefined : localStorage),
    channel: () => (typeof BroadcastChannel === 'undefined' ? null : (new BroadcastChannel(CHANNEL_NAME) as unknown as ChannelLike)),
})
