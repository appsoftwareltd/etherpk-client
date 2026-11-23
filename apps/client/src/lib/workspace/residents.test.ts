import { describe, expect, it, vi } from 'vitest'

import type { LayoutController, Region, ViewRef } from '#lib/layout/index.js'

import { revealResident, toggleResidentSidebar } from './residents'

const backlinks: ViewRef = { kind: 'backlinks', target: '2026-09-18' }
const resident = { kind: 'backlinks', fallback: () => backlinks }

function controllerWith(open: ViewRef | undefined, region: Region = 'right-sidebar') {
    return {
        findView: vi.fn((kind: string) => (open?.kind === kind ? open : undefined)),
        openView: vi.fn(() => ({ region })),
        toggleSidebar: vi.fn(),
    } as unknown as LayoutController & { openView: ReturnType<typeof vi.fn>; toggleSidebar: ReturnType<typeof vi.fn> }
}

const tasks: ViewRef = { kind: 'tasks', target: 'tasks' }
const tasksResident = { kind: 'tasks', fallback: () => tasks }

describe('toggleResidentSidebar', () => {
    it('restores the first resident when none is open, and expands the Sidebar', () => {
        const controller = controllerWith(undefined)
        expect(toggleResidentSidebar(controller, 'right', [resident, tasksResident])).toBe('restored')
        expect(controller.openView).toHaveBeenCalledWith(backlinks)
        expect(controller.toggleSidebar).toHaveBeenCalledWith('right', true)
    })

    it('toggles the Sidebar when its resident is open, whatever target it was opened on', () => {
        const controller = controllerWith({ kind: 'backlinks', target: 'Physics' })
        expect(toggleResidentSidebar(controller, 'right', [resident, tasksResident])).toBe('toggled')
        expect(controller.openView).not.toHaveBeenCalled()
        expect(controller.toggleSidebar).toHaveBeenCalledWith('right')
    })

    it('toggles, not restores, when another resident of the Sidebar is still there', () => {
        // Backlinks hidden, Tasks present: Alt+R collapses or expands; Alt+B is what brings
        // Backlinks back. A toggle that opened a View nobody asked for would not be a toggle.
        const controller = controllerWith(tasks)
        expect(toggleResidentSidebar(controller, 'right', [resident, tasksResident])).toBe('toggled')
        expect(controller.openView).not.toHaveBeenCalled()
    })

    it('toggles a Sidebar that has no residents', () => {
        const controller = controllerWith(undefined)
        expect(toggleResidentSidebar(controller, 'left', [])).toBe('toggled')
        expect(controller.toggleSidebar).toHaveBeenCalledWith('left')
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

    it('reopens a hidden resident under its fallback identity', () => {
        const controller = controllerWith(undefined)
        revealResident(controller, resident)
        expect(controller.openView).toHaveBeenCalledWith(backlinks)
        expect(controller.toggleSidebar).toHaveBeenCalledWith('right', true)
    })

    it('expands the Sidebar the View is in, which the person may have changed', () => {
        const controller = controllerWith(backlinks, 'left-sidebar')
        revealResident(controller, resident)
        expect(controller.toggleSidebar).toHaveBeenCalledWith('left', true)
    })

    it('never collapses: revealing an open resident in an open Sidebar leaves it open', () => {
        const controller = controllerWith(backlinks)
        revealResident(controller, resident)
        expect(controller.toggleSidebar).not.toHaveBeenCalledWith('right')
        expect(controller.toggleSidebar).toHaveBeenCalledWith('right', true)
    })

    it('expands nothing for a View the person keeps in the editor area', () => {
        const controller = controllerWith(backlinks, 'main')
        revealResident(controller, resident)
        expect(controller.toggleSidebar).not.toHaveBeenCalled()
    })
})
