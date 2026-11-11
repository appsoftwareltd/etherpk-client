import { describe, expect, it } from 'vitest'

import { defaultLayout } from '../layout/serialization'
import { welcomeFirstLayout } from './welcome-layout'
import { WELCOME_PAGE_TITLE } from './welcome-page'

const DAY = '2026-03-04'
const WELCOME = `document:${WELCOME_PAGE_TITLE}`
const JOURNAL = `document:${DAY}`

describe('the Layout a graph created empty opens with', () => {
    const fresh = () => defaultLayout({ journalTarget: DAY, rightSidebarCollapsed: false })

    it('keeps one Pane in the editor area: no split', () => {
        expect(welcomeFirstLayout(fresh(), { phone: false }).model.regions.main.panes).toHaveLength(1)
    })

    it("puts the Welcome page first and today's journal to its right, as tabs of that Pane", () => {
        const [pane] = welcomeFirstLayout(fresh(), { phone: false }).model.regions.main.panes
        expect(pane.views.map((instance) => instance.panelId)).toEqual([WELCOME, JOURNAL])
        expect(pane.views[0].view).toEqual({ kind: 'document', target: WELCOME_PAGE_TITLE })
    })

    it('has the Welcome page in front, with the keyboard', () => {
        const { model } = welcomeFirstLayout(fresh(), { phone: false })
        expect(model.regions.main.panes[0].activePanelId).toBe(WELCOME)
        expect(model.activePanelId).toBe(WELCOME)
    })

    it('leaves the Sidebars as a new graph has them on a desktop', () => {
        const { model } = welcomeFirstLayout(fresh(), { phone: false })
        expect(model.regions['left-sidebar']).toEqual(fresh().model.regions['left-sidebar'])
        expect(model.regions['right-sidebar']).toEqual(fresh().model.regions['right-sidebar'])
    })

    it('starts a phone with both drawers closed, so the page is what is shown', () => {
        const phone = defaultLayout({ journalTarget: DAY, rightSidebarCollapsed: true })
        const { model } = welcomeFirstLayout(phone, { phone: true })
        expect(model.regions['left-sidebar'].collapsed).toBe(true)
        expect(model.regions['right-sidebar'].collapsed).toBe(true)
        expect(model.activePanelId).toBe(WELCOME)
    })

    it('does not change the Layout it was given', () => {
        const given = fresh()
        welcomeFirstLayout(given, { phone: true })
        expect(given).toEqual(fresh())
    })
})
