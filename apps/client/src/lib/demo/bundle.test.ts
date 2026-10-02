import { createHash } from 'node:crypto'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { DEMO_BUNDLE_DIRECTORY, readDemoBundle } from '../../../demo-graph-plugin'
import { onDiskName } from '../document/wikilink/derive'
import { wikilinkOccurrencesInSource } from '../document/wikilink/source'
import { parseFrontmatter } from '../storage/fs/frontmatter'
import { aliasesOf, conceptKey, conceptOf, fileStem } from '../storage/fs/identity'
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

    /** Each page's file name, its title and its aliases, read the way the scan reads them. */
    async function bundlePages() {
        const sources = await readDemoBundle(resolve(__dirname, '../../..', DEMO_BUNDLE_DIRECTORY))
        const decoder = new TextDecoder()
        return sources
            .filter((source) => source.path.startsWith('pages/'))
            .map((source) => {
                const text = decoder.decode(source.bytes)
                const fileName = source.path.slice('pages/'.length)
                const frontmatter = parseFrontmatter(text)
                return { fileName, text, title: conceptOf(frontmatter, fileStem(fileName)), aliases: aliasesOf(frontmatter) }
            })
    }

    it('gives every name to one page only, so no link is ambiguous', async () => {
        // Concept names are case-insensitive, so `Peace lily` as an alias would shadow the
        // `Peace Lily` page. With a couple of hundred pages this is easy to do by accident.
        const claims = new Map<string, string[]>()
        for (const page of await bundlePages()) {
            for (const name of [page.title, ...page.aliases]) {
                const key = conceptKey(name)
                claims.set(key, [...(claims.get(key) ?? []), page.fileName])
            }
        }
        const claimedTwice = [...claims].filter(([, files]) => files.length > 1)
        expect(claimedTwice).toEqual([])
    })

    it('names every page file after its title', async () => {
        const misnamed = (await bundlePages())
            .filter((page) => page.fileName !== `${onDiskName(page.title)}.md`)
            .map((page) => `${page.fileName} has the title ${page.title}`)
        expect(misnamed).toEqual([])
    })

    it('indexes a couple of hundred species under the Plant Index, and every one of them has a page', async () => {
        // The index is two levels deep on purpose: one page linking every species becomes a
        // hub that drags the whole Graph View into a single disc around it. The Plant Index
        // links a page per group (`[[Plant Index]] Herbs`), and each group lists its species.
        const pages = await bundlePages()
        const names = new Set(pages.flatMap((page) => [page.title, ...page.aliases].map(conceptKey)))
        const index = pages.find((page) => page.title === 'Plant Index')
        const groups = pages.filter((page) => page.title.startsWith('[[Plant Index]] '))
        expect(index).toBeDefined()
        expect(groups.length).toBeGreaterThan(1)

        const linksOf = (text: string) => wikilinkOccurrencesInSource(text).map((link) => link.concept)
        const linked = [index, ...groups].flatMap((page) => linksOf(page?.text ?? ''))
        expect(linked.filter((concept) => !names.has(conceptKey(concept)))).toEqual([])
        // Every group the index names is one of the group pages, so no species is left out.
        const groupTitles = groups.map((group) => conceptKey(group.title)).sort()
        expect(linksOf(index?.text ?? '').map(conceptKey).filter((concept) => concept.startsWith('[[plant index]] ')).sort()).toEqual(groupTitles)

        const species = new Set(groups.flatMap((group) => linksOf(group.text).map(conceptKey)))
        species.delete(conceptKey('Plant Index'))
        expect(species.size).toBeGreaterThanOrEqual(200)
    })
})
