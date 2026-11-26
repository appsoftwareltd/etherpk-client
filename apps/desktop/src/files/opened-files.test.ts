import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Grants } from '../fs/grants.ts'
import { Locks } from '../fs/locks.ts'
import { OpenedFiles } from './opened-files.ts'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'etherpk-opened-')) })
afterEach(() => rm(dir, { recursive: true, force: true }))

describe('a file the app is opened with', () => {
    it('is given when it is an ordinary file', async () => {
        await writeFile(join(dir, 'Beans.md'), '- water them')
        const files = new OpenedFiles(await Grants.open(join(dir, 'grants.json'), () => {}), new Locks())
        expect(await files.add(join(dir, 'Beans.md'))).toMatchObject({ name: 'Beans.md', type: 'text/markdown' })
    })
    it.runIf(process.platform !== 'win32')('is refused, and kept nowhere, when it is a named pipe', async () => {
        execFileSync('mkfifo', [join(dir, 'pipe.md')])
        const files = new OpenedFiles(await Grants.open(join(dir, 'grants.json'), () => {}), new Locks())
        await expect(files.add(join(dir, 'pipe.md'))).rejects.toMatchObject({ failure: 'TypeMismatchError' })
        await expect(readFile(join(dir, 'grants.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    })
})
