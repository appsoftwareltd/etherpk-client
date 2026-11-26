/**
 * The cases in packages/native-bridge/test-vectors/update-feed.json, made from fixed keys so that they
 * come out the same each time. feed.test.ts compares the file with these, and every shell reads the file.
 */
import { createHash } from 'node:crypto'
import { type FeedPayload, publicKeyFromSeed, type Release, signFeed, type UpdateKey } from './feed.ts'

/** Seeds written out in a public file. They sign nothing but these cases. */
const seed = (name: string) => createHash('sha256').update(`etherpk update feed test vector ${name}`).digest()
const trusted = { id: 'test-1', seed: seed('test-1') }
const second = { id: 'test-2', seed: seed('test-2') }
const stranger = { id: 'test-1', seed: seed('stranger') }

const release = (version: string, file: string): Release => ({
    version, url: `https://downloads.example/${version}/${file}`, sha512: createHash('sha512').update(file).digest('hex'),
    size: 1000 + file.length, minimumVersion: '1.0.0', page: `https://downloads.example/${version}`,
})
const base: FeedPayload = {
    schema: 1, sequence: 10, expires: '2030-01-01T00:00:00.000Z',
    channels: {
        stable: {
            'windows-x64': release('1.2.0', 'EtherPK-windows-x64.exe'),
            'linux-x64-appimage': release('1.2.0', 'EtherPK-linux-x64.AppImage'),
            'linux-x64-deb': release('1.2.0', 'EtherPK-linux-x64.deb'),
            android: release('1.1.0', 'EtherPK-android.apk'),
        },
    },
}
const encode = (payload: unknown) => Buffer.from(JSON.stringify(payload), 'utf8')
const signed = (payload: unknown, keys = [trusted]) => signFeed(encode(payload), keys)
const altered = (feed: string, change: (envelope: { payload: string; signatures: { key: string; signature: string }[] }) => void) => {
    const envelope = JSON.parse(feed)
    change(envelope)
    return JSON.stringify(envelope)
}
const good = signed(base)
const changedRelease = (change: Partial<Record<keyof Release, unknown>>) =>
    signed({ ...base, channels: { stable: { android: { ...base.channels.stable.android, ...change } } } })

export interface FeedVector { name: string; feed: string; highestSequence: number; now: string; outcome: 'ok' | 'format' | 'signature' | 'schema' | 'rollback' | 'expired' }

export function feedVectors(): { about: string; domain: string; keys: UpdateKey[]; payload: FeedPayload; cases: FeedVector[] } {
    const now = '2029-01-01T00:00:00.000Z'
    const vector = (name: string, outcome: FeedVector['outcome'], feed: string, highestSequence = 10, at = now): FeedVector => ({ name, feed, highestSequence, now: at, outcome })
    return {
        about: 'Cases every reader of the update feed must agree on. Made by apps/desktop/src/update/feed.vectors.ts: run its test with UPDATE_VECTORS=1 to write the file again.',
        domain: 'etherpk-update-feed-v1\n',
        keys: [trusted, second].map(({ id, seed }) => ({ id, publicKey: publicKeyFromSeed(seed) })),
        payload: base,
        cases: [
            vector('good', 'ok', good),
            vector('good, the sequence seen before', 'ok', good, 10),
            vector('signed by the second trusted key only', 'ok', signed(base, [second])),
            vector('signed by a stranger and by a trusted key', 'ok', signed(base, [{ ...stranger, id: 'unknown' }, trusted])),
            vector('text past ASCII in an unknown field', 'ok', signed({ ...base, note: 'Réunion — 日本語' })),
            vector('a platform this version does not know', 'ok', signed({ ...base, channels: { stable: { ...base.channels.stable, 'toaster-x64': release('9.0.0', 'EtherPK-toaster') } } })),
            vector('signed by a stranger under a trusted id', 'signature', signed(base, [stranger])),
            vector('signed by a key that is not trusted', 'signature', signed(base, [{ ...trusted, id: 'unknown' }])),
            vector('no signatures', 'signature', signFeed(encode(base), [])),
            vector('another payload under the same signature', 'signature', altered(good, (envelope) => { envelope.payload = encode({ ...base, sequence: 11 }).toString('base64') })),
            vector('the signature cut short', 'signature', altered(good, (envelope) => { envelope.signatures[0].signature = Buffer.from(envelope.signatures[0].signature, 'base64').subarray(0, 63).toString('base64') })),
            vector('one bit of the signature changed', 'signature', altered(good, (envelope) => {
                const bytes = Buffer.from(envelope.signatures[0].signature, 'base64')
                bytes[10] ^= 1
                envelope.signatures[0].signature = bytes.toString('base64')
            })),
            vector('base64 with a space in the middle', 'format', altered(good, (envelope) => { envelope.payload = `${envelope.payload.slice(0, 8)} ${envelope.payload.slice(8)}` })),
            vector('not JSON', 'format', 'not a feed'),
            vector('not an envelope', 'format', JSON.stringify(base)),
            vector('signatures that are not a list', 'format', altered(good, (envelope) => { envelope.signatures = {} as never })),
            vector('a lower sequence', 'rollback', good, 11),
            vector('expired a moment ago', 'expired', good, 10, base.expires),
            vector('about to expire', 'ok', good, 10, '2029-12-31T23:59:59.999Z'),
            vector('another schema', 'schema', signed({ ...base, schema: 2 })),
            vector('a payload that is not JSON', 'schema', signFeed(Buffer.from('not JSON'), [trusted])),
            vector('no sequence', 'schema', signed({ ...base, sequence: undefined })),
            vector('a sequence that is not whole', 'schema', signed({ ...base, sequence: 10.5 })),
            vector('a date without milliseconds', 'schema', signed({ ...base, expires: '2030-01-01T00:00:00Z' })),
            vector('a download that is not https', 'schema', changedRelease({ url: 'http://downloads.example/x' })),
            vector('a page that is not an address', 'schema', changedRelease({ page: 'javascript:alert(1)' })),
            vector('a checksum in capitals', 'schema', changedRelease({ sha512: 'A'.repeat(128) })),
            vector('a checksum cut short', 'schema', changedRelease({ sha512: 'a'.repeat(127) })),
            vector('a size of nothing', 'schema', changedRelease({ size: 0 })),
            vector('a version with a suffix', 'schema', changedRelease({ version: '1.2.0-beta' })),
            vector('a version with a leading zero', 'schema', changedRelease({ version: '1.02.0' })),
            vector('a minimum above the version offered', 'schema', changedRelease({ minimumVersion: '9.0.0' })),
        ],
    }
}
