import { describe, expect, it } from 'vitest'

import { openTaskTagContext, rankTaskTagItems, TASK_TAG_ITEMS } from './task-tag-complete-core'

describe('openTaskTagContext', () => {
    it('fires on a word-boundary #, carrying what has been typed after it', () => {
        expect(openTaskTagContext('- [ ] #')).toEqual({ hash: 6, query: '' })
        expect(openTaskTagContext('- [ ] #P1')).toEqual({ hash: 6, query: 'P1' })
        expect(openTaskTagContext('- [ ] some text #due')).toEqual({ hash: 16, query: 'due' })
    })

    it('does not fire mid-token, so C# and issue#42 stay prose', () => {
        expect(openTaskTagContext('- [ ] C#')).toBeNull()
        expect(openTaskTagContext('- [ ] issue#42')).toBeNull()
    })

    it('does not fire on ## — that is a heading being typed', () => {
        expect(openTaskTagContext('##')).toBeNull()
    })

    it('closes once a space is typed after the tag', () => {
        expect(openTaskTagContext('- [ ] #P1 ')).toBeNull()
    })
})

describe('rankTaskTagItems', () => {
    it('lists everything in menu order for a bare #, so it is a discovery surface', () => {
        expect(rankTaskTagItems('').map((i) => i.detail)).toEqual(TASK_TAG_ITEMS.map((i) => i.detail))
    })

    it('reaches an item by its tag, its label, or a keyword', () => {
        expect(rankTaskTagItems('P1')[0].detail).toBe('#P1')
        expect(rankTaskTagItems('crit')[0].detail).toBe('#P1')
        expect(rankTaskTagItems('waiting')[0].detail).toBe('#W')
        expect(rankTaskTagItems('deadline')[0].detail).toBe('#D-')
    })

    it('resolves a bare letter to its state first and the hyphen to its date only, as the grammar does', () => {
        expect(rankTaskTagItems('D').slice(0, 2).map((i) => i.detail)).toEqual(['#D', '#D-'])
        expect(rankTaskTagItems('D-').map((i) => i.detail)).toEqual(['#D-'])
        expect(rankTaskTagItems('C').slice(0, 2).map((i) => i.detail)).toEqual(['#C', '#C-'])
        expect(rankTaskTagItems('C-').map((i) => i.detail)).toEqual(['#C-'])
    })

    it('drops items that match nothing', () => {
        expect(rankTaskTagItems('zzz')).toEqual([])
    })
})
