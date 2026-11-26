/**
 * The update feed: one small signed file that says which version of each Native App is current.
 *
 * The file is JSON holding a payload and signatures over it:
 *
 *     { "payload": "<base64>", "signatures": [{ "key": "<key id>", "signature": "<base64>" }] }
 *
 * The signature is Ed25519 over the line `etherpk-update-feed-v1` and a line feed, then the payload's
 * bytes exactly as the base64 holds them. Nothing is parsed before its signature is good, and the
 * bytes that were signed are the bytes that are parsed, so no two programs can read them differently.
 * An app carries the public keys it trusts (update-keys.json), and one good signature by any of them
 * is enough, so a key can be replaced over two releases.
 *
 * The payload:
 *
 *     { "schema": 1, "sequence": 412, "expires": "2027-02-25T00:00:00.000Z",
 *       "channels": { "stable": { "windows-x64": { "version": "0.60.0", "url": "https://…", "sha512": "<hex>",
 *                                                  "size": 1, "minimumVersion": "0.52.0", "page": "https://…" } } } }
 *
 * An app takes a feed only with a sequence no lower than the highest it has taken, and only before it
 * expires, so someone who can answer in the server's place cannot show it an old feed for ever.
 *
 * packages/native-bridge/test-vectors/update-feed.json holds cases every implementation must agree on.
 */
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'

export const FEED_DOMAIN = 'etherpk-update-feed-v1\n'
/** No feed is near this. A longer answer is not one. */
export const LONGEST_FEED = 256 * 1024

export type PlatformKey = 'windows-x64' | 'linux-x64-appimage' | 'linux-x64-deb' | 'android'

export interface Release {
    version: string
    url: string
    /** Lower-case hex. */
    sha512: string
    size: number
    /** An app older than this is told the update is required. */
    minimumVersion: string
    /** Where a person can download it themselves. */
    page: string
}

export interface FeedPayload {
    schema: 1
    sequence: number
    expires: string
    channels: Record<string, Partial<Record<string, Release>>>
}

/** A public key an app trusts: an id of our choosing, and the 32 bytes in base64. */
export interface UpdateKey { id: string; publicKey: string }

export type FeedProblem = 'format' | 'signature' | 'schema' | 'rollback' | 'expired'
export class FeedError extends Error {
    // An ordinary field: the release scripts run this file under plain Node, which only takes types away.
    readonly problem: FeedProblem

    constructor(problem: FeedProblem, message: string) {
        super(message)
        this.problem = problem
        this.name = 'FeedError'
    }
}

const VERSION = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/

export function isVersion(value: unknown): value is string {
    return typeof value === 'string' && VERSION.test(value)
}

/** Below zero when `a` is older than `b`. */
export function compareVersions(a: string, b: string): number {
    const [left, right] = [a, b].map((version) => version.split('.').map(Number))
    for (let part = 0; part < 3; part++) if (left[part] !== right[part]) return left[part] - right[part]
    return 0
}

// An Ed25519 key in its DER wrapping is a fixed prefix and the 32 bytes.
const PUBLIC_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')
const PRIVATE_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex')

/** Base64 as it is written once, or null. A decoder that shrugs at stray characters would accept many spellings. */
function exactBase64(text: unknown): Buffer | null {
    if (typeof text !== 'string') return null
    const bytes = Buffer.from(text, 'base64')
    return bytes.toString('base64') === text ? bytes : null
}

function publicKeyOf(key: UpdateKey) {
    const bytes = exactBase64(key.publicKey)
    if (bytes?.length !== 32) throw new Error(`The update key "${key.id}" is not 32 bytes of base64.`)
    return createPublicKey({ key: Buffer.concat([PUBLIC_PREFIX, bytes]), format: 'der', type: 'spki' })
}

function signedBytes(payload: Buffer): Buffer {
    return Buffer.concat([Buffer.from(FEED_DOMAIN, 'utf8'), payload])
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The payload's bytes, once a trusted key is seen to have signed them. */
export function verifiedPayload(feed: string, keys: readonly UpdateKey[]): Buffer {
    if (Buffer.byteLength(feed) > LONGEST_FEED) throw new FeedError('format', 'The feed is too long.')
    let envelope: unknown
    try {
        envelope = JSON.parse(feed)
    } catch {
        throw new FeedError('format', 'The feed is not JSON.')
    }
    if (!isRecord(envelope) || !Array.isArray(envelope.signatures)) throw new FeedError('format', 'The feed is not an envelope.')
    const payload = exactBase64(envelope.payload)
    if (payload === null) throw new FeedError('format', 'The payload is not base64.')
    for (const entry of envelope.signatures.slice(0, 16) as unknown[]) {
        if (!isRecord(entry)) continue
        const key = keys.find((one) => one.id === entry.key)
        const signature = exactBase64(entry.signature)
        if (key && signature?.length === 64 && verify(null, signedBytes(payload), publicKeyOf(key), signature)) return payload
    }
    throw new FeedError('signature', 'No key this app trusts has signed the feed.')
}

function isHttps(value: unknown): value is string {
    return typeof value === 'string' && URL.canParse(value) && new URL(value).protocol === 'https:'
}

function isRelease(value: unknown): value is Release {
    return isRecord(value) && isVersion(value.version) && isVersion(value.minimumVersion) && isHttps(value.url) && isHttps(value.page)
        && typeof value.sha512 === 'string' && /^[0-9a-f]{128}$/.test(value.sha512)
        && Number.isSafeInteger(value.size) && (value.size as number) > 0
        && compareVersions(value.minimumVersion, value.version) <= 0
}

/** A date written one way only: UTC with milliseconds, as `toISOString` writes it. */
function isInstant(value: unknown): value is string {
    return typeof value === 'string' && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value
}

function isPayload(value: unknown): value is FeedPayload {
    return isRecord(value) && value.schema === 1 && Number.isSafeInteger(value.sequence) && (value.sequence as number) > 0
        && isInstant(value.expires) && isRecord(value.channels)
        && Object.values(value.channels).every((channel) => isRecord(channel) && Object.values(channel).every(isRelease))
}

export interface ReadFeed { keys: readonly UpdateKey[]; highestSequence: number; now: number }

/** A feed this app may act on. Throws a {@link FeedError} for any other. */
export function readFeed(feed: string, { keys, highestSequence, now }: ReadFeed): FeedPayload {
    const bytes = verifiedPayload(feed, keys)
    let payload: unknown
    try {
        payload = JSON.parse(bytes.toString('utf8'))
    } catch {
        throw new FeedError('schema', 'The payload is not JSON.')
    }
    if (!isPayload(payload)) throw new FeedError('schema', 'The payload is not one this version reads.')
    if (payload.sequence < highestSequence) throw new FeedError('rollback', 'The feed is older than one already taken.')
    if (Date.parse(payload.expires) <= now) throw new FeedError('expired', 'The feed has expired.')
    return payload
}

/** The release of a platform when it is newer than the version running, or null. */
export function newerRelease(payload: FeedPayload, channel: string, platform: string, current: string): Release | null {
    const channels = Object.hasOwn(payload.channels, channel) ? payload.channels[channel] : {}
    const release = Object.hasOwn(channels, platform) ? channels[platform] : undefined
    return release && compareVersions(release.version, current) > 0 ? release : null
}

/** Sign a payload with a 32-byte seed. The release tooling and the test vectors use it. An app never does. */
export function signFeed(payload: Buffer, keys: readonly { id: string; seed: Buffer }[]): string {
    const signatures = keys.map(({ id, seed }) => {
        const key = createPrivateKey({ key: Buffer.concat([PRIVATE_PREFIX, seed]), format: 'der', type: 'pkcs8' })
        return { key: id, signature: sign(null, signedBytes(payload), key).toString('base64') }
    })
    return JSON.stringify({ payload: payload.toString('base64'), signatures })
}

export function publicKeyFromSeed(seed: Buffer): string {
    const key = createPrivateKey({ key: Buffer.concat([PRIVATE_PREFIX, seed]), format: 'der', type: 'pkcs8' })
    return createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(PUBLIC_PREFIX.length).toString('base64')
}
