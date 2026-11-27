import { describe, expect, it } from 'vitest'

import { createDialogStack } from '@appsoftwareltd/etherpk-shared/ui'
import { createFakeHistory } from './testing/fake-overlay-history'

// A Dismissable Overlay (CONTEXT.md) holds one history entry while it is open: Back closes it and
// goes nowhere else, and once it has closed Back and Forward walk the Visits as if it never opened.

describe('the history entry of a Dismissable Overlay', () => {
    it('closes Search on Back and leaves the page in front where it was', async () => {
        const world = createFakeHistory(createDialogStack())
        world.visit('Garden')
        const search = world.openOverlay('search')
        await world.settle()
        await world.userBack()
        expect(search.isOpen()).toBe(false)
        expect(world.front().visit).toBe('Garden')
        // The next Back walks the Visits.
        await world.userBack()
        expect(world.front().visit).toBe('start')
    })

    it('takes its entry away when it is closed another way, so Back walks the Visits', async () => {
        const world = createFakeHistory(createDialogStack())
        world.visit('Garden')
        const search = world.openOverlay('search')
        await world.settle()
        search.closeOtherWay()
        await world.settle()
        // Gone from the front. A browser keeps it as a Forward entry, which Forward passes over.
        expect(world.front()).toEqual({ visit: 'Garden', overlay: false })
        await world.userBack()
        expect(world.front().visit).toBe('start')
    })

    it('lets a page opened from Search be left by Back for the page before, not for Search', async () => {
        const world = createFakeHistory(createDialogStack())
        world.visit('Garden')
        const search = world.openOverlay('search')
        await world.settle()
        // Search closes first and then opens the page it found (SearchModal's `choose`).
        search.closeOtherWay()
        world.visit('Kitchen')
        await world.settle()
        await world.userBack()
        expect(world.front().visit).toBe('Garden')
        expect(world.openCount()).toBe(0)
    })

    it('lets a page opened from a phone drawer take the drawer’s entry, since the drawer closes after the page opens', async () => {
        const world = createFakeHistory(createDialogStack())
        world.visit('Garden')
        const drawer = world.openOverlay('drawer')
        await world.settle()
        world.visit('Kitchen')
        drawer.closeOtherWay()
        await world.settle()
        expect(world.entries().map((entry) => entry.visit)).toEqual(['start', 'Garden', 'Kitchen'])
        await world.userBack()
        expect(world.front().visit).toBe('Garden')
    })

    it('does nothing on Forward once Back has closed it', async () => {
        const world = createFakeHistory(createDialogStack())
        world.visit('Garden')
        world.openOverlay('search')
        await world.settle()
        await world.userBack()
        await world.userForward()
        expect(world.front().visit).toBe('Garden')
        expect(world.front().overlay).toBe(false)
        expect(world.openCount()).toBe(0)
    })

    it('closes one overlay for each Back, the one on top first', async () => {
        const world = createFakeHistory(createDialogStack())
        world.visit('Garden')
        const drawer = world.openOverlay('drawer')
        await world.settle()
        const search = world.openOverlay('search')
        await world.settle()
        await world.userBack()
        expect([drawer.isOpen(), search.isOpen()]).toEqual([true, false])
        await world.userBack()
        expect(drawer.isOpen()).toBe(false)
        expect(world.front().visit).toBe('Garden')
    })

    it('keeps a dialog that must be answered open on Back, and stays on the page', async () => {
        const world = createFakeHistory(createDialogStack())
        world.visit('Garden')
        const prompt = world.openOverlay('prompt', { refuses: true })
        await world.settle()
        await world.userBack()
        await world.userBack()
        expect(prompt.isOpen()).toBe(true)
        expect(world.front().visit).toBe('Garden')
        // Answered, it leaves no entry behind.
        prompt.closeOtherWay()
        await world.settle()
        await world.userBack()
        expect(world.front().visit).toBe('start')
    })

    it('leaves Back to a dialog that keeps an entry of its own, such as Settings', async () => {
        const world = createFakeHistory(createDialogStack())
        world.visit('Garden')
        world.openOverlay('settings', { ownEntry: true })
        await world.settle()
        expect(world.entries()).toHaveLength(2)
    })

    it('leaves the page that a confirmed delete closed under a dialog, rather than going back to it', async () => {
        const world = createFakeHistory(createDialogStack())
        world.visit('Physics')
        const confirm = world.openOverlay('confirm')
        await world.settle()
        // The page is deleted and its tab closes: the entry in front is replaced, marker and all.
        world.replace('Garden')
        await world.settle()
        confirm.closeOtherWay()
        await world.settle()
        expect(world.front()).toEqual({ visit: 'Garden', overlay: false })
        expect(world.shown()).toBe('Garden')
        // Back goes to the page that was deleted, as a Visit before it does.
        await world.userBack()
        expect(world.front().visit).toBe('Physics')
    })

    it('leaves a page opened as its dialog closed, rather than showing the page under the dialog again', async () => {
        const world = createFakeHistory(createDialogStack())
        world.visit('Board')
        const editor = world.openOverlay('task editor')
        await world.settle()
        // Open in tab: the dialog closes, then the task's tab opens.
        editor.closeOtherWay()
        world.visit('Shed')
        await world.settle()
        expect(world.shown()).toBe('Shed')
        expect(world.front()).toEqual({ visit: 'Shed', overlay: false })
        await world.userBack()
        expect(world.front().visit).toBe('Board')
    })

    it('moves no history entry once a load of another document has begun, which would cancel it', async () => {
        const world = createFakeHistory(createDialogStack())
        world.visit('Graphs')
        const dialog = world.openOverlay('import')
        await world.settle()
        // Sign in: the dialog closes as the browser starts to load the sign-in page.
        world.leave()
        dialog.closeOtherWay()
        await world.settle()
        expect(world.movedWhileLeaving()).toBe(false)
    })

    // Known gap. The page in front replaced while an overlay stays open over it (another device
    // deletes the page under Search) leaves the entry under the overlay's showing the page as it
    // was. Back then closes the overlay and shows that, since the page follows the entry it lands
    // on before this module can rewrite it.
    it.fails('keeps the page replaced under an open overlay when Back closes the overlay', async () => {
        const world = createFakeHistory(createDialogStack())
        world.visit('Physics')
        world.openOverlay('search')
        await world.settle()
        world.replace('Garden')
        await world.userBack()
        expect(world.shown()).toBe('Garden')
    })

    // Known gap. Forward onto Settings's entry pressed in the moment between an overlay opening and
    // its entry being written leaves Settings's entry under the overlay's, and Back later opens
    // Settings again instead of closing the overlay. Two presses inside a few milliseconds.
    it.fails('closes the overlay on Back after Forward raced its entry onto Settings', async () => {
        const stack = createDialogStack()
        const world = createFakeHistory(stack)
        world.openSettings()
        await world.userBack()
        const drawer = world.openOverlay('drawer')
        world.pressForward()
        world.closeSettings()
        await world.userBack()
        expect(drawer.isOpen()).toBe(false)
        expect(world.settingsOpen()).toBe(false)
    })
})
