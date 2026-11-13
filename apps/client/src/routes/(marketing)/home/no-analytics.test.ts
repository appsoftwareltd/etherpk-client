import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The Client loads no analytics tracker. The home page it shares with other apps can report a
 * click on one of its buttons to whoever renders it, through `onAction`; the Client passes nothing
 * there. Its usage statistics (`#lib/telemetry`, ADR 0187) are a request the Client makes itself,
 * with a fixed set of fields, and only from the app's own pages: no third-party script is loaded,
 * and the public pages report nothing.
 */
describe('the Client home page', () => {
    const source = (path: string) => fileURLToPath(new URL(path, import.meta.url))

    it('gives the shared home page nothing to report clicks to', () => {
        const page = readFileSync(source('./+page.svelte'), 'utf8')
        expect(page).toContain('<MarketingHomePage')
        expect(page).not.toMatch(/onAction/)
    })

    it('loads no analytics tracker script anywhere in the Client', () => {
        const root = source('../../../')
        const files = readdirSync(root, { recursive: true, withFileTypes: true })
            .filter((entry) => entry.isFile() && /\.(svelte|ts|js|html)$/.test(entry.name) && !/\.test\.ts$/.test(entry.name))
            .map((entry) => join(entry.parentPath, entry.name))
        expect(files.length).toBeGreaterThan(100)
        const naming = files
            .filter((file) => /telemetry\.js|trackEvent|data-website-id|umami\.track/i.test(readFileSync(file, 'utf8')))
            .map((file) => relative(root, file))
        expect(naming).toEqual([])
    })

    it('reports usage statistics from the app only, never from the public pages', () => {
        const root = source('../')
        const naming = readdirSync(root, { recursive: true, withFileTypes: true })
            .filter((entry) => entry.isFile() && /\.(svelte|ts)$/.test(entry.name) && !/\.test\.ts$/.test(entry.name))
            .map((entry) => join(entry.parentPath, entry.name))
            .filter((file) => /#lib\/telemetry/.test(readFileSync(file, 'utf8')))
            .map((file) => relative(root, file))
        expect(naming).toEqual([])
    })
})
