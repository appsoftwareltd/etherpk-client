import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * How a phone's soft keyboard meets the page, as the page asks for it ([[Dual Mode Editor]] →
 * Riding above the soft keyboard). The browsers that can are told to resize the page, so the
 * workspace gets shorter in step with the keyboard and the browser has no reason to move the page
 * under it. A workspace also stops the document behind it from scrolling.
 */

const here = dirname(fileURLToPath(import.meta.url))
const html = readFileSync(join(here, 'app.html'), 'utf8')
const css = readFileSync(join(here, 'app.css'), 'utf8')

describe("the page's viewport", () => {
    const tag = /<meta name="viewport" content="([^"]*)"/.exec(html)?.[1] ?? ''
    const settings = tag.split(',').map((each) => each.trim())

    it('asks the keyboard to resize the page: add interactive-widget=resizes-content to the viewport tag in app.html', () => {
        expect(settings).toContain('interactive-widget=resizes-content')
    })

    it('is the width of the device, and a person can still zoom it', () => {
        expect(settings).toContain('width=device-width')
        expect(settings).toContain('initial-scale=1')
        expect(tag).not.toMatch(/user-scalable|maximum-scale/)
    })
})

describe('the document behind a workspace', () => {
    it('is as tall as the part of the screen the browser leaves, not the screen with its bars hidden: use 100dvh after 100vh', () => {
        const body = /\nbody\s*\{([^}]*)\}/.exec(css)?.[1] ?? ''
        expect(body).toMatch(/min-height:\s*100vh;\s*min-height:\s*100dvh;/)
    })

    it('does not scroll on a phone while a workspace fills the window', () => {
        expect(css).toMatch(/html:has\(\.workspace-host\)\s*\{[^}]*overflow:\s*hidden/)
    })
})
