import type { PickDateOptions } from '@appsoftwareltd/etherpk-extension-api'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { pickTaskDate, setTaskEditorDialogs } from './task-editor-dates'

// The Task Editor's Due and Scheduled fields (ADR 0170) open the Client's own Date Picker, the one
// the document editor shows, through the extension's context.

afterEach(() => setTaskEditorDialogs(null))

const anchor = {} as HTMLElement

describe("a date field's calendar", () => {
    it('opens beside the field on the date it shows, named for the field', async () => {
        const pickDate = vi.fn(async (_options: PickDateOptions) => '2026-11-12')
        setTaskEditorDialogs({ pickDate })
        expect(await pickTaskDate(anchor, 'Due', '2026-11-09')).toBe('2026-11-12')
        expect(pickDate).toHaveBeenCalledWith({ anchor, value: '2026-11-09', label: 'Due date' })
    })

    it('opens on today for a field with no date', async () => {
        const pickDate = vi.fn(async (_options: PickDateOptions) => undefined)
        setTaskEditorDialogs({ pickDate })
        expect(await pickTaskDate(anchor, 'Scheduled', null)).toBeUndefined()
        expect(pickDate).toHaveBeenCalledWith({ anchor, value: undefined, label: 'Scheduled date' })
    })

    it('changes nothing for an answer that names no day', async () => {
        setTaskEditorDialogs({ pickDate: async () => '2026-02-30' })
        expect(await pickTaskDate(anchor, 'Due', null)).toBeUndefined()
    })

    it('changes nothing before the extension has started in a graph', async () => {
        expect(await pickTaskDate(anchor, 'Due', null)).toBeUndefined()
    })
})
