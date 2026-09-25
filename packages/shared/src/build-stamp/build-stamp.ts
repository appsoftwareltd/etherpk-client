/**
 * The build stamp: an HTML comment carrying the commit each app was built from, emitted at
 * the top of every server-rendered page so `view-source:` answers "which build is running
 * here?" against `git log`, without a shell on the box or a registry lookup.
 *
 * The values are frozen into the bundle at build time (see `./resolve-build-info`), which is
 * the only moment the source commit is known — a running container has no `.git` directory.
 *
 * These two functions are the runtime half and stay free of Node built-ins so they can be
 * imported from `hooks.server.ts` alongside `decorateHtmlWithTheme`, which stamps the same
 * response.
 */

export interface BuildInfo {
    /** Commit the bundle was built from, or `unknown` when the build had none to report. */
    commit: string
    /** ISO-8601 UTC instant the bundle was built. */
    builtAt: string
}

/**
 * A commit SHA, an app name and an ISO timestamp need nothing outside this set, so anything
 * else is dropped rather than escaped. `--` is the one sequence that can close a comment
 * early, and hyphens are needed (`etherpk-client`, `2026-08-31`), so runs of them collapse to
 * one: the stamp cannot be broken out of, whatever the build passes in.
 */
const COMMENT_SAFE = /[^A-Za-z0-9:.+_-]/g

function commentSafe(value: string): string {
    return value.replace(COMMENT_SAFE, '').replace(/-{2,}/g, '-') || 'unknown'
}

/** `<!-- etherpk-client commit <sha> built <iso> -->`. */
export function buildStampComment(app: string, info: BuildInfo): string {
    return `<!-- ${commentSafe(app)} commit ${commentSafe(info.commit)} built ${commentSafe(info.builtAt)} -->`
}

const DOCTYPE = '<!doctype html>'

/**
 * Inserts the stamp directly beneath the doctype, so it is the first line of the page source.
 *
 * `transformPageChunk` sees the response in chunks; only the one holding the doctype matches,
 * and `replace` stops at the first occurrence, so the stamp is emitted exactly once.
 */
export function decorateHtmlWithBuildStamp(html: string, stamp: string): string {
    return html.replace(DOCTYPE, `${DOCTYPE}\n${stamp}`)
}
