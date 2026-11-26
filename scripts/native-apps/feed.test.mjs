// Run with `node --test scripts/native-apps/feed.test.mjs` (part of `pnpm test`).
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { newerRelease, publicKeyFromSeed, readFeed, signFeed } from '../../apps/desktop/src/update/feed.ts'
import { keySetsToSatisfy, nextPayload, previousPayload, signedFeed } from './feed.mjs'
import { INSTALLERS } from './installers.mjs'

const fc = createRequire(new URL('../../apps/desktop/package.json', import.meta.url))('fast-check')
const RUNS = Number(process.env.UPDATE_FEED_FUZZ_RUNS ?? 200)

const seedOf = (name) => createHash('sha256').update(`feed tooling test ${name}`).digest()
const key = { id: 'test-a', seed: seedOf('a') }
const spare = { id: 'test-b', seed: seedOf('b') }
const keys = [key, spare].map(({ id, seed }) => ({ id, publicKey: publicKeyFromSeed(seed) }))
const NOW = Date.parse('2027-03-01T10:00:00.000Z')
const DAY = 86_400_000

const filesOf = (version, platforms = INSTALLERS.map((one) => one.platform)) =>
    Object.fromEntries(platforms.map((platform) => [platform, { size: 1000 + version.length, sha512: createHash('sha512').update(platform + version).digest('hex') }]))
const promote = (version, more = {}) => ({ action: 'promote', version, files: filesOf(version, more.platforms), ...more })
const next = (previous, change, more = {}) => nextPayload({ previous, startAfter: previous ? undefined : 0, change, repository: 'example/app', now: NOW, ...more })

test('the first feed names each installer of the release, at its address', () => {
    const payload = next(null, promote('1.2.0'))
    assert.equal(payload.sequence, 1)
    assert.equal(payload.expires, new Date(NOW + 120 * DAY).toISOString())
    assert.deepEqual(Object.keys(payload.channels.stable).sort(), INSTALLERS.map((one) => one.platform).sort())
    assert.deepEqual(payload.channels.stable['windows-x64'], {
        version: '1.2.0', url: 'https://github.com/example/app/releases/download/v1.2.0/EtherPK-windows-x64.exe',
        ...filesOf('1.2.0')['windows-x64'], minimumVersion: '0.0.0', page: 'https://github.com/example/app/releases/tag/v1.2.0',
    })
})

test('a feed with no feed before it is made only when that is asked for', () => {
    assert.throws(() => nextPayload({ previous: null, change: promote('1.2.0'), repository: 'example/app', now: NOW }), /start after/i)
    assert.equal(nextPayload({ previous: null, startAfter: 41, change: promote('1.2.0'), repository: 'example/app', now: NOW }).sequence, 42)
    // With a feed there, its own sequence counts: a lower one would be refused by every app.
    assert.throws(() => next(next(null, promote('1.2.0')), promote('1.3.0'), { startAfter: 0 }), /start after/i)
})

test('promoting some platforms leaves the others as they were', () => {
    const first = next(null, promote('1.2.0'))
    const second = next(first, promote('1.3.0', { platforms: ['android'] }))
    assert.equal(second.sequence, 2)
    assert.equal(second.channels.stable.android.version, '1.3.0')
    assert.deepEqual(second.channels.stable['windows-x64'], first.channels.stable['windows-x64'])
})

test('a version older than one promoted before is refused, also after a pause', () => {
    const promoted = next(null, promote('1.3.0'))
    assert.throws(() => next(promoted, promote('1.2.9')), /1\.3\.0.*higher version/s)
    const paused = next(promoted, { action: 'pause', platforms: ['windows-x64'] })
    assert.throws(() => next(paused, promote('1.2.9', { platforms: ['windows-x64'] })), /higher version/)
    assert.equal(next(paused, promote('1.3.0', { platforms: ['windows-x64'] })).channels.stable['windows-x64'].version, '1.3.0')
})

test('a version promoted before with another file is refused', () => {
    const changed = { ...promote('1.3.0'), files: { android: { ...filesOf('1.3.0').android, sha512: 'b'.repeat(128) } } }
    assert.throws(() => next(next(null, promote('1.3.0')), changed), /never changes/)
})

test('after a pause, the version promoted before is taken again only with the same file', () => {
    const paused = next(next(null, promote('1.3.0')), { action: 'pause', platforms: ['android'] })
    const changed = { ...promote('1.3.0'), files: { android: { ...filesOf('1.3.0').android, sha512: 'b'.repeat(128) } } }
    assert.throws(() => next(paused, changed), /never changes/)
    assert.equal(next(paused, promote('1.3.0', { platforms: ['android'] })).channels.stable.android.version, '1.3.0')
})

test('after a pause, the minimum version set before is kept', () => {
    const paused = next(next(null, promote('1.3.0', { minimumVersion: '1.1.0' })), { action: 'pause', platforms: ['android'] })
    assert.equal(next(paused, promote('1.3.0', { platforms: ['android'] })).channels.stable.android.minimumVersion, '1.1.0')
    assert.equal(next(paused, promote('1.4.0', { platforms: ['android'] })).channels.stable.android.minimumVersion, '1.1.0')
})

test('a feed whose record of what was promoted is not one is refused', () => {
    const first = next(null, promote('1.3.0'))
    assert.throws(() => next({ ...first, promoted: { android: '1.3.0' } }, promote('1.4.0')), /promoted/)
})

test('a pause offers nobody the platform, and the others stay', () => {
    const paused = next(next(null, promote('1.3.0')), { action: 'pause', platforms: ['windows-x64'] })
    assert.equal(newerRelease(paused, 'stable', 'windows-x64', '1.0.0'), null)
    assert.equal(newerRelease(paused, 'stable', 'android', '1.0.0').version, '1.3.0')
    assert.throws(() => next(paused, { action: 'pause', platforms: ['windows-x64'] }), /not in the feed/)
})

test('a renewal changes the sequence and the date, and nothing else', () => {
    const first = next(null, promote('1.3.0'))
    const renewed = next(first, { action: 'renew' }, { now: NOW + 100 * DAY })
    assert.deepEqual({ ...renewed, sequence: 0, expires: '' }, { ...first, sequence: 0, expires: '' })
    assert.equal(renewed.sequence, 2)
    assert.equal(renewed.expires, new Date(NOW + 220 * DAY).toISOString())
})

test('the minimum version is kept until it is given again, and is never above the version offered', () => {
    const first = next(null, promote('1.3.0', { minimumVersion: '1.1.0' }))
    assert.equal(next(first, promote('1.4.0')).channels.stable.android.minimumVersion, '1.1.0')
    assert.equal(next(first, promote('1.4.0', { minimumVersion: '1.4.0' })).channels.stable.android.minimumVersion, '1.4.0')
    assert.throws(() => next(first, promote('1.4.0', { minimumVersion: '1.5.0' })), /minimum/i)
})

for (const [what, change] of [
    ['a version that is not one', promote('1.2')],
    ['a platform that is not one', { action: 'promote', version: '1.2.0', files: { toaster: { size: 1, sha512: 'a'.repeat(128) } } }],
    ['no platform', { action: 'promote', version: '1.2.0', files: {} }],
    ['an action that is not one', { action: 'publish' }],
    ['a pause of nothing', { action: 'pause', platforms: [] }],
]) test(`${what} is refused`, () => { assert.throws(() => next(next(null, promote('1.0.0')), change)) })

test('what is signed is read back by the apps, and one key they do not trust makes none', () => {
    const payload = next(null, promote('1.2.0'))
    assert.deepEqual(readFeed(signedFeed(payload, [key], [keys]), { keys, highestSequence: 0, now: NOW }), payload)
    assert.throws(() => signedFeed(payload, [{ id: 'stranger', seed: seedOf('c') }], [keys]), /trust/)
    assert.throws(() => signedFeed(payload, [{ id: 'test-a', seed: seedOf('c') }], [keys]), /trust/)
    assert.throws(() => signedFeed(payload, [], [keys]), /trust/)
})

test('a feed is signed only when every set of keys released apps hold takes it', () => {
    const payload = next(null, promote('1.2.0'))
    const newer = { id: 'test-c', seed: seedOf('c') }
    const asReleased = [keys[0], keys[1]]
    const current = [keys[1], { id: newer.id, publicKey: publicKeyFromSeed(newer.seed) }]
    // A rotation to [b, c] signed with c alone: apps built with [a, b] would refuse it.
    assert.throws(() => signedFeed(payload, [newer], [current, asReleased]), /test-a, test-b/)
    // Signed with b as well, both sets take it.
    const feed = signedFeed(payload, [newer, spare], [current, asReleased])
    for (const set of [current, asReleased]) assert.equal(readFeed(feed, { keys: set, highestSequence: 0, now: NOW }).sequence, 1)
    // The set the apps are built with now is named apart, since its fix is another.
    assert.throws(() => signedFeed(payload, [key], [current, asReleased]), /update-keys\.json/)
})

test('the key sets to satisfy are the current one and each released one, once each', () => {
    const one = [keys[0]]
    assert.deepEqual(keySetsToSatisfy(keys, [{ firstVersion: '0.52.0', keys }, { firstVersion: '0.53.0', keys: one }]), [keys, one])
    assert.throws(() => keySetsToSatisfy([], [{ firstVersion: '0.52.0', keys: one }]), /no key/)
    assert.throws(() => keySetsToSatisfy(keys, [{ firstVersion: 'soon', keys }]), /version/)
    assert.throws(() => keySetsToSatisfy(keys, [{ firstVersion: '0.52.0', keys: [] }]), /no key/)
})

test('the feed that is there is taken when its date has passed, and not when its signature is wrong', () => {
    const payload = next(null, promote('1.2.0'), { now: NOW - 1000 * DAY })
    const feed = signedFeed(payload, [key], [keys], NOW - 1000 * DAY)
    assert.deepEqual(previousPayload(feed, keys), payload)
    assert.throws(() => previousPayload(feed.replace('"signature":"', '"signature":"A'), keys), { problem: 'signature' })
    assert.throws(() => previousPayload(signFeed(Buffer.from('{}'), [key]), keys), { problem: 'schema' })
})

// --- Properties -----------------------------------------------------------------------------------------

const version = fc.tuple(fc.nat(3), fc.nat(5), fc.nat(5)).map((parts) => parts.join('.'))
const somePlatforms = fc.uniqueArray(fc.constantFrom(...INSTALLERS.map((one) => one.platform)), { minLength: 1 })
const anyChange = fc.oneof(
    fc.tuple(version, somePlatforms, fc.option(version, { nil: undefined })).map(([v, platforms, minimumVersion]) => promote(v, { platforms, minimumVersion })),
    somePlatforms.map((platforms) => ({ action: 'pause', platforms })),
    fc.constant({ action: 'renew' }),
)

/** The feeds a history of changes makes. A change that is refused makes none. */
function history(changes) {
    const payloads = [next(null, promote('0.0.1'))]
    for (const change of changes) {
        try {
            payloads.push(next(payloads.at(-1), change))
        } catch (error) {
            assert.ok(error instanceof Error)
        }
    }
    return payloads
}

test('property: every feed made is one the apps take, in the order it was made in', () => {
    fc.assert(fc.property(fc.array(anyChange, { maxLength: 12 }), (changes) => {
        let highestSequence = 0
        for (const payload of history(changes)) {
            const read = readFeed(signedFeed(payload, [key], [keys]), { keys, highestSequence, now: NOW })
            assert.deepEqual(read, payload)
            assert.ok(read.sequence > highestSequence)
            highestSequence = read.sequence
        }
    }), { seed: 1, numRuns: RUNS })
})

test('property: an older feed shown again is refused as a rollback', () => {
    fc.assert(fc.property(fc.array(anyChange, { minLength: 1, maxLength: 12 }), fc.nat(), (changes, pick) => {
        const payloads = history(changes)
        fc.pre(payloads.length > 1)
        const replayed = payloads[pick % (payloads.length - 1)]
        assert.throws(() => readFeed(signedFeed(replayed, [key], [keys]), { keys, highestSequence: payloads.at(-1).sequence, now: NOW }), { problem: 'rollback' })
    }), { seed: 2, numRuns: RUNS })
})

test('property: no history offers a platform a version below one it was offered before', () => {
    fc.assert(fc.property(fc.array(anyChange, { maxLength: 20 }), (changes) => {
        const highest = {}
        for (const { channels } of history(changes)) {
            for (const [platform, release] of Object.entries(channels.stable)) {
                if (highest[platform]) assert.equal(newerRelease({ channels: { stable: { [platform]: { version: highest[platform] } } } }, 'stable', platform, release.version), null)
                highest[platform] = release.version
            }
        }
    }), { seed: 3, numRuns: RUNS })
})

test('property: one character of a signed feed changed, and the apps refuse it or read the same', () => {
    const payload = next(null, promote('1.2.0'))
    const feed = signedFeed(payload, [key], [keys])
    fc.assert(fc.property(fc.nat(feed.length - 1), fc.integer({ min: 32, max: 126 }), (at, code) => {
        const changed = feed.slice(0, at) + String.fromCharCode(code) + feed.slice(at + 1)
        try {
            assert.deepEqual(readFeed(changed, { keys, highestSequence: 0, now: NOW }), payload)
        } catch (error) {
            assert.ok(['format', 'signature'].includes(error.problem), error)
        }
    }), { seed: 4, numRuns: RUNS * 5 })
})
