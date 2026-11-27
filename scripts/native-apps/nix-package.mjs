/**
 * The Nix package of one release: nix/package.nix with its `version` and `hash` set to the release's
 * .deb. collect.mjs writes it beside the installers as EtherPK-linux-x64.nix, and the release attaches
 * it, so `releases/latest/download/EtherPK-linux-x64.nix` always installs the newest .deb.
 *
 * The .deb's hash is known only once a release has built it, so the file in the repository cannot
 * carry it: the repository's copy keeps the values of the release it was last tested against.
 */

export const NIX_PACKAGE = 'EtherPK-linux-x64.nix'

const VERSION_LINE = /^( *version = )"[^"\n]*";$/gm
const HASH_LINE = /^( *hash = )"sha256-[A-Za-z0-9+/=]*";$/gm

/** The one line `pattern` matches in `template`, replaced. A template with none or several is refused. */
function replaceOne(template, pattern, value, name) {
    const count = [...template.matchAll(pattern)].length
    if (count !== 1) throw new Error(`The Nix package has ${count} "${name} = …;" lines at the start of a line, and must have exactly one.`)
    return template.replace(pattern, (_, start) => `${start}"${value}";`)
}

/** `template` (nix/package.nix) for `version`, whose .deb has the SHA-256 digest `sha256` in hex. */
export function nixPackageFor(template, version, sha256) {
    if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`"${version}" is not a release version (x.y.z).`)
    if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error(`"${sha256}" is not a SHA-256 digest in hex.`)
    const hash = `sha256-${Buffer.from(sha256, 'hex').toString('base64')}`
    return replaceOne(replaceOne(template, VERSION_LINE, version, 'version'), HASH_LINE, hash, 'hash')
}

/** What a Nix package says it installs: its version and hash. */
export function nixPackageValues(text) {
    const one = (pattern) => [...text.matchAll(pattern)].map((match) => /"([^"]*)"/.exec(match[0])[1])
    return { version: one(VERSION_LINE), hash: one(HASH_LINE) }
}
