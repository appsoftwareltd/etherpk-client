import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { readPackageVersion, resolveBuildInfo } from './resolve-build-info'

const now = () => new Date('2026-08-31T09:15:00.000Z')

describe('resolveBuildInfo', () => {
    it('prefers GIT_COMMIT, the only source a Docker build has', () => {
        const info = resolveBuildInfo('0.8.2', {
            env: { GIT_COMMIT: '  abc123  ' },
            readGitCommit: () => 'def456',
            now,
        })

        expect(info).toEqual({ version: '0.8.2', commit: 'abc123', builtAt: '2026-08-31T09:15:00.000Z' })
    })

    it('falls back to the working copy for local and dev builds', () => {
        const info = resolveBuildInfo('0.8.2', { env: {}, readGitCommit: () => 'def456', now })

        expect(info.commit).toBe('def456')
    })

    it('ignores an empty GIT_COMMIT build argument', () => {
        const info = resolveBuildInfo('0.8.2', { env: { GIT_COMMIT: '' }, readGitCommit: () => 'def456', now })

        expect(info.commit).toBe('def456')
    })

    it('degrades to unknown rather than failing the build', () => {
        const info = resolveBuildInfo('', { env: {}, readGitCommit: () => null, now })

        expect(info.commit).toBe('unknown')
        expect(info.version).toBe('unknown')
    })
})

describe('readPackageVersion', () => {
    let directory: string | undefined

    afterEach(() => {
        if (directory) rmSync(directory, { recursive: true, force: true })
        directory = undefined
    })

    function packageJson(contents: string): URL {
        directory = mkdtempSync(join(tmpdir(), 'build-stamp-'))
        const file = join(directory, 'package.json')
        writeFileSync(file, contents)
        return pathToFileURL(file)
    }

    it('reads the version an app was released as from its package.json', () => {
        expect(readPackageVersion(packageJson('{ "name": "etherpk-client", "version": "0.8.2" }'))).toBe('0.8.2')
    })

    it('degrades to unknown for a package.json without a version', () => {
        expect(readPackageVersion(packageJson('{ "name": "etherpk-client" }'))).toBe('unknown')
    })
})
