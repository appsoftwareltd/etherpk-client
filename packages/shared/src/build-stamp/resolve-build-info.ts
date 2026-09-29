/**
 * Build-time half of the build stamp (see `./build-stamp`): resolves the release version and the
 * commit once, when `vite.config.ts` is loaded, so they can be frozen into each app's bundle by a
 * Vite `define`.
 *
 * Node-only — it reads the filesystem and shells out to git — and therefore imported by config
 * files rather than by anything that ships to the runtime.
 *
 * The version is the app's own `package.json` version, read by `readPackageVersion`. Each app
 * reads its own rather than the root's because a Public Repository replaces the root manifest.
 *
 * Two sources for the commit, in order:
 *
 * 1. `GIT_COMMIT`, the Docker build argument. Images are built from a context that excludes
 *    `.git` (see `.dockerignore`), so inside a container build this is the only source, and
 *    CI passes `github.sha`.
 * 2. `git rev-parse HEAD` in the working copy, which covers local builds and `pnpm dev`.
 *
 * Neither available (a tarball checkout, say) degrades to `unknown` rather than failing the
 * build: an unstamped page is a nuisance, a build that will not run is not.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import type { BuildInfo } from './build-stamp'

export interface BuildInfoSources {
    env?: Record<string, string | undefined>
    readGitCommit?: () => string | null
    now?: () => Date
}

/** Full HEAD SHA of the working copy, or null when git is absent or this is not a checkout. */
export function gitCommitFromWorkingCopy(): string | null {
    try {
        const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim()
        return commit || null
    } catch {
        return null
    }
}

/** The `version` of the `package.json` at `packageJson`, or `unknown` when it has none. */
export function readPackageVersion(packageJson: URL): string {
    const { version } = JSON.parse(readFileSync(packageJson, 'utf8')) as { version?: unknown }
    return typeof version === 'string' && version.trim() ? version.trim() : 'unknown'
}

export function resolveBuildInfo(version: string, sources: BuildInfoSources = {}): BuildInfo {
    const {
        env = process.env,
        readGitCommit = gitCommitFromWorkingCopy,
        now = () => new Date(),
    } = sources

    return {
        version: version.trim() || 'unknown',
        commit: env.GIT_COMMIT?.trim() || readGitCommit() || 'unknown',
        builtAt: now().toISOString(),
    }
}
