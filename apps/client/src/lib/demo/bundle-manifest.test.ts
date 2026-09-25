import { describe, expect, it } from 'vitest'

import { DEMO_BUNDLE_BUDGET_BYTES, DemoBundleError, buildDemoBundleManifest, type BundleSource } from './bundle-manifest'

const encoder = new TextEncoder()
const text = (path: string, body: string): BundleSource => ({ path, bytes: encoder.encode(body) })
const bin = (path: string, ...bytes: number[]): BundleSource => ({ path, bytes: new Uint8Array(bytes) })
/** A stand-in hash: eight hex digits from the byte count, enough to tell files apart. */
const hash = (bytes: Uint8Array) => bytes.byteLength.toString(16).padStart(8, '0')

const sidecar = text('demo.json', JSON.stringify({ name: 'Plants', anchor: '2026-09-15' }))

function problemsOf(sources: BundleSource[]): string[] {
    try {
        buildDemoBundleManifest(sources, hash)
    } catch (error) {
        if (error instanceof DemoBundleError) return error.problems
        throw error
    }
    return []
}

describe('buildDemoBundleManifest', () => {
    it('lists every content file with its size, sorted, and carries the sidecar', () => {
        const manifest = buildDemoBundleManifest(
            [
                sidecar,
                text('pages/Plant.md', '# Plant\n\n![Leaf](../assets/leaf.00000003.png)'),
                text('journals/2026-09-15.md', '# 2026-09-15'),
                bin('assets/leaf.00000003.png', 1, 2, 3),
                text('etherpk/settings.json', '{}'),
            ],
            hash,
        )
        expect(manifest.name).toBe('Plants')
        expect(manifest.anchor).toBe('2026-09-15')
        expect(manifest.windowDays).toBe(60)
        expect(manifest.files.map((f) => f.path)).toEqual([
            'assets/leaf.00000003.png',
            'etherpk/settings.json',
            'journals/2026-09-15.md',
            'pages/Plant.md',
        ])
        expect(manifest.files.find((f) => f.path === 'assets/leaf.00000003.png')?.size).toBe(3)
        expect(manifest.totalBytes).toBe(manifest.files.reduce((sum, f) => sum + f.size, 0))
    })

    it('honours an explicit window', () => {
        const manifest = buildDemoBundleManifest(
            [text('demo.json', JSON.stringify({ name: 'Plants', anchor: '2026-09-15', windowDays: 10 }))],
            hash,
        )
        expect(manifest.windowDays).toBe(10)
    })

    it('refuses a missing or malformed sidecar', () => {
        expect(problemsOf([])).toEqual(['demo.json is missing'])
        expect(problemsOf([text('demo.json', '{')])).toEqual(['demo.json is not JSON'])
        expect(problemsOf([text('demo.json', JSON.stringify({ name: ' ', anchor: '2026-02-30', windowDays: -1 }))])).toEqual([
            'demo.json needs a non-empty "name"',
            'demo.json needs an "anchor" day as YYYY-MM-DD',
            'demo.json "windowDays" must be a whole number of days',
        ])
    })

    it('refuses files outside the four content folders or nested below them', () => {
        expect(problemsOf([sidecar, text('README.md', 'x'), text('pages/deep/Plant.md', 'x'), text('notes/Plant.md', 'x')])).toEqual([
            'README.md: files live directly under journals/, pages/, assets/ or etherpk/',
            'pages/deep/Plant.md: files live directly under journals/, pages/, assets/ or etherpk/',
            'notes/Plant.md: files live directly under journals/, pages/, assets/ or etherpk/',
        ])
    })

    it('insists journals are days and pages are markdown', () => {
        expect(problemsOf([sidecar, text('journals/today.md', 'x'), text('pages/Plant.txt', 'x')])).toEqual([
            'journals/today.md: a journal entry is named by its day, YYYY-MM-DD.md',
            'pages/Plant.txt: a page is a .md file',
        ])
    })

    it('insists every asset carries the content hash the store would give it', () => {
        expect(problemsOf([sidecar, bin('assets/leaf.png', 1), bin('assets/leaf.deadbeef.png', 1)])).toEqual([
            'assets/leaf.png: an asset is named <kebab-stem>.<8-hex-content-hash>.<ext>',
            "assets/leaf.deadbeef.png: the name's hash does not match the file's content (00000001)",
        ])
    })

    it('catches a reference to an asset that is not in the bundle', () => {
        expect(problemsOf([sidecar, text('pages/Plant.md', '![a](../assets/leaf.00000001.png) [sheet](../assets/care%20sheet.00000002.pdf)')])).toEqual([
            'pages/Plant.md: references ../assets/leaf.00000001.png, which is not in the bundle',
            'pages/Plant.md: references ../assets/care sheet.00000002.pdf, which is not in the bundle',
        ])
    })

    it('enforces the size budget', () => {
        const big = { path: 'assets/big.00000000.bin', bytes: new Uint8Array(DEMO_BUNDLE_BUDGET_BYTES + 1) }
        const problems = problemsOf([sidecar, { ...big, bytes: big.bytes }])
        expect(problems.some((p) => p.includes('the budget is'))).toBe(true)
    })
})
