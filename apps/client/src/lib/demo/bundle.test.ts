import { createHash } from 'node:crypto'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { DEMO_BUNDLE_DIRECTORY, readDemoBundle } from '../../../demo-graph-plugin'
import { deriveDoc } from '../document/index-derive'
import { readMapBody } from '../document/map-text'
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

    /** Every markdown document in the bundle, journals and pages, by its path. */
    async function bundleDocuments() {
        const sources = await readDemoBundle(resolve(__dirname, '../../..', DEMO_BUNDLE_DIRECTORY))
        const decoder = new TextDecoder()
        return sources.filter((source) => source.path.endsWith('.md')).map((source) => ({ path: source.path, text: decoder.decode(source.bytes) }))
    }

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

    /** The page of every species the Plant Index's groups list. */
    async function speciesPages() {
        const pages = await bundlePages()
        const byName = new Map(pages.flatMap((page) => [page.title, ...page.aliases].map((name) => [conceptKey(name), page] as const)))
        const groups = pages.filter((page) => page.title.startsWith('[[Plant Index]] '))
        const keys = new Set(groups.flatMap((group) => wikilinkOccurrencesInSource(group.text).map((link) => conceptKey(link.concept))))
        keys.delete(conceptKey('Plant Index'))
        return [...keys].flatMap((key) => byName.get(key) ?? [])
    }

    it('maps where every species grows wild, in one to five places, as the first map on its page', async () => {
        // The demo's showcase for the Map View: one pin per region, shared by every species
        // native there, so the whole graph's map gathers them into one list per region.
        const wrong = (await speciesPages()).flatMap((page) => {
            const items = deriveDoc(page.text).mapItems
            if (items.length === 0) return [`${page.title} has no map`]
            const first = items.filter((item) => item.fenceLine === Math.min(...items.map((i) => i.fenceLine)))
            if (first.some((item) => item.kind !== 'place')) return [`${page.title} has a route in its native range`]
            return first.length > 5 ? [`${page.title} has ${first.length} places`] : []
        })
        expect(wrong).toEqual([])
    })

    it("shows a map in today's journal, first in its Maps section", async () => {
        // Today's journal is the first page a visitor sees, so a map there shows maps before
        // anyone goes looking for them.
        const sources = await readDemoBundle(resolve(__dirname, '../../..', DEMO_BUNDLE_DIRECTORY))
        const { anchor } = buildDemoBundleManifest(sources, assetHash)
        const today = (await bundleDocuments()).find((doc) => doc.path === `journals/${anchor}.md`)?.text ?? ''
        const lines = today.split('\n')
        const heading = lines.indexOf('## Maps')
        const end = lines.findIndex((line, n) => n > heading && line.startsWith('## '))
        const section = lines.slice(heading + 1, end < 0 ? undefined : end)
        expect(heading).toBeGreaterThanOrEqual(0)
        // Above the section's bullets, so it is the first thing under the heading but a line of text.
        const fence = section.indexOf('```map')
        expect(fence).toBeGreaterThanOrEqual(0)
        expect(fence).toBeLessThan(section.findIndex((line) => line.startsWith('- ')))
        const items = deriveDoc(today).mapItems.filter((item) => item.fenceLine === heading + 1 + fence)
        expect(items.some((item) => item.kind === 'place')).toBe(true)
        expect(items.some((item) => item.kind === 'route')).toBe(true)
    })

    it('reads every line of every map', async () => {
        // A line the Map Block cannot read is kept and counted, but never drawn: in the demo it
        // would be a place that silently goes missing.
        const unread = (await bundleDocuments()).flatMap(({ path, text }) => {
            const lines = text.split('\n')
            return lines.flatMap((line, start) => {
                const open = /^(\s*)```map\s*$/.exec(line)
                if (!open) return []
                const end = lines.findIndex((closer, n) => n > start && /^\s*```\s*$/.test(closer))
                if (end < 0) return [`${path}:${start + 1} has no closing fence`]
                const body = lines.slice(start + 1, end).map((bodyLine) => bodyLine.slice(open[1].length))
                return readMapBody(body).unread.map((miss) => `${path}:${start + 2 + miss.line} ${miss.text}`)
            })
        })
        expect(unread).toEqual([])
    })

    it('gathers places to learn about plants from several documents, and draws a route', async () => {
        // A place belongs to the concepts of the bullet its map sits under, so the Map View of
        // [[Where to Learn About Plants]] collects the gardens noted on plant pages and in the
        // journal, beside any on its own page.
        const learning = conceptKey('Where to Learn About Plants')
        const documents = (await bundleDocuments()).map(({ path, text }) => {
            const { mapItems, mapConcepts } = deriveDoc(text)
            const tagged = new Set(mapConcepts.filter((row) => conceptKey(row.concept) === learning).map((row) => row.blockLocalId))
            return { path, mapItems, places: mapItems.filter((item) => item.kind === 'place' && tagged.has(item.blockLocalId)) }
        })
        const tagging = documents.filter((doc) => doc.places.length > 0)
        expect(tagging.length).toBeGreaterThanOrEqual(5)
        expect(tagging.some((doc) => doc.path.startsWith('journals/'))).toBe(true)
        const page = documents.find((doc) => doc.path === 'pages/Where to Learn About Plants.md')
        expect(page).toBeDefined()
        expect(tagging.reduce((sum, doc) => sum + doc.places.length, page?.mapItems.length ?? 0)).toBeGreaterThanOrEqual(10)
        expect(documents.some((doc) => doc.mapItems.some((item) => item.kind === 'route'))).toBe(true)
    })
})
