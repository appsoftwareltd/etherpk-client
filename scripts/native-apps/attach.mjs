/**
 * Puts files on a GitHub Release, whether it is new or is there already:
 *
 *   node scripts/native-apps/attach.mjs <tag> <file>...
 *
 * A release is made again when a failed installer job is re-run. What is on it stays: a file that is
 * the same is passed over, one that is not there is added, and a published file that differs stops
 * this, since somebody may have it. Only SHA256SUMS is replaced, because it lists more files then.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { CHECKSUMS } from './installers.mjs'

export function planAttach(existing, local) {
    const there = new Map(existing.map(({ name, digest }) => [name, digest]))
    const plan = { upload: [], replace: [] }
    for (const { name, digest } of local) {
        if (!there.has(name)) plan.upload.push(name)
        else if (there.get(name) === digest) continue
        else if (name === CHECKSUMS) plan.replace.push(name)
        else throw new Error(`${name} is on the release already and is another file. A published file is never replaced: release a new version.`)
    }
    return plan
}

const gh = (...args) => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })

function main() {
    const [tag, ...paths] = process.argv.slice(2)
    const { assets } = JSON.parse(gh('release', 'view', tag, '--json', 'assets'))
    const local = paths.map((path) => ({ path, name: basename(path), digest: `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}` }))
    const { upload, replace } = planAttach(assets.map(({ name, digest }) => ({ name, digest: digest ?? null })), local)
    const pathOf = (name) => local.find((one) => one.name === name).path
    if (upload.length > 0) gh('release', 'upload', tag, ...upload.map(pathOf))
    if (replace.length > 0) gh('release', 'upload', tag, '--clobber', ...replace.map(pathOf))
    console.log(`${tag}: added ${upload.join(', ') || 'nothing'}, replaced ${replace.join(', ') || 'nothing'}`)
}

if (import.meta.main) main()
