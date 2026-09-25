import { createHash } from 'node:crypto'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { DEMO_BUNDLE_DIRECTORY, readDemoBundle } from '../../../demo-graph-plugin'
import { buildDemoBundleManifest } from './bundle-manifest'
import { daysBetween } from './date-shift'

/**
 * The committed bundle itself, checked the way the build checks it: every asset reference
 * resolves, every asset name carries its content hash, journals are days, and the whole
 * thing fits the budget. A content edit that breaks a rule fails here before it fails
 * `vite build`.
 */
describe('the shipped demo bundle', () => {
    const assetHash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex').slice(0, 8)

    it('is valid', async () => {
        const sources = await readDemoBundle(resolve(__dirname, '../../..', DEMO_BUNDLE_DIRECTORY))
        const manifest = buildDemoBundleManifest(sources, assetHash)
        expect(manifest.files.length).toBeGreaterThan(10)
        expect(manifest.files.some((f) => f.path === 'pages/Welcome to EtherPK.md')).toBe(true)
        expect(manifest.files.some((f) => f.path === `journals/${manifest.anchor}.md`)).toBe(true)
    })

    it('keeps every demo-time date inside the shift window, so nothing goes stale', async () => {
        const sources = await readDemoBundle(resolve(__dirname, '../../..', DEMO_BUNDLE_DIRECTORY))
        const manifest = buildDemoBundleManifest(sources, assetHash)
        const decoder = new TextDecoder()
        const outside: string[] = []
        for (const source of sources) {
            if (!source.path.endsWith('.md')) continue
            for (const match of decoder.decode(source.bytes).matchAll(/(?<!\d)\d{4}-\d{2}-\d{2}(?!\d)/g)) {
                const distance = daysBetween(manifest.anchor, match[0])
                // A four-digit year below 1900 is history and is meant to stay put.
                if (distance !== null && Math.abs(distance) > manifest.windowDays && match[0] >= '1900') {
                    outside.push(`${source.path}: ${match[0]}`)
                }
            }
        }
        expect(outside).toEqual([])
    })
})
