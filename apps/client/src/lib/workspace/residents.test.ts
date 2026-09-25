import { describe, expect, it, vi } from 'vitest'

import type { LayoutController, ViewRef } from '$lib/layout'

import { revealResident, toggleResidentSidebar } from './residents'

const backlinks: ViewRef = { kind: 'backlinks', target: '2026-09-18' }
const resident = { kind: 'backlinks', side: 'right' as const, fallback: () => backlinks }

function controllerWith(open: ViewRef | undefined) {
    return {
        findView: vi.fn((kind: string) => (open?.kind === kind ? open : undefined)),
        openView: vi.fn(),
        toggleSidebar: vi.fn(),
    } as unknown as LayoutController & { openView: ReturnType<typeof vi.fn>; toggleSidebar: ReturnType<typeof vi.fn> }
}

const tasks: ViewRef = { kind: 'tasks', target: 'tasks' }
const tasksResident = { kind: 'tasks', side: 'right' as const, fallback: () => tasks }

describe('toggleResidentSidebar', () => {
    it('restores the first resident into an EMPTY Sidebar and expands it', () => {
        const controller = controllerWith(undefined)
        expect(toggleResidentSidebar(controller, [resident, tasksResident])).toBe('restored')
        expect(controller.openView).toHaveBeenCalledWith(backlinks)
        expect(controller.toggleSidebar).toHaveBeenCalledWith('right', true)
    })

    it('toggles the Sidebar when its resident is open, whatever target it was opened on', () => {
        const controller = controllerWith({ kind: 'backlinks', target: 'Physics' })
        expect(toggleResidentSidebar(controller, [resident, tasksResident])).toBe('toggled')
        expect(controller.openView).not.toHaveBeenCalled()
        expect(controller.toggleSidebar).toHaveBeenCalledWith('right')
    })

    it('toggles, not restores, when another resident of the Sidebar is still there', () => {
        // Backlinks closed, Tasks present: Alt+R collapses or expands; Alt+B is what brings
        // Backlinks back. A toggle that opened a tab nobody asked for would not be a toggle.
        const controller = controllerWith(tasks)
        expect(toggleResidentSidebar(controller, [resident, tasksResident])).toBe('toggled')
        expect(controller.openView).not.toHaveBeenCalled()
    })
})

describe('revealResident', () => {
    it('focuses the open resident under the identity it is open as, and expands its Sidebar', () => {
        // Backlinks is keyed by the document it opened on; focusing it must use THAT key, or a
        // second Backlinks View would open beside the first.
        const openAs: ViewRef = { kind: 'backlinks', target: 'Physics' }
        const controller = controllerWith(openAs)
        revealResident(controller, resident)
        expect(controller.openView).toHaveBeenCalledWith(openAs)
        expect(controller.toggleSidebar).toHaveBeenCalledWith('right', true)
    })

    it('reopens a closed resident under its fallback identity', () => {
        const controller = controllerWith(undefined)
        revealResident(controller, resident)
        expect(controller.openView).toHaveBeenCalledWith(backlinks)
        expect(controller.toggleSidebar).toHaveBeenCalledWith('right', true)
    })

    it('never collapses: revealing an open resident in an open Sidebar leaves it open', () => {
        const controller = controllerWith(backlinks)
        revealResident(controller, resident)
        expect(controller.toggleSidebar).not.toHaveBeenCalledWith('right')
        expect(controller.toggleSidebar).toHaveBeenCalledWith('right', true)
    })
})
