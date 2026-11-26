/**
 * Writes the next update feed. The promote workflow runs it. See feed.mjs for what each action does.
 *
 *   node scripts/native-apps/make-feed.mjs --action promote --version 1.2.0 --assets <folder of the release's files>
 *        --platforms released|<platform,platform> [--minimum-version 1.0.0]
 *        --previous <feed.json> | --start-after <sequence>
 *        --keys apps/desktop/update-keys.json [--released-keys <released-update-keys.json>]  --out <feed.json> | --show
 *
 * The feed is signed only when every set of keys an installed app may hold takes it: the one in --keys,
 * which the apps are built with now, and each in --released-keys (this folder's released-update-keys.json
 * unless given), which released builds carry.
 *
 * UPDATE_FEED_KEY holds the signing key (create-update-keys.mjs), and UPDATE_FEED_KEY_NEXT a second one
 * to sign with as well, while keys are being replaced. `--show` prints what would be signed and needs no key.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { anyKeyOf, keySetsToSatisfy, nextPayload, parseSigningKey, previousPayload, signedFeed } from './feed.mjs'
import { INSTALLERS, installerFor } from './installers.mjs'

const { values } = parseArgs({
    options: Object.fromEntries([
        ...['action', 'version', 'assets', 'platforms', 'minimum-version', 'previous', 'start-after', 'keys', 'released-keys', 'out'].map((name) => [name, { type: 'string' }]),
        ['show', { type: 'boolean', default: false }],
    ]),
})
/** An option left empty, as a workflow's input is, was not given. */
const given = (name) => values[name] || undefined

function chosenPlatforms() {
    const asked = given('platforms') ?? 'released'
    if (asked !== 'released') return asked.split(',').map((one) => one.trim()).filter(Boolean)
    if (values.action !== 'promote') throw new Error('Name the platforms.')
    return INSTALLERS.filter(({ file }) => existsSync(join(values.assets, file))).map((one) => one.platform)
}

function releasedFile(platform) {
    const path = join(values.assets, installerFor(platform).file)
    if (!existsSync(path)) throw new Error(`The release has no ${installerFor(platform).file}.`)
    const bytes = readFileSync(path)
    return { size: bytes.length, sha512: createHash('sha512').update(bytes).digest('hex') }
}

function change() {
    const { action } = values
    if (action === 'renew') return { action }
    const platforms = chosenPlatforms()
    if (action !== 'promote') return { action, platforms }
    return { action, version: values.version, minimumVersion: given('minimum-version'), files: Object.fromEntries(platforms.map((one) => [one, releasedFile(one)])) }
}

function main() {
    const keySets = keySetsToSatisfy(
        JSON.parse(readFileSync(values.keys, 'utf8')),
        JSON.parse(readFileSync(given('released-keys') ?? join(import.meta.dirname, 'released-update-keys.json'), 'utf8')),
    )
    const startAfter = given('start-after')
    const payload = nextPayload({
        // The feed there now may be signed by any key an app holds, a set on its way out included.
        previous: given('previous') ? previousPayload(readFileSync(values.previous, 'utf8'), anyKeyOf(keySets)) : null,
        startAfter: startAfter === undefined ? undefined : Number(startAfter),
        change: change(), repository: process.env.GITHUB_REPOSITORY, now: Date.now(),
    })
    if (values.show) {
        console.log(JSON.stringify(payload, null, 2))
        return
    }
    const signing = [process.env.UPDATE_FEED_KEY, process.env.UPDATE_FEED_KEY_NEXT].filter(Boolean).map(parseSigningKey)
    if (signing.length === 0) throw new Error('UPDATE_FEED_KEY is not set.')
    writeFileSync(values.out, signedFeed(payload, signing, keySets))
    console.log(`Signed feed ${payload.sequence}, good until ${payload.expires}.`)
}

try {
    main()
} catch (error) {
    console.error(error.cause ? `${error.message}\n(${error.cause.message})` : error.message)
    process.exit(1)
}
