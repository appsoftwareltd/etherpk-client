import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { filesUnder, servePage } from './page-server'

describe('the page server', () => {
    let folder: string
    let served: { server: Server; origin: string }

    beforeAll(async () => {
        folder = mkdtempSync(join(tmpdir(), 'page-server-'))
        writeFileSync(join(folder, 'draw.js'), 'export {}')
        writeFileSync(join(folder, 'font.woff2'), 'font')
        served = await servePage('<!doctype html>', await filesUnder(folder))
    })

    afterAll(async () => {
        await new Promise((resolve) => served.server.close(resolve))
        rmSync(folder, { recursive: true, force: true })
    })

    it('listens on the loopback address alone', () => {
        expect(served.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    })

    it('answers the page and its files, each with its type', async () => {
        const page = await fetch(`${served.origin}/page.html`)
        expect(page.headers.get('content-type')).toContain('text/html')
        expect(await page.text()).toBe('<!doctype html>')
        expect((await fetch(`${served.origin}/draw.js`)).headers.get('content-type')).toContain('text/javascript')
        expect((await fetch(`${served.origin}/font.woff2`)).headers.get('content-type')).toBe('font/woff2')
    })

    it('answers nothing else', async () => {
        expect((await fetch(`${served.origin}/other.js`)).status).toBe(404)
        expect((await fetch(`${served.origin}/..%2f..%2fetc%2fpasswd`)).status).toBe(404)
    })
})
