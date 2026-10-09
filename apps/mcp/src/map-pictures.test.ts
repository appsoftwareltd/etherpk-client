import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { beforeAll, describe, expect, it } from 'vitest'

import { needsMaps, openMapRenderer, publishMapStyle } from './map-pictures'

// A Map Block published from the Headless Client is a picture drawn in a real Chromium by the
// Client's own drawing code (ADR 0118). The drawing half runs where this machine has a Chromium.

describe('which publishes draw maps', () => {
    it('is any whose pages hold a map fence, in prose or on a bullet', () => {
        expect(needsMaps(['Intro\n\n```map\nSeal Bay @ 50.7, -1.0\n```\n'])).toBe(true)
        expect(needsMaps(['- Trip\n  ```map\n  ```'])).toBe(true)
        expect(needsMaps(['- ```map\n  Seal Bay @ 50.7, -1.0\n  ```'])).toBe(true)
        expect(needsMaps(['```js\nconst map = 1\n```', 'A map of the world', '```mapping\n```'])).toBe(false)
    })
})

describe('the basemap a published map is drawn over', () => {
    it("is EtherPK's map host, or the style named, or none when named empty", () => {
        expect(publishMapStyle({})).toBe('https://maps.etherpk.com/styles/light.json')
        expect(publishMapStyle({ ETHERPK_MAP_STYLE_URL: ' https://tiles.example.com/light.json ' })).toBe('https://tiles.example.com/light.json')
        expect(publishMapStyle({ ETHERPK_MAP_STYLE_URL: '' })).toBeNull()
    })
})

/** A Chromium to draw with, when this machine has one: the named one, or a `chromium` on the PATH. */
function chromiumOnThisMachine(): string | null {
    const named = process.env.ETHERPK_CHROMIUM?.trim() || process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?.trim()
    if (named && existsSync(named)) return named
    try {
        const found = execSync('command -v chromium || command -v chromium-browser || command -v google-chrome', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
        return found && existsSync(found) ? found : null
    } catch {
        return null
    }
}

const chromium = chromiumOnThisMachine()

describe.skipIf(!chromium)('drawing a map picture in Chromium', () => {
    beforeAll(async () => {
        // The page bundle a publish serves is built with the package; built here for the test.
        const { build } = await import('vite')
        const root = join(dirname(fileURLToPath(import.meta.url)), '..')
        await build({ configFile: join(root, 'vite.map-page.config.ts'), root, logLevel: 'error' })
    }, 60_000)

    it('draws the places and routes of a Map Block as a WebP of the picture size', async () => {
        // No basemap: the test reaches no tile host.
        const renderer = await openMapRenderer({ ...process.env, ETHERPK_CHROMIUM: chromium!, ETHERPK_MAP_STYLE_URL: '' })
        expect(renderer).not.toBeNull()
        try {
            const picture = await renderer!.render('Seal Bay @ 50.74860, -1.07890\nCoast walk @ 50.6623, -1.5887 > 50.67, -1.55\n')
            expect(picture).toMatchObject({ type: 'image/webp', width: 800, height: 450 })
            // RIFF....WEBP
            expect(String.fromCharCode(...picture.bytes.slice(0, 4))).toBe('RIFF')
            expect(String.fromCharCode(...picture.bytes.slice(8, 12))).toBe('WEBP')
        } finally {
            await renderer!.dispose()
        }
    }, 60_000)
})
