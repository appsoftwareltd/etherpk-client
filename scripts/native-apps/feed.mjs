/**
 * Making the update feed the Native Apps read (apps/desktop/src/update/feed.ts says what one is, and
 * its code signs and checks here too, so this cannot make a feed the apps read another way).
 *
 * One feed follows another: each has the sequence after the last, and the platforms a change leaves
 * alone stay as they were. `promoted` holds, for each platform, the highest version it was ever offered,
 * with that file's SHA-512 and the minimum version it carried. The apps pass it over. It is here so that
 * a paused platform does not forget what it had: not the version, not its bytes, not the minimum.
 */
import { compareVersions, isVersion, readFeed, signFeed } from '../../apps/desktop/src/update/feed.ts'
import { installerFor } from './installers.mjs'

export const CHANNEL = 'stable'
/** How long an app takes a feed for. `check-feed.mjs` asks for a renewal well before. */
export const LIFETIME_DAYS = 120
const DAY_MS = 86_400_000

/** The feed that is there now, checked as an app checks it, but for its date: a feed is renewed after that too. */
export function previousPayload(feed, keys) {
    return readFeed(feed, { keys, highestSequence: 0, now: 0 })
}

function nextSequence(previous, startAfter) {
    if (previous) {
        if (startAfter !== undefined) throw new Error('There is a feed, and its own sequence counts. Leave "start after" empty.')
        return previous.sequence + 1
    }
    if (!Number.isSafeInteger(startAfter) || startAfter < 0) {
        throw new Error('There is no feed. Say which sequence to start after: 0 for the first feed ever, or the highest sequence any app has seen.')
    }
    return startAfter + 1
}

/** What `promoted` says of one platform, checked: a feed that says something else was not made here. */
function promotedEntry(platform, entry) {
    if (entry === undefined) return undefined
    const good = entry !== null && typeof entry === 'object' && isVersion(entry.version) && isVersion(entry.minimumVersion)
        && typeof entry.sha512 === 'string' && /^[0-9a-f]{128}$/.test(entry.sha512)
    if (!good) throw new Error(`The feed's record of what was promoted for ${platform} is not one this tooling writes. Look at the update-feed branch before promoting.`)
    return entry
}

function promotedRelease({ platform, version, file, repository, minimumVersion, before, highest }) {
    const { file: name } = installerFor(platform)
    if (highest && compareVersions(version, highest.version) < 0) {
        throw new Error(`${platform} was offered ${highest.version}, and an app never goes back. To undo ${highest.version}, release a higher version with the older code.`)
    }
    // Checked against the highest version as well as what is offered now, since a pause takes the latter away.
    for (const was of [before, highest]) {
        if (was?.version === version && was.sha512 !== file.sha512) throw new Error(`${name} ${version} is not the file that was promoted. A released file never changes: release a new version.`)
    }
    const minimum = minimumVersion ?? before?.minimumVersion ?? highest?.minimumVersion ?? '0.0.0'
    if (!isVersion(minimum) || compareVersions(minimum, version) > 0) throw new Error(`The minimum version ${minimum} is not a version at or below ${version}.`)
    const base = `https://github.com/${repository}/releases`
    return { version, url: `${base}/download/v${version}/${name}`, sha512: file.sha512, size: file.size, minimumVersion: minimum, page: `${base}/tag/v${version}` }
}

function promote(change, { releases, promoted, repository }) {
    if (!isVersion(change.version)) throw new Error(`"${change.version}" is not a version.`)
    const files = Object.entries(change.files)
    if (files.length === 0) throw new Error('No platform was chosen.')
    for (const [platform, file] of files) {
        const release = promotedRelease({
            platform, version: change.version, file, repository, minimumVersion: change.minimumVersion,
            before: releases[platform], highest: promotedEntry(platform, promoted[platform]),
        })
        releases[platform] = release
        promoted[platform] = { version: release.version, sha512: release.sha512, minimumVersion: release.minimumVersion }
    }
}

function pause(change, { releases }) {
    if (change.platforms.length === 0) throw new Error('No platform was chosen.')
    for (const platform of change.platforms) {
        if (!Object.hasOwn(releases, platform)) throw new Error(`${platform} is not in the feed.`)
        delete releases[platform]
    }
}

const CHANGES = { promote, pause, renew() {} }

/**
 * The payload after `previous`, with one change made:
 * - `{ action: 'promote', version, files: { <platform>: { size, sha512 } }, minimumVersion? }`
 * - `{ action: 'pause', platforms }`: nobody is offered those platforms until they are promoted again
 * - `{ action: 'renew' }`: a later date and nothing else
 */
export function nextPayload({ previous, startAfter, change, repository, now }) {
    if (!Object.hasOwn(CHANGES, change.action)) throw new Error(`"${change.action}" is not a change to a feed.`)
    const sequence = nextSequence(previous, startAfter)
    const releases = { ...previous?.channels[CHANNEL] }
    const promoted = { ...previous?.promoted }
    CHANGES[change.action](change, { releases, promoted, repository })
    return {
        schema: 1, sequence, expires: new Date(now + LIFETIME_DAYS * DAY_MS).toISOString(),
        channels: { ...previous?.channels, [CHANNEL]: releases }, promoted,
    }
}

/**
 * Every set of keys an app may hold, each once: the one apps are built with now (update-keys.json) first,
 * then each set a released build carries (released-update-keys.json). A feed is signed only when all of
 * them take it, so replacing a key never leaves the apps already installed without updates. A set comes
 * out of that list only when no app that holds it should be updated any more.
 */
export function keySetsToSatisfy(current, released) {
    if (current.length === 0) throw new Error('update-keys.json holds no key, so no app built now checks for updates. Commit the keys first.')
    const sets = [current]
    for (const { firstVersion, keys } of released) {
        if (!isVersion(firstVersion)) throw new Error(`"${firstVersion}" in released-update-keys.json is not a version.`)
        if (!Array.isArray(keys) || keys.length === 0) throw new Error(`The keys released in ${firstVersion} are no key at all.`)
        if (!sets.some((set) => JSON.stringify(set) === JSON.stringify(keys))) sets.push(keys)
    }
    return sets
}

/** Every key in the sets, once each: what a feed already published may be signed with. */
export function anyKeyOf(sets) {
    const seen = new Map()
    for (const key of sets.flat()) seen.set(key.id, key)
    return [...seen.values()]
}

const idsOf = (set) => set.map((key) => key.id).join(', ')

/**
 * The signed feed, once every set of keys in `keySets` is seen to take it. The first set is the one the
 * apps are built with now.
 */
export function signedFeed(payload, signingKeys, keySets, now = Date.parse(payload.expires) - 1) {
    const feed = signFeed(Buffer.from(JSON.stringify(payload), 'utf8'), signingKeys)
    keySets.forEach((keys, index) => {
        try {
            readFeed(feed, { keys, highestSequence: payload.sequence, now })
        } catch (error) {
            const message = index === 0
                ? 'An app would not take this feed. Check that update-keys.json has the public half of the signing key, so that the apps trust it.'
                : `Apps that trust only ${idsOf(keys)} would not take this feed. Sign with one of those keys as well (UPDATE_FEED_KEY_NEXT), or take that set out of released-update-keys.json once no app holding it should be updated.`
            throw new Error(message, { cause: error })
        }
    })
    return feed
}

/** A signing key as its secret holds it: `<id>:<32 bytes in base64>`. */
export function parseSigningKey(text) {
    const [, id, encoded] = /^([a-z0-9-]+):([A-Za-z0-9+/]{43}=)$/.exec(text.trim()) ?? []
    if (!id) throw new Error('The signing key is not written as "<id>:<base64>".')
    return { id, seed: Buffer.from(encoded, 'base64') }
}
