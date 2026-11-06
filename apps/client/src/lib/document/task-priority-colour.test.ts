import { describe, expect, it } from 'vitest'

import { priorityColour } from './task-priority-colour'

describe('the colour of a task priority', () => {
    it('is a different pastel for each priority, the warmest for P1', () => {
        expect(priorityColour(1)).toBe('#fca5a5')
        expect(priorityColour(2)).toBe('#fdba74')
        expect(priorityColour(3)).toBe('#7dd3fc')
    })

    it('is nothing for no priority', () => {
        expect(priorityColour(null)).toBeNull()
    })
})
