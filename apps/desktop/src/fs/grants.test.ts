import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import fc from 'fast-check'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Grants, parseGrants } from './grants.ts'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'etherpk-grants-')) })
afterEach(() => rm(dir, { recursive: true, force: true }))
const open = (logged: string[] = []) => Grants.open(join(dir, 'app', 'grants.json'), (message) => logged.push(message))

describe('Grants', () => {
    it('are kept over a restart, and the id says nothing of the path', async () => {
        const id = await (await open()).add('folder', '/home/someone/Notes')
        expect(id).not.toContain('Notes')
        expect((await open()).path('folder', id)).toBe('/home/someone/Notes')
    })
    it('are new for each choice, so forgetting one leaves the other', async () => {
        const grants = await open()
        const [a, b] = [await grants.add('folder', '/n'), await grants.add('folder', '/n')]
        await grants.forget('folder', a)
        expect(grants.find('folder', a)).toBe(null)
        expect(grants.path('folder', b)).toBe('/n')
    })
    it('are of one kind', async () => {
        const grants = await open()
        const id = await grants.add('file', '/n/A.md')
        expect(() => grants.path('folder', id)).toThrow('no permission')
        await grants.forget('folder', id)
        expect(grants.path('file', id)).toBe('/n/A.md')
    })
    it('are all on disk when many come at once', async () => {
        const grants = await open()
        const ids = await Promise.all(Array.from({ length: 30 }, (_, n) => grants.add('folder', `/n/${n}`)))
        const again = await open()
        expect(ids.map((id) => again.find('folder', id))).toEqual(ids.map((_, n) => `/n/${n}`))
    })
    it('a list that cannot be read is set aside, and said so', async () => {
        await (await open()).add('folder', '/n')
        await writeFile(join(dir, 'app', 'grants.json'), '{"version":1,"gra')
        const logged: string[] = []
        const grants = await open(logged)
        expect(logged).toHaveLength(1)
        await grants.add('folder', '/m')
        expect(await readFile(join(dir, 'app', 'grants.json.unreadable'), 'utf8')).toBe('{"version":1,"gra')
    })
    it('keeps the newest 500 files and every folder', async () => {
        const grants = await open()
        const folder = await grants.add('folder', '/n')
        const first = await grants.add('file', '/n/first.md')
        for (let n = 0; n < 500; n++) void grants.add('file', `/n/${n}.md`)
        const last = await grants.add('file', '/n/last.md')
        expect(grants.find('file', first)).toBe(null)
        expect(grants.find('folder', folder)).toBe('/n')
        expect(grants.find('file', last)).toBe('/n/last.md')
    })
    it('property: any text is read or refused, and never half believed', () => {
        fc.assert(fc.property(fc.oneof(fc.string(), fc.json(), fc.constantFrom('{"version":1,"grants":{"a":{"kind":"folder"}}}', '{"version":1,"grants":{"a":null,"b":{"kind":"x","path":"/"}}}')), (text) => {
            for (const grant of parseGrants(text)?.values() ?? []) expect(typeof grant.path).toBe('string')
        }), { seed: 20261125, numRuns: 500 })
    })
})
