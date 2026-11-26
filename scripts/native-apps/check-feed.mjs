/**
 * Looks at the update feed that is published, as a Native App would, and fails while there is time
 * to do something about it:
 *
 *   node scripts/native-apps/check-feed.mjs <address> <update-keys.json> [<released-update-keys.json>]
 *
 * It reads the feed with each set of keys an installed app may hold, as make-feed.mjs signs it.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readFeed } from '../../apps/desktop/src/update/feed.ts'
import { anyKeyOf, keySetsToSatisfy } from './feed.mjs'

const RENEW_WITHIN_DAYS = 30

export async function feedProblems(payload, { now, reach }) {
    const problems = []
    const daysLeft = Math.floor((Date.parse(payload.expires) - now) / 86_400_000)
    if (daysLeft < RENEW_WITHIN_DAYS) problems.push(`The feed ends in ${daysLeft} days. Run the promote workflow with the action "renew".`)
    for (const releases of Object.values(payload.channels)) {
        for (const [platform, { url, size }] of Object.entries(releases)) {
            const found = await reach(url)
            if (!found.ok) problems.push(`${platform}: ${url} is not there.`)
            else if (found.size !== size) problems.push(`${platform}: ${url} is ${found.size} bytes long, and the feed says ${size}.`)
        }
    }
    return problems
}

/** One problem for each set of keys whose apps would refuse the feed. */
export function keyProblems(text, keySets, now) {
    const problems = []
    for (const keys of keySets) {
        try {
            readFeed(text, { keys, highestSequence: 0, now })
        } catch (error) {
            problems.push(`Apps that trust only ${keys.map((key) => key.id).join(', ')} do not take the feed: ${error.message}`)
        }
    }
    return problems
}

async function reach(url) {
    const response = await fetch(url, { method: 'HEAD' })
    return { ok: response.ok, size: Number(response.headers.get('content-length')) }
}

async function main() {
    const [address, keysFile, releasedFile = join(import.meta.dirname, 'released-update-keys.json')] = process.argv.slice(2)
    const response = await fetch(address, { headers: { 'cache-control': 'no-cache' } })
    if (response.status === 404) {
        console.log('::notice::There is no feed yet. Nothing has been promoted.')
        return
    }
    if (!response.ok) throw new Error(`The feed was answered with ${response.status}.`)
    const keySets = keySetsToSatisfy(JSON.parse(readFileSync(keysFile, 'utf8')), JSON.parse(readFileSync(releasedFile, 'utf8')))
    const text = await response.text()
    const payload = readFeed(text, { keys: anyKeyOf(keySets), highestSequence: 0, now: Date.now() })
    const problems = [...keyProblems(text, keySets, Date.now()), ...await feedProblems(payload, { now: Date.now(), reach })]
    for (const problem of problems) console.log(`::error::${problem}`)
    console.log(`Feed ${payload.sequence}, good until ${payload.expires}.`)
    if (problems.length > 0) process.exitCode = 1
}

if (import.meta.main) await main()
