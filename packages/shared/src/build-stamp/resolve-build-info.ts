/**
 * Build-time half of the build stamp (see `./build-stamp`): resolves the commit once, when
 * `vite.config.ts` is loaded, so it can be frozen into each app's bundle by a Vite `define`.
 *
 * Node-only — it shells out to git — and therefore imported by config files rather than by
 * anything that ships to the runtime.
 *
 * Two sources, in order:
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

export function resolveBuildInfo(sources: BuildInfoSources = {}): BuildInfo {
    const {
        env = process.env,
        readGitCommit = gitCommitFromWorkingCopy,
        now = () => new Date(),
    } = sources

    return {
        commit: env.GIT_COMMIT?.trim() || readGitCommit() || 'unknown',
        builtAt: now().toISOString(),
    }
}
