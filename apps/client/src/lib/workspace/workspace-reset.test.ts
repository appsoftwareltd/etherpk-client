import { describe, expect, it } from 'vitest'

import { BACKLINKS_PREFERENCES_KEY_PREFIX } from '$lib/document/backlinks-preferences'
import { RECENTS_KEY_PREFIX } from '$lib/navigation/recents'

import { forgetWorkspaceCompanions, workspaceResetKeys } from './workspace-reset'

function memoryStorage(entries: Record<string, string>): Storage {
    const map = new Map(Object.entries(entries))
    return {
        get length() {
            return map.size
        },
        key: (i) => [...map.keys()][i] ?? null,
        getItem: (k) => map.get(k) ?? null,
        setItem: (k, v) => void map.set(k, v),
        removeItem: (k) => void map.delete(k),
        clear: () => map.clear(),
    }
}

describe('forgetWorkspaceCompanions', () => {
    it('forgets reading positions and the Tasks filter for THIS graph only', () => {
        const storage = memoryStorage({
            'etherpk-positions:g1': '{}',
            'etherpk-task-filter:g1': '{}',
            'etherpk-positions:g2': '{}',
        })
        forgetWorkspaceCompanions('g1', storage)
        expect(workspaceResetKeys('g1')).toEqual(['etherpk-positions:g1', 'etherpk-task-filter:g1'])
        for (const key of workspaceResetKeys('g1')) expect(storage.getItem(key)).toBeNull()
        expect(storage.getItem('etherpk-positions:g2')).toBe('{}')
    })

    it('keeps the Backlinks preferences: Highlight reference and the fold are choices, not arrangement', () => {
        // The pin is never stored. It goes with the store the reset recreates.
        const stored = JSON.stringify({ version: 1, preferences: { highlight: true, collapsedBelowDocuments: true } })
        const storage = memoryStorage({ [`${BACKLINKS_PREFERENCES_KEY_PREFIX}g1`]: stored })
        forgetWorkspaceCompanions('g1', storage)
        expect(storage.getItem(`${BACKLINKS_PREFERENCES_KEY_PREFIX}g1`)).toBe(stored)
    })

    it('leaves Recents alone: activity is not arrangement', () => {
        const storage = memoryStorage({ [`${RECENTS_KEY_PREFIX}g1`]: '[]' })
        forgetWorkspaceCompanions('g1', storage)
        expect(storage.getItem(`${RECENTS_KEY_PREFIX}g1`)).toBe('[]')
    })

    it('is a no-op without Storage', () => {
        expect(() => forgetWorkspaceCompanions('g1', undefined)).not.toThrow()
    })
})
