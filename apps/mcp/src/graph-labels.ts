/**
 * Labels for the `graphs` and `serve` commands, read from the Sync Server's name envelopes
 * (ADR 0031, amended 2026-09-17) with the keyrings the account vault holds. One list call
 * labels every graph with an envelope and nothing is opened. A graph with no envelope yet - not
 * opened by any member since envelopes existed - is read from its root document once through
 * the caller's `MetaNameReader` (graph-names.ts), which publishes what it finds, so the next
 * listing needs no connection for it either. "Unnamed" therefore means the root document has
 * no name at all, or the relay could not be reached to ask.
 */
import { fromBase64Url, type GraphKeyring, type KeyVault } from '$lib/crypto'
import { openGraphName } from '$lib/sync/graph-name-envelope'
import type { ServerGraphRecord } from '$lib/sync/sync-api'

export const NO_KEY_LABEL = '(no key on this account yet - open it in EtherPK first)'
export const NO_NAME_LABEL = '(unnamed)'

export type GraphLabel = { kind: 'named'; name: string } | { kind: 'unnamed' } | { kind: 'no-key' }

type Keyrings = Pick<KeyVault, 'keyrings'>

export async function graphLabel(record: ServerGraphRecord, vault: Keyrings): Promise<GraphLabel> {
    const keyring = vault.keyrings.find((entry) => entry.graphId === record.id)
    if (!keyring) return { kind: 'no-key' }
    if (!record.nameEnvelope) return { kind: 'unnamed' }
    const name = await openGraphName(keyring, record.id, fromBase64Url(record.nameEnvelope))
    return name ? { kind: 'named', name } : { kind: 'unnamed' }
}

/** Reads the canonical name from the root document of a graph the account holds the key for. */
export type MetaNameReader = (record: ServerGraphRecord, keyring: GraphKeyring) => Promise<string | null>

/** The envelope first; for a graph without one, one read of the root document (which publishes it). */
export async function resolveGraphLabel(record: ServerGraphRecord, vault: Keyrings, readMeta: MetaNameReader): Promise<GraphLabel> {
    const label = await graphLabel(record, vault)
    if (label.kind !== 'unnamed') return label
    const keyring = vault.keyrings.find((entry) => entry.graphId === record.id)
    if (!keyring) return { kind: 'no-key' }
    const name = await readMeta(record, keyring)
    return name ? { kind: 'named', name } : { kind: 'unnamed' }
}

export function describeGraphLabel(label: GraphLabel): string {
    switch (label.kind) {
        case 'named':
            return label.name
        case 'unnamed':
            return NO_NAME_LABEL
        case 'no-key':
            return NO_KEY_LABEL
    }
}

/** The graph named `wanted`, compared case-insensitively, envelope or root document; null when none. */
export async function findGraphByName(
    records: ServerGraphRecord[],
    vault: Keyrings,
    wanted: string,
    readMeta: MetaNameReader,
): Promise<{ record: ServerGraphRecord; name: string } | null> {
    const target = wanted.trim().toLowerCase()
    for (const record of records) {
        const label = await resolveGraphLabel(record, vault, readMeta)
        if (label.kind === 'named' && label.name.toLowerCase() === target) return { record, name: label.name }
    }
    return null
}
