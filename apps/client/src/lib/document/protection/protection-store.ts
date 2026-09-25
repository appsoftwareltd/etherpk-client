/**
 * Where a graph's {@link ProtectionRecord} lives, behind one seam (ADR 0057).
 *
 * The two backends differ because the record is **personal**, and the two backends put personal
 * state in different places:
 *
 * - **Filesystem Backend** — no account and no other member, so the record sits in the graph
 *   folder. In its **own file**, not in `settings.json`: Graph Settings are shared graph content
 *   (ADR 0036) and a personal key record must never ride along with them.
 * - **Server Backend** — the record goes in the user's personal account vault, keyed by graph id.
 *   It cannot go in the graph's encrypted *shared* metadata (ADR 0031), because every Player would
 *   then hold the passphrase-wrapped blob and could attack it offline.
 *
 * Neither store ever holds the Protection Key itself — only the passphrase-wrapped copy of it.
 *
 * **A read has four outcomes, and only one of them is "no record".** A store answers `missing`
 * only when it is sure nothing is there, `invalid` when it holds something this build cannot use
 * (a `protection.json` with git conflict markers in it, or one written by a newer build), and
 * rejects when it could not look at all. Taking anything but `missing` as leave to mint a fresh
 * key would replace the record and orphan every document sealed under the old key, so nothing
 * that writes a record proceeds on anything but `missing`, or `ok` under the same key.
 */
import type { ProtectionRecord, ProtectionRecordProblem } from '$lib/crypto'
import { ProtectionRecordFormatError, parseProtectionRecord, serialiseProtectionRecord, validateProtectionRecord } from '$lib/crypto'
import type { DirectoryAdapter } from '$lib/storage/fs/directory-adapter'

/** The graph-folder file holding the record. Deliberately not `settings.json`. */
export const PROTECTION_FILE = 'protection.json'

/**
 * What a store found. `invalid` is a verdict about the bytes, not a failure to read them, which
 * is why it is a value here while a failed read is a rejection: the two are acted on differently
 * (a damaged file wants a backup; a locked vault wants unlocking) and must never be confused
 * with each other, or with `missing`.
 */
export type ProtectionRecordRead =
    | { kind: 'ok'; record: ProtectionRecord }
    /** Nothing stored: this graph has never been protected here. */
    | { kind: 'missing' }
    | {
          kind: 'invalid'
          /** Where the record lives, in words a user can act on: `etherpk/protection.json`. */
          location: string
          problem: ProtectionRecordProblem
          /** What was wrong, for logs and tests; not user copy. */
          detail: string
      }

export interface ProtectionRecordStore {
    /**
     * The graph's record, or why there is none to use. Rejects when the store could not look - a
     * locked vault, an unreachable server, a folder whose permission was revoked, a file another
     * handle is mid-way through writing - and a rejection is never "no record".
     */
    read(): Promise<ProtectionRecordRead>
    write(record: ProtectionRecord): Promise<void>
    /** Forget the record — protection turned off for this graph. */
    clear(): Promise<void>
}

/**
 * Classify what a store holds: a usable record, or `invalid` with the parser's reason. Never
 * `missing` - the caller has the bytes. Only the parser's own refusal is caught; anything else
 * thrown in there is a fault, not a verdict, and goes on up.
 */
function readFrom(location: string, parse: () => ProtectionRecord): ProtectionRecordRead {
    try {
        return { kind: 'ok', record: parse() }
    } catch (error) {
        if (!(error instanceof ProtectionRecordFormatError)) throw error
        return { kind: 'invalid', location, problem: error.problem, detail: error.message }
    }
}

export function filesystemProtectionStore(adapter: DirectoryAdapter): ProtectionRecordStore {
    const location = `etherpk/${PROTECTION_FILE}`
    return {
        async read() {
            // The adapter's own presence probe is where "not there" is told from "could not
            // look": the web adapter answers false only for `NotFoundError` and rethrows the
            // rest (a revoked permission, a file mid-write), and the memory adapter has no error
            // names to go by at all. So ask it first rather than reading and guessing from the
            // rejection. Everything after - the read included - propagates as a rejection, which
            // the service treats as unreadable, never as absent. An empty file is a file:
            // EtherPK never writes one (the web adapter swaps a complete file in on close), so it
            // is what a full disk or a copy cut short leaves, and it reads as invalid.
            if (!(await adapter.exists('etherpk', PROTECTION_FILE))) return { kind: 'missing' }
            const { text } = await adapter.read('etherpk', PROTECTION_FILE)
            return readFrom(location, () => parseProtectionRecord(text))
        },
        async write(record) {
            await adapter.write('etherpk', PROTECTION_FILE, `${serialiseProtectionRecord(record)}\n`)
        },
        async clear() {
            await adapter.remove('etherpk', PROTECTION_FILE)
        },
    }
}

/** The slice of vault access this store needs, so it does not depend on the whole sync stack. */
export interface VaultProtectionAccess {
    readProtection(): Promise<Record<string, ProtectionRecord> | undefined>
    writeProtection(next: Record<string, ProtectionRecord> | undefined): Promise<void>
}

export function vaultProtectionStore(graphId: string, access: VaultProtectionAccess): ProtectionRecordStore {
    return {
        async read() {
            // A failed vault read (locked, unreachable, undecryptable) rejects straight through.
            const entry = (await access.readProtection())?.[graphId]
            if (entry === undefined) return { kind: 'missing' }
            // The vault is shared by every device on the account, so a build ahead of this one
            // on another device is exactly how a record we cannot use arrives here. Checked like
            // a file would be, rather than trusted for being ours: handing it on unchecked would
            // put its parameters straight into Argon2id.
            return readFrom('this graph’s protection record in your account vault', () => validateProtectionRecord(entry))
        },
        async write(record) {
            // Read-modify-write the whole map: one vault holds every graph's record, and a blind
            // overwrite would drop the others. They are carried verbatim, unchecked - a neighbour
            // written by a newer build is that graph's key, and not ours to rewrite.
            await access.writeProtection({ ...((await access.readProtection()) ?? {}), [graphId]: record })
        },
        async clear() {
            const current = { ...((await access.readProtection()) ?? {}) }
            delete current[graphId]
            await access.writeProtection(current)
        },
    }
}

/**
 * Device-local storage for a [[Server Backend]] that has no account vault to hold the record — a
 * relay reached without an account, or the browser test harness. The record is the
 * passphrase-wrapped key, the same thing `protection.json` holds in a graph folder, so keeping it
 * in `localStorage` gives up nothing ADR 0057 protects; what it gives up is portability, exactly
 * as a Filesystem Backend does. Without it a reload lost the passphrase entirely.
 */
export function localProtectionStore(graphId: string): ProtectionRecordStore {
    const key = `etherpk:protection:${graphId}`
    return {
        async read() {
            // A `getItem` that throws (storage disabled by policy) propagates: "could not look"
            // is not "empty". Only a null answer is.
            const raw = localStorage.getItem(key)
            if (raw === null) return { kind: 'missing' }
            return readFrom(`this browser’s ${key} entry`, () => parseProtectionRecord(raw))
        },
        async write(record) {
            localStorage.setItem(key, serialiseProtectionRecord(record))
        },
        async clear() {
            localStorage.removeItem(key)
        },
    }
}

/** For tests and for a graph whose backend has not been resolved yet. Never persists. */
export function inMemoryProtectionStore(initial: ProtectionRecord | null = null): ProtectionRecordStore {
    let record = initial
    return {
        read: async () => (record ? { kind: 'ok', record } : { kind: 'missing' }),
        write: async (next) => {
            record = next
        },
        clear: async () => {
            record = null
        },
    }
}
