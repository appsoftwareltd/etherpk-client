/**
 * Makes the two keys the update feed is signed with. Run it once, on your own device:
 *
 *   node scripts/native-apps/create-update-keys.mjs <folder outside any repository> [--name <prefix>]
 *
 * The first key signs. The second is a spare that the apps trust from the start, so that the first can
 * be replaced with no app left behind. The private halves are written to files only you can read, and
 * printed nowhere.
 */
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { publicKeyFromSeed } from '../../apps/desktop/src/update/feed.ts'

function fail(message) {
    console.error(message)
    process.exit(1)
}

const { positionals: [given], values: { name } } = parseArgs({ allowPositionals: true, options: { name: { type: 'string', default: `etherpk-${new Date().getFullYear()}` } } })
if (!given) fail('Give a folder outside any repository for the keys: node scripts/native-apps/create-update-keys.mjs <folder>')
if (!/^[a-z0-9-]+$/.test(name)) fail('A key name has small letters, digits and hyphens only.')

const folder = resolve(given)
let nearest = folder
while (!existsSync(nearest)) nearest = dirname(nearest)
// Without GIT_DIR and its kin, which a Git hook exports, `git` judges the folder itself.
const ownGitEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')))
if (spawnSync('git', ['-C', nearest, 'rev-parse', '--show-toplevel'], { stdio: 'ignore', env: ownGitEnv }).status === 0) {
    fail(`${folder} is inside a Git repository. A private key must never be in one: choose another folder.`)
}
const ids = [`${name}-a`, `${name}-b`]
if (ids.some((id) => existsSync(join(folder, `${id}.key`)))) fail(`There are keys of this name in ${folder} already. Choose another --name.`)

mkdirSync(folder, { recursive: true, mode: 0o700 })
const publicKeys = ids.map((id) => {
    const seed = randomBytes(32)
    writeFileSync(join(folder, `${id}.key`), `${id}:${seed.toString('base64')}\n`, { mode: 0o600, flag: 'wx' })
    return { id, publicKey: publicKeyFromSeed(seed) }
})
const publicFile = join(folder, 'update-keys.json')
writeFileSync(publicFile, `${JSON.stringify(publicKeys, null, 4)}\n`)

console.log(`Made two keys in ${folder}. Next:

1. Back up both .key files to two places that are not online, such as a password manager and a USB drive in a safe.
2. Copy ${publicFile} over apps/desktop/update-keys.json in the private repository. Add the same keys
   to scripts/native-apps/released-update-keys.json as { "firstVersion": "<the next version>", "keys": [...] },
   and commit both. Both apps trust these keys from the next build.
3. Give the first key to the update-feed environment of the public repository:
     gh secret set UPDATE_FEED_KEY --env update-feed --repo appsoftwareltd/etherpk-client < ${join(folder, `${ids[0]}.key`)}
4. Keep ${ids[1]}.key offline. Nothing needs it until the first key is replaced.
5. Delete ${folder} once the backups are checked.`)
