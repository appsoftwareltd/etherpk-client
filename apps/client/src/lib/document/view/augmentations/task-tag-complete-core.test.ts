import { describe, expect, it } from 'vitest'

import { openTaskTagContext, rankTaskTagItems, TASK_TAG_ITEMS, taskTagMenu } from './task-tag-complete-core'

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

    it('does not fire inside a hash word, whose tail a row would leave behind as a word of its own', () => {
        expect(openTaskTagContext('- [ ] #P', '2 water')).toBeNull()
        expect(openTaskTagContext('- [ ] #D-2026', '-09-15 water')).toBeNull()
        expect(openTaskTagContext('- [ ] #wat', 'er the beans')).toBeNull()
    })

    it('does not fire on the # of a Task Tag, in any case', () => {
        expect(openTaskTagContext('- [ ] #', 'P2 water')).toBeNull()
        expect(openTaskTagContext('- [ ] #', 'p2 water')).toBeNull()
        expect(openTaskTagContext('- [ ] #', 'D-2026-09-15 water')).toBeNull()
    })

    it('fires at the end of a tag, and on a # typed in front of a word, which a row leaves alone', () => {
        expect(openTaskTagContext('- [ ] #P2', ' water')).toEqual({ hash: 6, query: 'P2' })
        expect(openTaskTagContext('- [ ] #', 'water the beans')).toEqual({ hash: 6, query: '' })
    })
})

describe('rankTaskTagItems', () => {
    it('lists everything in menu order for a bare #, so it is a discovery surface', () => {
        expect(rankTaskTagItems('').map((i) => i.detail)).toEqual(TASK_TAG_ITEMS.map((i) => i.detail))
    })

    it('reaches an item by its tag, its label, or a keyword', () => {
        expect(rankTaskTagItems('P1')[0].detail).toBe('#P1')
        expect(rankTaskTagItems('p1')[0].detail).toBe('#P1')
        expect(rankTaskTagItems('crit')[0].detail).toBe('#P1')
        expect(rankTaskTagItems('waiting')[0].detail).toBe('#W')
        expect(rankTaskTagItems('deadline')[0].detail).toBe('#D-')
        expect(rankTaskTagItems('T')[0].detail).toBe('#T')
        expect(rankTaskTagItems('test')[0].detail).toBe('#T')
        expect(rankTaskTagItems('A')[0].detail).toBe('#A')
        expect(rankTaskTagItems('archive')[0].detail).toBe('#A')
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

describe('taskTagMenu', () => {
    const details = (query: string, used: readonly string[], line = '') => taskTagMenu(query, used, line).items.map((item) => item.detail)

    it('offers no Free Tag for a bare #, which lists the Task Tags as ever', () => {
        expect(details('', ['garden', 'compost'])).toEqual(TASK_TAG_ITEMS.map((item) => item.detail))
    })

    it('adds the Free Tags holding the typed letters after the Task Tags', () => {
        const known = rankTaskTagItems('t').map((item) => item.detail)
        expect(details('t', ['paint', 'bug', 'trellis'])).toEqual([...known, '#trellis', '#paint'])
    })

    it('narrows both kinds as more is typed', () => {
        expect(details('trel', ['paint', 'trellis'])).toEqual(['#trellis'])
        expect(details('zzz', ['paint', 'trellis'])).toEqual([])
    })

    it('reads a typed letter in any case and writes the tag as the graph spells it', () => {
        expect(details('TREL', ['Trellis'])).toEqual(['#Trellis'])
        expect(taskTagMenu('TREL', ['Trellis'], '').items[0].action).toEqual({ kind: 'free-tag', tag: 'Trellis' })
    })

    it('matches letters in a row, not scattered as a Task Tag row may', () => {
        expect(details('zn', ['zinnia'])).toEqual([])
    })

    it('puts a Free Tag starting with the letters first, keeping the most used order within each', () => {
        expect(details('qu', ['squash', 'quince', 'quartz', 'bouquet'])).toEqual(['#quince', '#quartz', '#squash', '#bouquet'])
    })

    it('shows no more than a dozen Free Tags: typing narrows them', () => {
        const used = Array.from({ length: 30 }, (_, n) => `zone-${n}`)
        expect(details('zone', used)).toHaveLength(12)
    })

    it('leaves out a Free Tag the task already has, in any case', () => {
        expect(details('qu', ['quince', 'squash'], '- [ ] #Quince water ')).toEqual(['#squash'])
    })

    it('highlights the first row while nothing typed is itself a tag of the graph', () => {
        expect(taskTagMenu('t', ['paint'], '').selected).toBe(0)
    })

    it('highlights nothing when the word typed is itself a tag, so Enter does not rewrite it', () => {
        const menu = taskTagMenu('call', ['call', 'callback'], '')
        expect(menu.items.map((item) => item.detail)).toEqual([...rankTaskTagItems('call').map((item) => item.detail), '#callback'])
        expect(menu.selected).toBe(-1)
        expect(taskTagMenu('CALL', ['call'], '').selected).toBe(-1)
    })

    it('treats a word typed twice on a task as a tag of the graph too', () => {
        expect(taskTagMenu('call', ['call'], '- [ ] #call water ').selected).toBe(-1)
    })
})
