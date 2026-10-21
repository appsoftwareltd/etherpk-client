import { describe, expect, it } from 'vitest'

import { gitBlobSha } from './git-blob-sha'

// Each expected value is what `git hash-object --stdin` prints for the same bytes.
describe('gitBlobSha', () => {
    it('names an empty file as git does', async () => {
        expect(await gitBlobSha('')).toBe('e69de29bb2d1d6434b8b29ae775ad8c2e48c5391')
    })

    it('names a text file as git does', async () => {
        expect(await gitBlobSha('hello world\n')).toBe('3b18e512dba79e4c8300dd08aeb37f8e728b8dad')
    })

    it('counts the UTF-8 bytes of non-ASCII text, not its characters', async () => {
        expect(await gitBlobSha('café ✓\n')).toBe('6b2b281e1146f9673f218f9c76042db37be95d03')
    })

    it('names a binary file as git does', async () => {
        expect(await gitBlobSha(new Uint8Array([0, 1, 2, 255, 254]))).toBe('bfa7018e30c510999bbe462316bdd3839a58aa56')
    })

    it('gives text and the same bytes the same name', async () => {
        expect(await gitBlobSha(new TextEncoder().encode('hello world\n'))).toBe(await gitBlobSha('hello world\n'))
    })
})
