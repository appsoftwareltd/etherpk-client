import { beforeEach, describe, expect, it } from 'vitest'

import { getNotices, resetNotices } from '$lib/activity/notices'

import { showCascadeNotice, TASK_CASCADE_NOTICE } from './task-cascade-notice'
import type { TaskWrite, TaskWriteOutcome } from './task-write'

beforeEach(() => resetNotices())

const ticked: TaskWrite = {
    line: 0,
    before: '- [ ] Garden',
    after: '- [x] Garden',
    nested: [
        { line: 1, before: '  - [ ] weed', after: '  - [x] weed' },
        { line: 2, before: '  - [ ] dig', after: '  - [x] dig' },
    ],
}

const undone = (skipped: number): TaskWriteOutcome => ({ ok: true, text: 'Garden', changed: true, skipped, line: 0, before: '', after: '', nested: [] })

function notice() {
    const shown = getNotices().find((n) => n.id === TASK_CASCADE_NOTICE)
    if (!shown) throw new Error('no notice')
    return shown
}

describe('the notice for a write that brought nested tasks with it', () => {
    it('says how many nested tasks were ticked, and offers Undo', () => {
        expect(showCascadeNotice('Garden', ticked, async () => undone(0))).toBe(true)
        expect(notice()).toMatchObject({ tone: 'info', text: 'Ticked 2 tasks nested under "Garden".' })
        expect(notice().actions?.map((a) => a.label)).toEqual(['Undo'])
    })

    it('says unticked, and counts one task as one', () => {
        showCascadeNotice('Garden', { line: 0, before: '- [x] Garden', after: '- [ ] Garden', nested: [{ line: 1, before: '  - [x] weed', after: '  - [ ] weed' }] }, async () => undone(0))
        expect(notice().text).toBe('Unticked 1 task nested under "Garden".')
    })

    it('shows nothing for a write that brought nothing with it', () => {
        expect(showCascadeNotice('Garden', { ...ticked, nested: [] }, async () => undone(0))).toBe(false)
        expect(getNotices()).toEqual([])
    })

    it('reports what Undo did in its place', async () => {
        showCascadeNotice('Garden', ticked, async () => undone(0))
        await notice().actions![0].run()
        expect(notice()).toMatchObject({ tone: 'info', text: 'Undone: "Garden" and the tasks nested under it are as they were.' })
        expect(notice().actions).toBeUndefined()
    })

    it('says how many nested tasks Undo left because they changed since', async () => {
        showCascadeNotice('Garden', ticked, async () => undone(1))
        await notice().actions![0].run()
        expect(notice().text).toBe('Undone, except 1 nested task that changed since. It was left as it is.')
    })

    it('says why Undo changed nothing', async () => {
        showCascadeNotice('Garden', ticked, async () => ({ ok: false, reason: 'stale' }))
        await notice().actions![0].run()
        expect(notice()).toMatchObject({ tone: 'error', text: '"Garden" changed since, so nothing was undone.' })

        showCascadeNotice('Garden', ticked, async () => ({ ok: false, reason: 'missing' }))
        await notice().actions![0].run()
        expect(notice().text).toBe('The document holding "Garden" was renamed or deleted, so nothing was undone.')
    })
})
