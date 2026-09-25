import { describe, expect, it } from 'vitest'
import { resolveBuildInfo } from './resolve-build-info'

const now = () => new Date('2026-08-31T09:15:00.000Z')

describe('resolveBuildInfo', () => {
    it('prefers GIT_COMMIT, the only source a Docker build has', () => {
        const info = resolveBuildInfo({
            env: { GIT_COMMIT: '  abc123  ' },
            readGitCommit: () => 'def456',
            now,
        })

        expect(info).toEqual({ commit: 'abc123', builtAt: '2026-08-31T09:15:00.000Z' })
    })

    it('falls back to the working copy for local and dev builds', () => {
        const info = resolveBuildInfo({ env: {}, readGitCommit: () => 'def456', now })

        expect(info.commit).toBe('def456')
    })

    it('ignores an empty GIT_COMMIT build argument', () => {
        const info = resolveBuildInfo({ env: { GIT_COMMIT: '' }, readGitCommit: () => 'def456', now })

        expect(info.commit).toBe('def456')
    })

    it('degrades to unknown rather than failing the build', () => {
        const info = resolveBuildInfo({ env: {}, readGitCommit: () => null, now })

        expect(info.commit).toBe('unknown')
    })
})
