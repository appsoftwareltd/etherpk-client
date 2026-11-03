import { describe, expect, it } from 'vitest'

import {
    asCommentBullet,
    commentChange,
    newTaskLines,
    readTaskStructure,
    taskComments,
    taskLineWithFreeTag,
    taskLineWithTitle,
    taskRemoval,
    taskTitle,
} from './task-structure'

const lines = (text: string) => text.split('\n')

describe('readTaskStructure', () => {
    it('reads the title, status, priority and Free Tags from the task line', () => {
        const task = readTaskStructure(['- [ ] #P2 #D #bug Fix the gate #needs-oil'], 0)
        expect(task).toMatchObject({ title: 'Fix the gate', status: 'doing', priority: 2, freeTags: ['bug', 'needs-oil'], due: null, scheduled: null })
    })

    it('reads the due and scheduled dates from the tag run', () => {
        const task = readTaskStructure(['- [ ] #P2 #S-2026-11-05 #D-2026-11-09 Fix the gate'], 0)
        expect(task).toMatchObject({ title: 'Fix the gate', due: '2026-11-09', scheduled: '2026-11-05' })
    })

    it('is null on a line that is no task, or inside fenced code', () => {
        expect(readTaskStructure(['- water the beans'], 0)).toBeNull()
        expect(readTaskStructure(['```', '- [ ] not a task', '```'], 1)).toBeNull()
    })

    it('takes every child but the Comments block as the description', () => {
        const doc = lines(
            [
                '- [[Garden]]',
                '  - [ ] Build the shed',
                '    - measure the floor',
                '      - twice',
                '    - [ ] buy the timber',
                '    - Comments',
                '      - the floor is level',
                '      - ordered the timber',
                '- Kitchen',
            ].join('\n'),
        )
        const task = readTaskStructure(doc, 1)!
        expect(task.childIndent).toBe('    ')
        expect(task.description).toEqual({ from: 2, to: 5 })
        expect(task.commentsLine).toBe(5)
        expect(task.comments).toEqual({ from: 6, to: 8 })
        expect(task.additionalContext).toBeNull()
        expect(task.end).toBe(8)
    })

    it('reads a Comments bullet only as a direct child whose words are exactly Comments', () => {
        const doc = lines(['- [ ] Build the shed', '  - notes', '    - Comments', '  - Comments about the roof'].join('\n'))
        const task = readTaskStructure(doc, 0)!
        expect(task.commentsLine).toBeNull()
        expect(task.description).toEqual({ from: 1, to: 4 })
    })

    it('reads the lines after the Comments block as the additional context', () => {
        const doc = lines(['- [ ] Build the shed', '  - measure', '  - Comments', '    - level', '  - paint it', '    - green', '- Kitchen'].join('\n'))
        const task = readTaskStructure(doc, 0)!
        expect(task.description).toEqual({ from: 1, to: 2 })
        expect(task.comments).toEqual({ from: 3, to: 4 })
        expect(task.additionalContext).toEqual({ from: 4, to: 6 })
    })

    it('reads a second Comments bullet after the first as additional context', () => {
        const doc = lines(['- [ ] Build the shed', '  - Comments', '    - level', '  - Comments', '    - again'].join('\n'))
        const task = readTaskStructure(doc, 0)!
        expect(task.commentsLine).toBe(1)
        expect(task.additionalContext).toEqual({ from: 3, to: 5 })
    })

    it('has no additional context when the Comments block is the last child, or there is none', () => {
        const last = lines(['- [ ] Build the shed', '  - measure', '  - Comments', '    - level', '- Kitchen'].join('\n'))
        expect(readTaskStructure(last, 0)!.additionalContext).toBeNull()
        const none = lines(['- [ ] Build the shed', '  - measure', '  - paint it'].join('\n'))
        expect(readTaskStructure(none, 0)!).toMatchObject({ description: { from: 1, to: 3 }, additionalContext: null })
    })

    it('reads lines after an empty Comments bullet as the additional context', () => {
        const doc = lines(['- [ ] Build the shed', '  - Comments', '  - paint it'].join('\n'))
        const task = readTaskStructure(doc, 0)!
        expect(task.comments).toEqual({ from: 2, to: 2 })
        expect(task.additionalContext).toEqual({ from: 2, to: 3 })
    })

    it('has an empty description and no comments for a task with nothing under it', () => {
        const task = readTaskStructure(['- [ ] Build the shed', '- Kitchen'], 0)!
        expect(task.description).toEqual({ from: 1, to: 1 })
        expect(task.comments).toBeNull()
        expect(task.end).toBe(1)
    })

    it('lists the assets the description and the comments show, once each, in the order written', () => {
        const doc = lines(
            [
                '- [ ] Build the shed',
                '  - ![plan](../assets/plan.png)',
                '  - see [the quote](../assets/quote.pdf) and ![plan](../assets/plan.png)',
                '  - Comments',
                '    - ![old](../assets/old.png)',
            ].join('\n'),
        )
        expect(readTaskStructure(doc, 0)!.assets).toEqual(['../assets/plan.png', '../assets/quote.pdf', '../assets/old.png'])
    })

    it('lists the assets the comments and the additional context show after those of the description', () => {
        const doc = lines(['- [ ] Build the shed', '  - ![plan](../assets/plan.png)', '  - Comments', '    - ![old](../assets/old.png)', '  - ![paint](../assets/paint.png)', '  - ![plan](../assets/plan.png)'].join('\n'))
        expect(readTaskStructure(doc, 0)!.assets).toEqual(['../assets/plan.png', '../assets/old.png', '../assets/paint.png'])
    })

    it('lists an asset on the task line itself first, and none in fenced code under it', () => {
        const doc = lines(['- [ ] Build the shed ![plan](../assets/plan.png)', '  - ```md', '    ![code](../assets/code.png)', '    ```', '  - ![paint](../assets/paint.png)'].join('\n'))
        expect(readTaskStructure(doc, 0)!.assets).toEqual(['../assets/plan.png', '../assets/paint.png'])
    })

    it('lists no asset written after the task, outside its nested lines', () => {
        const doc = lines(['- [ ] Build the shed', '  - Comments', '    - ![old](../assets/old.png)', '- ![other](../assets/other.png)'].join('\n'))
        expect(readTaskStructure(doc, 0)!.assets).toEqual(['../assets/old.png'])
    })
})

describe('taskTitle', () => {
    it('is the words without the tag run or the Free Tags', () => {
        expect(taskTitle('#P1 #bug Fix the gate #needs-oil')).toBe('Fix the gate')
    })
})

describe('taskLineWithTitle', () => {
    it('rewrites the words, keeping the tag run and writing the Free Tags after the title', () => {
        expect(taskLineWithTitle('  - [ ] #P1 #bug Fix the gate', 'Fix the big gate')).toBe('  - [ ] #P1 Fix the big gate #bug')
    })

    it('leaves a line whose title is already the one asked alone', () => {
        expect(taskLineWithTitle('- [ ] Fix #bug the gate', 'Fix the gate')).toBe('- [ ] Fix #bug the gate')
    })

    it('is null on a line that is no task', () => {
        expect(taskLineWithTitle('- water the beans', 'x')).toBeNull()
    })
})

describe('taskLineWithFreeTag', () => {
    it('adds a Free Tag at the end of the line', () => {
        expect(taskLineWithFreeTag('- [ ] #P1 Fix the gate ', 'needs-oil', true)).toBe('- [ ] #P1 Fix the gate #needs-oil')
    })

    it('adds nothing when the tag is there in any case', () => {
        expect(taskLineWithFreeTag('- [ ] Fix the gate #Bug', 'bug', true)).toBe('- [ ] Fix the gate #Bug')
    })

    it('removes every occurrence of a Free Tag, ignoring case, and closes up the words', () => {
        expect(taskLineWithFreeTag('- [ ] #P1 #bug Fix #BUG the gate #oil', 'bug', false)).toBe('- [ ] #P1 Fix the gate #oil')
    })
})

describe('newTaskLines', () => {
    it('writes the status and priority as the tag run, then the title and the Free Tags, then the description nested', () => {
        expect(
            newTaskLines({ status: 'waiting', priority: 2, title: 'Fix the gate', freeTags: ['bug'] }, '- measure it\n  - twice\n- ![plan](../assets/plan.png)'),
        ).toEqual(['- [ ] #P2 #W Fix the gate #bug', '  - measure it', '    - twice', '  - ![plan](../assets/plan.png)'])
    })

    it('writes the scheduled and due dates in the tag run, after the status and priority', () => {
        expect(newTaskLines({ status: 'waiting', priority: 1, title: 'Fix the gate', freeTags: [], due: '2026-11-09', scheduled: '2026-11-05' }, '')).toEqual([
            '- [ ] #P1 #W #S-2026-11-05 #D-2026-11-09 Fix the gate',
        ])
    })

    it('writes no date that is not a whole YYYY-MM-DD date', () => {
        expect(newTaskLines({ status: 'open', priority: null, title: 'Fix the gate', freeTags: [], due: '', scheduled: '2026-11' }, '')).toEqual(['- [ ] Fix the gate'])
    })

    it('writes a Done task ticked, and drops an empty description', () => {
        expect(newTaskLines({ status: 'done', priority: null, title: 'Fix the gate', freeTags: [] }, '- \n\n')).toEqual(['- [x] Fix the gate'])
    })
})

describe('asCommentBullet', () => {
    it('makes prose one bullet whose later lines continue it, and keeps bullets as written', () => {
        expect(asCommentBullet('Sent it\nby email')).toBe('- Sent it\n  by email')
        expect(asCommentBullet('- Attached the list\n  - v2')).toBe('- Attached the list\n  - v2')
    })
})

describe('commentChange', () => {
    it('appends a comment as the last child of the Comments block', () => {
        const text = ['- [ ] Build the shed', '  - measure', '  - Comments', '    - level', '- Kitchen'].join('\n')
        const change = commentChange(text, 0, '- ordered the timber')!
        const after = text.slice(0, change.from) + change.insert + text.slice(change.to)
        expect(after).toBe(['- [ ] Build the shed', '  - measure', '  - Comments', '    - level', '    - ordered the timber', '- Kitchen'].join('\n'))
        expect(change.line).toBe(4)
    })

    it('starts a Comments block as the last child of the task when there is none', () => {
        const text = ['- [[Garden]]', '  - [ ] Build the shed', '    - measure'].join('\n')
        const change = commentChange(text, 1, '- level\n  - checked twice')!
        const after = text.slice(0, change.from) + change.insert + text.slice(change.to)
        expect(after).toBe(['- [[Garden]]', '  - [ ] Build the shed', '    - measure', '    - Comments', '      - level', '        - checked twice'].join('\n'))
        expect(change.line).toBe(4)
    })

    it('appends a comment inside the Comments block, above the additional context after it', () => {
        const text = ['- [ ] Build the shed', '  - Comments', '    - level', '  - paint it', '- Kitchen'].join('\n')
        const change = commentChange(text, 0, '- ordered the timber')!
        const after = text.slice(0, change.from) + change.insert + text.slice(change.to)
        expect(after).toBe(['- [ ] Build the shed', '  - Comments', '    - level', '    - ordered the timber', '  - paint it', '- Kitchen'].join('\n'))
        expect(change.line).toBe(3)
    })

    it('is null when the line holds no task', () => {
        expect(commentChange('- Kitchen', 0, '- level')).toBeNull()
    })
})

describe('taskRemoval', () => {
    it('takes the task and everything nested under it out, with the line break before it', () => {
        const text = ['- [[Garden]]', '  - [ ] Build the shed', '    - measure', '- Kitchen'].join('\n')
        const removal = taskRemoval(text, 1)!
        expect(text.slice(0, removal.from) + text.slice(removal.to)).toBe(['- [[Garden]]', '- Kitchen'].join('\n'))
        expect(removal.removed).toBe('\n  - [ ] Build the shed\n    - measure')
    })

    it('takes the line break after a task on the first line', () => {
        const text = ['- [ ] Build the shed', '- Kitchen'].join('\n')
        const removal = taskRemoval(text, 0)!
        expect(text.slice(0, removal.from) + text.slice(removal.to)).toBe('- Kitchen')
    })
})

describe('taskComments', () => {
    it('reads each Task Comment as its words, with what is nested under it moved to the left margin', () => {
        const doc = lines(['- [ ] Build the shed', '  - Comments', '    - the floor is level', '    - ordered the timber', '      - oak', '- Kitchen'].join('\n'))
        expect(taskComments(doc, readTaskStructure(doc, 0)!)).toEqual(['the floor is level', 'ordered the timber\n  - oak'])
    })

    it('is empty for a task with no Comments bullet', () => {
        expect(taskComments(['- [ ] Build the shed'], readTaskStructure(['- [ ] Build the shed'], 0)!)).toEqual([])
    })
})
