/**
 * What a [[Document Version]] holds, and how it is sealed (ADR 0184).
 *
 * The plaintext is the document's whole text, frontmatter included, and its identity as the
 * registry held it: kind, name or day, and aliases. A delete removes the identity from the
 * registry, and restoring a deleted document needs it back.
 *
 * Sealed with the graph's current epoch key in the same envelope as every other synced byte. The
 * AAD binds the envelope to its graph, document and version id, so a server cannot hand one
 * document's version to another, or relabel one version as another.
 */
import { contextAad, currentEpoch, keyForEpoch, openSymmetric, sealSymmetric, type GraphKeyring } from '#lib/crypto/index.js'

export interface VersionIdentity {
    kind: 'journal' | 'page'
    /** A page's name. */
    title?: string
    /** A journal entry's day, `YYYY-MM-DD`. */
    date?: string
    aliases: string[]
}

export interface DocumentVersionPayload {
    v: 1
    identity: VersionIdentity
    text: string
}

export class VersionPayloadError extends Error {}

export function encodeVersionPayload(payload: DocumentVersionPayload): Uint8Array {
    return new TextEncoder().encode(JSON.stringify(payload))
}

const optionalString = (value: unknown) => value === undefined || typeof value === 'string'

function isIdentity(value: unknown): value is VersionIdentity {
    const identity = value as Partial<VersionIdentity> | null
    return (
        typeof identity === 'object'
        && identity !== null
        && (identity.kind === 'journal' || identity.kind === 'page')
        && optionalString(identity.title)
        && optionalString(identity.date)
        && Array.isArray(identity.aliases)
        && identity.aliases.every((alias) => typeof alias === 'string')
    )
}

function isPayload(value: unknown): value is DocumentVersionPayload {
    const candidate = value as Partial<DocumentVersionPayload> | null
    return typeof candidate === 'object' && candidate !== null && candidate.v === 1 && typeof candidate.text === 'string' && isIdentity(candidate.identity)
}

/** Read a payload, refusing anything not exactly this shape: a restore must never guess. */
export function decodeVersionPayload(bytes: Uint8Array): DocumentVersionPayload {
    let value: unknown
    try {
        value = JSON.parse(new TextDecoder().decode(bytes))
    } catch (cause) {
        throw new VersionPayloadError('The version could not be read', { cause })
    }
    if (!isPayload(value)) throw new VersionPayloadError('The version is in a form this Client does not read')
    const { kind, title, date, aliases } = value.identity
    return {
        v: 1,
        identity: { kind, aliases: [...aliases], ...(title !== undefined ? { title } : {}), ...(date !== undefined ? { date } : {}) },
        text: value.text,
    }
}

function versionAad(graphId: string, docId: string, versionId: string): Uint8Array {
    return contextAad('version', `graph:${graphId}`, `doc:${docId}`, `version:${versionId}`)
}

export async function sealVersion(opts: {
    keyring: GraphKeyring
    graphId: string
    docId: string
    versionId: string
    payload: DocumentVersionPayload
}): Promise<{ envelope: Uint8Array; epochId: number }> {
    const epoch = currentEpoch(opts.keyring)
    const envelope = await sealSymmetric({
        key: epoch.key,
        epochId: epoch.epochId,
        plaintext: encodeVersionPayload(opts.payload),
        aad: versionAad(opts.graphId, opts.docId, opts.versionId),
    })
    return { envelope, epochId: epoch.epochId }
}

/** Open a version under whichever epoch sealed it; rejects when it will not open or read. */
export async function openVersion(opts: {
    keyring: GraphKeyring
    graphId: string
    docId: string
    versionId: string
    envelope: Uint8Array
}): Promise<DocumentVersionPayload> {
    const { plaintext } = await openSymmetric({
        keyForEpoch: (epochId) => keyForEpoch(opts.keyring, epochId),
        envelope: opts.envelope,
        aad: versionAad(opts.graphId, opts.docId, opts.versionId),
    })
    return decodeVersionPayload(plaintext)
}
