import { describe, expect, it, vi } from 'vitest'

import { armourProtected, keyFingerprint, sealProtected, toBase64Url } from '$lib/crypto'
import { createMemoryDirectoryAdapter } from '$lib/storage/fs/memory-adapter'

import { CIPHER_FENCE_INFO, cipherFences, documentProtection } from './cipher-fence'
import { DEFAULT_LOCK_SETTINGS } from './lock-machine'
import { ProtectionService, ProtectionUnavailableError } from './protection-service'
import {
    PROTECTION_FILE,
    type ProtectionRecordRead,
    type ProtectionRecordStore,
    filesystemProtectionStore,
    inMemoryProtectionStore,
} from './protection-store'

/** Cheap Argon2id so the suite stays fast — the cost parameters are proven elsewhere. */
const FAST_KDF = { m: 8, t: 1, p: 1 }

function build(overrides: { commit?: () => Promise<void>; store?: ProtectionRecordStore } = {}) {
    let clock = 0
    const service = new ProtectionService({
        store: overrides.store ?? inMemoryProtectionStore(),
        now: () => clock,
        settings: () => DEFAULT_LOCK_SETTINGS,
        commit: overrides.commit ?? (async () => {}),
        kdfCost: FAST_KDF,
    })
    return { service, advance: (ms: number) => (clock += ms) }
}

async function enabled() {
    const built = build()
    await built.service.enable('correct horse battery staple')
    return built
}

describe('enabling protection', () => {
    it('leaves the graph unlocked, so the user can protect something immediately', async () => {
        const { service } = await enabled()

        expect(service.status).toBe('unlocked')
        expect(service.isConfigured).toBe(true)
    })

    it('publishes the fingerprint every fence written under it will carry', async () => {
        const { service } = await enabled()

        expect(service.fingerprint).toMatch(/^[\w-]+$/)
    })

    it('refuses to enable twice, so an existing key can never be silently replaced', async () => {
        const { service } = await enabled()

        await expect(service.enable('another passphrase')).rejects.toThrow(/already/i)
    })
})

describe('a graph with no protection configured', () => {
    it('reports itself unconfigured and locked', async () => {
        const { service } = build()
        await service.load()

        expect(service.isConfigured).toBe(false)
        expect(service.status).toBe('locked')
    })

    it('refuses to encrypt', async () => {
        const { service } = build()
        await service.load()

        await expect(service.encrypt('secret')).rejects.toThrow(ProtectionUnavailableError)
    })
})

describe('unlocking', () => {
    it('accepts the passphrase and brings the key back', async () => {
        const { service } = await enabled()
        service.lockNow()

        await service.unlock('correct horse battery staple')

        expect(service.status).toBe('unlocked')
    })

    it('rejects the wrong passphrase and stays locked', async () => {
        const { service } = await enabled()
        service.lockNow()

        await expect(service.unlock('guess')).rejects.toThrow()
        expect(service.status).toBe('locked')
    })
})

describe('encrypting and decrypting', () => {
    it('round-trips a document body through a fence', async () => {
        const { service } = await enabled()

        const text = await service.protectDocument('---\ntitle: Bank\n---\nsort code 00-00-00')

        expect(documentProtection(text).kind).toBe('document')
        expect(text).not.toContain('sort code')
        expect(await service.readDocument(text)).toBe('sort code 00-00-00')
    })

    it('stamps the fence with this key’s fingerprint', async () => {
        const { service } = await enabled()

        const text = await service.protectDocument('secret')
        const [fence] = cipherFences(text.split('\n'))

        expect(toBase64Url(fence.fingerprint!)).toBe(service.fingerprint)
    })

    it('refuses to read while locked, rather than returning stale plaintext', async () => {
        const { service } = await enabled()
        const text = await service.protectDocument('secret')

        service.lockNow()

        await expect(service.readDocument(text)).rejects.toThrow(ProtectionUnavailableError)
    })

    it('names another member’s content as unreadable rather than asking for a passphrase', async () => {
        const { service } = await enabled()
        // A Player's protected page in a shared graph: a real fence under a key that is not ours.
        const theirKey = new Uint8Array(32).fill(11)
        const theirs = [
            `\`\`\`${CIPHER_FENCE_INFO}`,
            armourProtected(
                await sealProtected({
                    key: theirKey,
                    fingerprint: await keyFingerprint(theirKey),
                    plaintext: 'their secret',
                    writtenAt: 1,
                }),
            ),
            '```',
        ].join('\n')

        expect(service.describeFences(theirs)[0].reason).toBe('other-member')
    })

    it('names our own locked content as unlockable', async () => {
        const { service } = await enabled()
        const text = await service.protectDocument('secret')

        service.lockNow()

        expect(service.describeFences(text)[0].reason).toBe('locked')
    })

    it('reads our own fence as locked, never as another member’s, before the record has loaded', async () => {
        // The record read is off the graph-open critical path - on a Server Backend it is a vault
        // fetch that can land seconds after the editor has drawn the card. Classified against
        // "no record yet", our own fence was reported as another member's ("no passphrase of
        // yours will open it") until the record arrived and the card silently became Unlock.
        const store = inMemoryProtectionStore()
        const { service: first } = build({ store })
        await first.enable('correct horse battery staple')
        const text = await first.protectDocument('secret')

        const { service: reopened } = build({ store })
        expect(reopened.isRecordKnown).toBe(false)
        expect(reopened.describeFences(text)[0].reason).toBe('locked')

        await reopened.load()
        expect(reopened.isRecordKnown).toBe(true)
        expect(reopened.describeFences(text)[0].reason).toBe('locked')
    })

    it('reads a fence as locked when the record could not be read, and says the read failed', async () => {
        const store = inMemoryProtectionStore()
        const { service: first } = build({ store })
        await first.enable('correct horse battery staple')
        const text = await first.protectDocument('secret')

        // A vault this device cannot open right now: the graph may well have a record.
        const blind: ProtectionRecordStore = {
            read: async () => {
                throw new Error('vault is locked')
            },
            write: store.write,
            clear: store.clear,
        }
        const { service } = build({ store: blind })
        await service.load()

        expect(service.isUnreadable).toBe(true)
        expect(service.isRecordKnown).toBe(false)
        expect(service.isConfigured).toBe(false)
        expect(service.describeFences(text)[0].reason).toBe('locked')
    })

    it('names a fence as another member’s only once the record is known to hold no key of ours', async () => {
        // Loaded and absent is a real answer: this graph has no key of ours, and the fence has one.
        const theirKey = new Uint8Array(32).fill(11)
        const theirs = [
            `\`\`\`${CIPHER_FENCE_INFO}`,
            armourProtected(
                await sealProtected({
                    key: theirKey,
                    fingerprint: await keyFingerprint(theirKey),
                    plaintext: 'their secret',
                    writtenAt: 1,
                }),
            ),
            '```',
        ].join('\n')
        const { service } = build()

        expect(service.describeFences(theirs)[0].reason).toBe('locked')

        await service.load()
        expect(service.describeFences(theirs)[0].reason).toBe('other-member')
    })
})

describe('the lock lifecycle in the service', () => {
    it('masks on hide and reveals on show with no credential', async () => {
        const { service } = await enabled()

        service.onHidden()
        expect(service.status).toBe('masked')

        service.onShown()
        expect(service.status).toBe('unlocked')
    })

    it('refuses to read while masked: nothing decrypts onto a screen the user has left', async () => {
        const { service } = await enabled()
        const text = await service.protectDocument('secret')

        service.onHidden()
        await expect(service.readDocument(text)).rejects.toThrow(ProtectionUnavailableError)
        // Writing is the commit that rides the mask, and it still works.
        await expect(service.protectDocument('more')).resolves.toContain('etherpk-cipher')

        service.onShown()
        await expect(service.readDocument(text)).resolves.toBe('secret')
    })

    it('locks once the mask grace period has passed', async () => {
        const { service, advance } = await enabled()

        service.onHidden()
        advance(DEFAULT_LOCK_SETTINGS.maskGraceMs)
        service.tick()

        expect(service.status).toBe('locked')
    })

    it('locks after the idle timeout', async () => {
        const { service, advance } = await enabled()

        advance(DEFAULT_LOCK_SETTINGS.idleLockMs)
        service.tick()

        expect(service.status).toBe('locked')
    })

    it('commits pending work before the key goes', async () => {
        const commit = vi.fn(async () => {})
        const built = build({ commit })
        await built.service.enable('correct horse')

        built.service.lockNow()

        expect(commit).toHaveBeenCalled()
    })

    it('re-locking after a change of passphrase needs the new one', async () => {
        const { service } = await enabled()

        await service.changePassphrase('correct horse battery staple', 'a different passphrase')
        service.lockNow()

        await expect(service.unlock('correct horse battery staple')).rejects.toThrow()
        await service.unlock('a different passphrase')
        expect(service.status).toBe('unlocked')
    })

    it('keeps content readable across a passphrase change, because the key never changed', async () => {
        const { service } = await enabled()
        const text = await service.protectDocument('secret')
        const before = service.fingerprint

        await service.changePassphrase('correct horse battery staple', 'a different passphrase')

        expect(service.fingerprint).toBe(before)
        expect(await service.readDocument(text)).toBe('secret')
    })
})

describe('collapsing a merged fence (ADR 0028)', () => {
    it('rewrites a fence holding two envelopes down to the winner', async () => {
        const { service } = await enabled()
        const older = await service.protectDocument('older')
        const newer = await service.protectDocument('newer')
        const merged = mergeFenceBodies(older, newer)

        expect(cipherFences(merged.split('\n'))[0].envelopes).toHaveLength(2)

        const collapsed = service.collapseFences(merged)

        expect(cipherFences(collapsed!.split('\n'))[0].envelopes).toHaveLength(1)
    })

    it('leaves a document alone when nothing needs collapsing', async () => {
        const { service } = await enabled()
        const text = await service.protectDocument('only one')

        expect(service.collapseFences(text)).toBeNull()
    })
})

describe('fingerprints', () => {
    it('match what the crypto layer derives for the same key', async () => {
        const { service } = await enabled()

        expect(service.fingerprint).toBe(toBase64Url(await keyFingerprint(service.heldKey()!)))
    })
})

/** Simulate the merge ADR 0028 describes: two envelopes landing side by side in one fence. */
function mergeFenceBodies(a: string, b: string): string {
    const bodyOf = (text: string) => text.split('\n')[1]
    return a.split('\n').toSpliced(1, 1, bodyOf(a), bodyOf(b)).join('\n')
}

describe('a record that cannot be read', () => {
    // On a Server Backend the record lives in the account vault, and a device whose vault is
    // locked cannot read it. That must mean "no protection I can see", never "this graph will
    // not open" — the graph open awaits this.
    it('reads as unconfigured rather than failing the graph open', async () => {
        const service = new ProtectionService({
            store: {
                read: async () => {
                    throw new Error('vault is locked')
                },
                write: async () => {},
                clear: async () => {},
            },
            now: () => 0,
            settings: () => DEFAULT_LOCK_SETTINGS,
            commit: async () => {},
            kdfCost: FAST_KDF,
        })

        await expect(service.load()).resolves.toBeUndefined()
        expect(service.isConfigured).toBe(false)
        expect(service.status).toBe('locked')
    })

    it('refuses to enable over it, rather than minting a second key that orphans every fence', async () => {
        let writes = 0
        const service = new ProtectionService({
            store: {
                read: async () => {
                    throw new Error('vault is locked')
                },
                write: async () => {
                    writes += 1
                },
                clear: async () => {},
            },
            now: () => 0,
            settings: () => DEFAULT_LOCK_SETTINGS,
            commit: async () => {},
            kdfCost: FAST_KDF,
        })
        await service.load()

        await expect(service.enable('passphrase')).rejects.toThrow(/could not read/)
        expect(writes).toBe(0)
        expect(service.isConfigured).toBe(false)
    })

    it('re-reads before enabling, so a record that appeared since the failed read is honoured', async () => {
        let reads = 0
        const backing = inMemoryProtectionStore()
        const service = new ProtectionService({
            store: {
                read: async () => {
                    reads += 1
                    if (reads === 1) throw new Error('transient')
                    return backing.read()
                },
                write: (record) => backing.write(record),
                clear: () => backing.clear(),
            },
            now: () => 0,
            settings: () => DEFAULT_LOCK_SETTINGS,
            commit: async () => {},
            kdfCost: FAST_KDF,
        })
        await service.load()
        expect(service.isConfigured).toBe(false)
        // Another device set the passphrase meanwhile.
        const other = new ProtectionService({ store: backing, now: () => 0, settings: () => DEFAULT_LOCK_SETTINGS, commit: async () => {}, kdfCost: FAST_KDF })
        await other.enable('theirs')

        await expect(service.enable('mine')).rejects.toThrow(/already has a Protection Key/)
        expect(await backing.read()).toMatchObject({ kind: 'ok', record: { fingerprint: other.fingerprint } })
    })
})

// A record that is present but unusable - git conflict markers in protection.json, a file cut
// short, one written by a newer build - must never read as "never protected": enabling protection
// would then write a fresh key over it, orphaning every document sealed under the old key, which
// is unrecoverable by design (ADR 0057). The store answers `invalid` for it, and the service
// treats that exactly like a read that failed: fences stay locked, and nothing writes.
describe('a record that is present but not usable', () => {
    const GARBAGE = '<<<<<<< HEAD\n{"v":1}\n=======\nnot json\n>>>>>>> theirs\n'

    /** A service over a real filesystem store whose record file holds `text`. */
    async function overFile(text: string) {
        const adapter = createMemoryDirectoryAdapter({ now: () => 1 })
        await adapter.write('etherpk', PROTECTION_FILE, text)
        const { service } = build({ store: filesystemProtectionStore(adapter) })
        return { adapter, service }
    }

    it('reads as unknown: unconfigured, unreadable, and every fence locked rather than another member’s', async () => {
        const theirKey = new Uint8Array(32).fill(11)
        const fence = [
            `\`\`\`${CIPHER_FENCE_INFO}`,
            armourProtected(await sealProtected({ key: theirKey, fingerprint: await keyFingerprint(theirKey), plaintext: 'x', writtenAt: 1 })),
            '```',
        ].join('\n')
        const { service } = await overFile(GARBAGE)

        await service.load()

        expect(service.isConfigured).toBe(false)
        expect(service.isRecordKnown).toBe(false)
        expect(service.isUnreadable).toBe(true)
        expect(service.recordProblem).toMatchObject({ kind: 'invalid' })
        expect(service.describeFences(fence)[0].reason).toBe('locked')
    })

    it('refuses to enable, names the file, and leaves its bytes exactly as they were', async () => {
        const { adapter, service } = await overFile(GARBAGE)
        await service.load()

        await expect(service.enable('passphrase')).rejects.toThrow(ProtectionUnavailableError)
        await expect(service.enable('passphrase')).rejects.toThrow('etherpk/protection.json is damaged; restore it from a backup')

        expect((await adapter.read('etherpk', PROTECTION_FILE)).text).toBe(GARBAGE)
        expect(service.isConfigured).toBe(false)
        expect(service.status).toBe('locked')
    })

    it('says a newer build wrote the record, rather than calling it damaged', async () => {
        const { service } = await overFile(JSON.stringify({ v: 2, fingerprint: 'x', kdf: {}, wrapped: 'y' }))
        await service.load()

        expect(service.recordProblem?.message).toMatch(/newer version of EtherPK/)
        await expect(service.enable('passphrase')).rejects.toThrow(/newer version of EtherPK/)
    })

    it('refuses to unlock with the reason, not with "no Protection Key"', async () => {
        const { service } = await overFile(GARBAGE)
        await service.load()

        await expect(service.unlock('passphrase')).rejects.toThrow(/protection\.json is damaged/)
    })

    it('refuses at the write too, when the record turned unusable between the read and the write', async () => {
        // The last read before a write is the one that counts: a file mangled by an external
        // sync tool in the moment between the passphrase dialog and the write must still stop it.
        let reads = 0
        const invalid: ProtectionRecordRead = { kind: 'invalid', location: 'etherpk/protection.json', problem: 'damaged', detail: 'not JSON' }
        const write = vi.fn(async () => {})
        const { service } = build({
            store: {
                read: async () => (++reads <= 2 ? { kind: 'missing' } : invalid),
                write,
                clear: async () => {},
            },
        })
        await service.load()

        await expect(service.enable('passphrase')).rejects.toThrow(/protection\.json is damaged/)

        expect(write).not.toHaveBeenCalled()
        expect(service.isConfigured).toBe(false)
    })
})
