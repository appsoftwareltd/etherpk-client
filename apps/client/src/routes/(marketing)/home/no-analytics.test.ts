import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The Client sends no analytics. The home page it shares with other apps can report a click on
 * one of its buttons to whoever renders it, through `onAction`; the Client passes nothing there,
 * and no file of the Client names an analytics tracker.
 */
describe('the Client home page', () => {
    const source = (path: string) => fileURLToPath(new URL(path, import.meta.url))

    it('gives the shared home page nothing to report clicks to', () => {
        const page = readFileSync(source('./+page.svelte'), 'utf8')
        expect(page).toContain('<MarketingHomePage')
        expect(page).not.toMatch(/onAction/)
    })

    it('has no analytics tracker anywhere in the Client', () => {
        const root = source('../../../')
        const files = readdirSync(root, { recursive: true, withFileTypes: true })
            .filter((entry) => entry.isFile() && /\.(svelte|ts|js|html)$/.test(entry.name) && !/\.test\.ts$/.test(entry.name))
            .map((entry) => join(entry.parentPath, entry.name))
        expect(files.length).toBeGreaterThan(100)
        const naming = files
            .filter((file) => /umami|telemetry\.js|trackEvent/i.test(readFileSync(file, 'utf8')))
            .map((file) => relative(root, file))
        expect(naming).toEqual([])
    })
})
