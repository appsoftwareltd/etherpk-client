/**
 * Gathers the installers that passed their smoke tests into one folder, with SHA256SUMS:
 *
 *   node scripts/native-apps/collect.mjs --from <downloaded artifacts> --out <folder> --nix-template nix/package.nix --version <x.y.z>
 *
 * When the .deb passed, the Nix package of the release is written beside it (nix-package.mjs).
 *
 * NEEDS is the workflow's `toJSON(needs)`. An installer whose job did not pass is left out, named in an
 * error annotation and in the release notes, and does not hold the release back. Android is expected
 * only once ANDROID_CERT_SHA256 names the certificate its releases are signed with.
 */
import { createHash } from 'node:crypto'
import { appendFileSync, copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { CHECKSUMS, INSTALLERS } from './installers.mjs'
import { NIX_PACKAGE, nixPackageFor } from './nix-package.mjs'

export function chooseInstallers(needs, { android }) {
    const wanted = INSTALLERS.filter((one) => one.platform !== 'android' || android)
    const didPass = (one) => needs[one.job]?.result === 'success'
    return { made: wanted.filter(didPass), missing: wanted.filter((one) => !didPass(one)) }
}

/** What the release notes say about the installers, in Markdown. */
export function notesFor({ made, missing }, repository) {
    const lines = []
    if (made.length > 0) {
        lines.push(
            'The installers are not signed by a certificate authority. To check a download, run '
            + `\`sha256sum --check --ignore-missing ${CHECKSUMS}\` beside it, or \`gh attestation verify ${made[0].file} --repo ${repository}\`, `
            + 'which also says that this repository built it.',
        )
    }
    if (missing.length > 0) lines.push(`This release has no installer for ${missing.map((one) => one.label).join(', ')} yet. The one in the release before still works.`)
    return lines.map((line) => `${line}\n`).join('\n')
}

const sha256Of = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')

function found(from, name) {
    const entry = readdirSync(from, { recursive: true, withFileTypes: true }).find((one) => one.isFile() && one.name === name)
    if (!entry) throw new Error(`${name} passed its tests and is not among the artifacts.`)
    return join(entry.parentPath, name)
}

/** The release's Nix package, beside the .deb it installs, when the .deb passed. Its digest joins the others. */
function writeNixPackage(choice, digests, values) {
    const deb = choice.made.find((one) => one.platform === 'linux-x64-deb')
    if (!deb) return
    if (!values['nix-template'] || !values.version) throw new Error('The .deb passed, and its Nix package needs --nix-template and --version.')
    const target = join(values.out, NIX_PACKAGE)
    writeFileSync(target, nixPackageFor(readFileSync(values['nix-template'], 'utf8'), values.version, digests.get(deb.file)))
    digests.set(NIX_PACKAGE, sha256Of(target))
}

function main() {
    const { values } = parseArgs({ options: { from: { type: 'string' }, out: { type: 'string' }, 'nix-template': { type: 'string' }, version: { type: 'string' } } })
    const android = (process.env.ANDROID_CERT_SHA256 ?? '') !== ''
    const choice = chooseInstallers(JSON.parse(process.env.NEEDS), { android })
    mkdirSync(values.out, { recursive: true })
    const digests = new Map(choice.made.map(({ file }) => {
        const target = join(values.out, file)
        copyFileSync(found(values.from, file), target)
        return [file, sha256Of(target)]
    }))
    writeNixPackage(choice, digests, values)
    const sums = [...digests].map(([file, digest]) => `${digest}  ${file}\n`)
    if (sums.length > 0) writeFileSync(join(values.out, CHECKSUMS), sums.join(''))
    writeFileSync(join(values.out, 'installer-notes.md'), notesFor(choice, process.env.GITHUB_REPOSITORY))
    for (const { label, job } of choice.missing) console.log(`::error title=No installer for ${label}::${job} did not pass, so this release goes out without it. Fix it and re-run the failed jobs.`)
    if (!android) console.log('::notice title=No Android APK::The variable ANDROID_CERT_SHA256 is not set, so no APK was made.')
    if (process.env.GITHUB_OUTPUT) {
        appendFileSync(process.env.GITHUB_OUTPUT, `made=${choice.made.length}\ncomplete=${choice.missing.length === 0}\n`)
    }
    console.log(`Made: ${choice.made.map((one) => one.file).join(', ') || 'none'}`)
}

if (import.meta.main) main()
