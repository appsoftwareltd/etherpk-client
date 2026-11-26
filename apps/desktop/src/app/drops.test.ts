import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type DropParts, type DropQuestion, droppedPaths, dropQuestion, MOST_DROPPED, MOST_LISTED, takeDrop } from './drops.ts'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'etherpk-drops-')) })
afterEach(() => rm(dir, { recursive: true, force: true }))

function parts(answer: boolean) {
    const seen = { asked: [] as DropQuestion[], opened: [] as string[][], logged: [] as string[] }
    const drop: DropParts = {
        ask: async (question) => { seen.asked.push(question); return answer },
        open: async (paths) => { seen.opened.push(paths) },
        log: (message) => { seen.logged.push(message) },
    }
    return { seen, drop }
}

describe('a drop on a window', () => {
    it('opens nothing until the person says yes, and then what was dropped', async () => {
        await mkdir(join(dir, 'Garden'))
        await writeFile(join(dir, 'Beans.md'), 'x')
        const paths = [join(dir, 'Garden'), join(dir, 'Beans.md')]
        const no = parts(false)
        await takeDrop(paths, no.drop)
        expect(no.seen.asked).toHaveLength(1)
        expect(no.seen.opened).toEqual([])
        const yes = parts(true)
        await takeDrop(paths, yes.drop)
        expect(yes.seen.opened).toEqual([paths])
    })

    it('names every path it would open, a folder with all it holds', async () => {
        await mkdir(join(dir, 'Garden'))
        const one = parts(true)
        await takeDrop([join(dir, 'Garden')], one.drop)
        expect(one.seen.asked[0].message).toBe('Open “Garden” in EtherPK?')
        expect(one.seen.asked[0].detail).toContain('this folder and everything inside')
        expect(one.seen.asked[0].detail).toContain(join(dir, 'Garden'))
    })

    it('lists the first few of a large drop and counts the rest', () => {
        const paths = Array.from({ length: MOST_LISTED + 3 }, (_, index) => `/notes/file-${index}.md`)
        const { message, detail } = dropQuestion(paths, 0)
        expect(message).toBe(`Open ${MOST_LISTED + 3} items in EtherPK?`)
        expect(detail).toContain('/notes/file-0.md')
        expect(detail).not.toContain(`/notes/file-${MOST_LISTED}.md`)
        expect(detail).toContain('and 3 more')
    })

    it('asks nothing for what is not a drop', async () => {
        for (const sent of [null, 'one', [], [1], [''], Array.from({ length: MOST_DROPPED + 1 }, (_, index) => `/a/${index}`)]) {
            const { seen, drop } = parts(true)
            await takeDrop(sent, drop)
            expect(seen.asked).toEqual([])
            expect(seen.opened).toEqual([])
        }
        expect(droppedPaths(['/a', '/a'])).toEqual(['/a'])
    })
})
