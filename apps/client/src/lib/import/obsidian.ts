/**
 * The Obsidian converter.
 * Also the `markdown` fallback pipeline - an arbitrary folder of markdown is an Obsidian
 * vault without the `.obsidian/` config, and every step degrades gracefully.
 *
 * Folders flatten; only colliding base names become [[Scoped Concept]]s (the
 * distinguishing folder as scope). Piped links are alias-aware with a visible prose
 * fallback. Daily notes come from `.obsidian/daily-notes.json`, falling back to exact
 * ISO-named files. Files are otherwise native GFM and pass through untouched.
 */

import { portableFileStem } from '$lib/document/wikilink'
import { MARKDOWN_LINK } from '$lib/document/markdown-link-target'
import { parseFrontmatter } from '$lib/storage/fs/frontmatter'
import { normaliseAliases } from '$lib/document/frontmatter/identity'

import { type PlannedAsset, normaliseRef, planAssets } from './assets'
import { buildFrontmatter, createFenceTracker, dedupeConcept, outsideInlineCode, scopedConceptName } from './convert-shared'
import { logseqDateToIso } from './logseq-dates'
import { convertObsidianTaskLine } from './obsidian-tasks'
import { baseName, contentFiles, dirName, findFile, isMarkdownPath, readText } from './source'
import { breathe, type ConvertedDocument, type ConvertedGraph, type ImportControl, type ReportEntry, type SourceFile } from './types'

interface ObsidianNote {
    kind: 'journal' | 'page'
    concept: string
    fileName: string
    /** Root-relative source path without the .md extension, lower-cased (link resolution). */
    pathKey: string
    /** Lower-cased base-name stem (link resolution). */
    stemKey: string
    dir: string
    body: string
    frontmatter: Record<string, unknown>
    aliases: string[]
}

/** Translate a Moment format (Obsidian) into the date-grammar token space we compile. */
function momentFormat(format: string): string {
    const map: Record<string, string> = {
        YYYY: 'yyyy',
        dddd: 'EEEE',
        ddd: 'EEE',
        Do: 'do',
        DD: 'dd',
        D: 'd',
    }
    return format.replace(/YYYY|MMMM|MMM|MM|M|dddd|ddd|Do|DD|D/g, (token) => map[token] ?? token)
}

interface DailyNotesConfig {
    folder: string
    grammar: string
}

async function readDailyNotesConfig(files: SourceFile[]): Promise<DailyNotesConfig | null> {
    const file = findFile(files, '.obsidian/daily-notes.json')
    if (!file) return null
    try {
        const parsed = JSON.parse(await readText(file)) as { folder?: string; format?: string }
        return {
            folder: (parsed.folder ?? '').replace(/\/$/, ''),
            grammar: momentFormat(parsed.format || 'YYYY-MM-DD'),
        }
    } catch {
        return null
    }
}

export async function convertObsidian(files: SourceFile[], control?: ImportControl): Promise<ConvertedGraph> {
    const onProgress = control?.onProgress
    const report: ReportEntry[] = []
    const dailyNotes = await readDailyNotesConfig(files)

    const content = contentFiles(files)
    const assetPlan = await planAssets(
        content.filter((f) => !isMarkdownPath(f.path)),
        { control },
    )
    const mdFiles = content.filter((f) => isMarkdownPath(f.path))

    // ---- Identity: journals by date, pages flattened with scoped-collision handling.
    const notes: ObsidianNote[] = []
    interface PendingPage {
        stem: string
        dir: string
        segments: string[]
        body: string
        frontmatter: Record<string, unknown>
        aliases: string[]
        pathKey: string
    }
    const pendingPages: PendingPage[] = []

    let read = 0
    for (const file of mdFiles) {
        // The long, I/O-bound opening stretch: it awaited but reported nothing.
        control?.signal?.throwIfAborted()
        onProgress?.({ label: 'Reading files', done: ++read, total: mdFiles.length })
        const stem = baseName(file.path).replace(/\.md$/i, '')
        const dir = dirName(file.path)
        const fm = parseFrontmatter(await readText(file))
        const aliases = obsidianAliases(fm.data)
        const pathKey = file.path.replace(/\.md$/i, '').toLowerCase()

        const iso = dailyNotes
            ? dir === dailyNotes.folder
                ? logseqDateToIso(stem, dailyNotes.grammar)
                : null
            : logseqDateToIso(stem, 'yyyy-MM-dd')
        if (iso && !notes.some((n) => n.kind === 'journal' && n.concept === iso)) {
            notes.push({
                kind: 'journal',
                concept: iso,
                fileName: `${iso}.md`,
                pathKey,
                stemKey: stem.toLowerCase(),
                dir,
                body: fm.body,
                frontmatter: fm.data,
                aliases,
            })
            continue
        }
        if (iso) {
            report.push({
                category: 'collision',
                concept: iso,
                detail: `More than one note maps to the ${iso} journal; "${file.path}" imported as a page`,
            })
        }
        pendingPages.push({ stem, dir, segments: dir === '' ? [] : dir.split('/'), body: fm.body, frontmatter: fm.data, aliases, pathKey })
    }

    // Collision groups by base-name stem: singletons keep the bare concept; a colliding
    // note takes its nearest distinguishing folders as a scope chain.
    const byStem = new Map<string, PendingPage[]>()
    for (const page of pendingPages) {
        const key = page.stem.toLowerCase()
        byStem.set(key, [...(byStem.get(key) ?? []), page])
    }

    const takenConcepts = new Set<string>(notes.map((n) => n.concept.toLowerCase()))
    const takenFileNames = new Set<string>(notes.map((n) => n.fileName.toLowerCase()))

    for (const [, group] of byStem) {
        for (const page of group) {
            let concept = page.stem
            if (group.length > 1 && page.segments.length > 0) {
                for (let depth = 1; depth <= page.segments.length; depth++) {
                    const chain = page.segments.slice(-depth)
                    concept = scopedConceptName([...chain, page.stem])
                    const clashes = group.some(
                        (other) =>
                            other !== page &&
                            scopedConceptName([...other.segments.slice(-depth), other.stem]).toLowerCase() ===
                                concept.toLowerCase(),
                    )
                    if (!clashes) break
                }
                report.push({
                    category: 'collision',
                    concept,
                    detail: `"${page.stem}" exists in more than one folder; "${page.dir}/${page.stem}" became the scoped concept "${concept}"`,
                })
            }
            concept = dedupeConcept(concept, (key) => takenConcepts.has(key))
            takenConcepts.add(concept.toLowerCase())
            let fileName = `${portableFileStem(concept)}.md`
            for (let n = 2; takenFileNames.has(fileName.toLowerCase()); n++) {
                fileName = `${portableFileStem(concept)} (${n}).md`
            }
            takenFileNames.add(fileName.toLowerCase())
            notes.push({
                kind: 'page',
                concept,
                fileName,
                pathKey: page.pathKey,
                stemKey: page.stem.toLowerCase(),
                dir: page.dir,
                body: page.body,
                frontmatter: page.frontmatter,
                aliases: page.aliases,
            })
        }
    }

    // ---- Link resolution.
    const byPath = new Map(notes.map((n) => [n.pathKey, n]))
    const byStemKey = new Map<string, ObsidianNote[]>()
    for (const note of notes) {
        byStemKey.set(note.stemKey, [...(byStemKey.get(note.stemKey) ?? []), note])
    }
    const reportedAmbiguous = new Set<string>()

    /** Resolve a link's base target (no fragment) to a note, or null. */
    const resolveNote = (target: string, fromConcept: string): ObsidianNote | null => {
        const clean = target.replace(/\.md$/i, '').toLowerCase()
        const exact = byPath.get(clean)
        if (exact) return exact
        if (clean.includes('/')) {
            // Obsidian's shortest-path links may carry a partial subpath.
            return notes.find((n) => n.pathKey.endsWith(`/${clean}`)) ?? null
        }
        const matches = byStemKey.get(clean)
        if (!matches || matches.length === 0) return null
        if (matches.length > 1 && !reportedAmbiguous.has(clean)) {
            reportedAmbiguous.add(clean)
            report.push({
                category: 'unresolved',
                concept: fromConcept,
                detail: `Links to \`${target}\` are ambiguous (${matches.length} notes share the name); resolved to [[${matches[0].concept}]]`,
            })
        }
        return matches[0]
    }

    /** Find an asset by wiki-embed name (base name) or by markdown path. */
    const resolveAssetByName = (name: string): PlannedAsset | null => {
        const candidates = assetPlan.byBaseName.get((name.split('/').pop() ?? name).toLowerCase())
        return candidates?.[0] ?? null
    }
    const resolveAssetByPath = (ref: string, dir: string): PlannedAsset | null =>
        assetPlan.byPath.get(normaliseRef(ref, dir)) ?? assetPlan.byPath.get(normaliseRef(ref, '')) ?? null

    /** The label treatment for [[target|label]] and [label](note.md): alias-aware, prose fallback. */
    const linkWithLabel = (label: string, target: ObsidianNote | null, targetText: string, fromConcept: string): string => {
        const concept = target ? target.concept : targetText
        if (label.toLowerCase() === concept.toLowerCase()) return `[[${label}]]`
        if (target?.aliases.some((a) => a.toLowerCase() === label.toLowerCase())) return `[[${label}]]`
        report.push({
            category: 'degradation',
            concept: fromConcept,
            detail: `Piped link \`[[${targetText}|${label}]]\` became "${label} ([[${concept}]])" (label is not an alias)`,
        })
        return `${label} ([[${concept}]])`
    }

    // ---- Body conversion.
    const convertBody = (note: ObsidianNote): string => {
        const inFence = createFenceTracker()
        const out: string[] = []
        for (const raw of note.body.split('\n')) {
            if (inFence(raw)) {
                out.push(raw)
                continue
            }
            let line = convertObsidianTaskLine(raw, note.concept, report)
            line = outsideInlineCode(line, (segment) => {
                let text = segment

                // Trailing block-id anchor: presentation-only, strip.
                text = text.replace(/\s\^[A-Za-z0-9-]+$/, '')

                // Embeds: assets become asset markdown; note embeds degrade to links.
                text = text.replace(/!\[\[([^[\]|]+)(?:\|([^[\]]*))?\]\]/g, (all, target: string, pipe?: string) => {
                    const asset = resolveAssetByName(target)
                    if (asset) {
                        assetPlan.markReferenced(asset)
                        if (asset.isImage) {
                            // A numeric pipe is an Obsidian display size (EtherPK has the
                            // same alt-text hint); any other pipe text is a caption/alt.
                            const alt =
                                pipe && /^\d+(x\d+)?$/.test(pipe)
                                    ? `${asset.stem}|${pipe}`
                                    : pipe || asset.stem
                            return `![${alt}](${asset.ref})`
                        }
                        return `[${pipe || asset.stem}](${asset.ref})`
                    }
                    const target2 = target.split('#')[0]
                    const resolved = resolveNote(target2, note.concept)
                    const concept = resolved ? resolved.concept : target2
                    report.push({
                        category: 'degradation',
                        concept: note.concept,
                        detail: `Embed \`![[${target}]]\` degraded to the link [[${concept}]]`,
                    })
                    return `[[${concept}]]`
                })

                // Wiki links: fragments strip, pipes are alias-aware, targets re-point.
                text = text.replace(
                    /\[\[([^[\]|#]+)(#[^[\]|]*)?(?:\|([^[\]]*))?\]\]/g,
                    (all, target: string, fragment?: string, label?: string) => {
                        const asset = resolveAssetByName(target)
                        if (asset && /\.[A-Za-z0-9]+$/.test(target)) {
                            assetPlan.markReferenced(asset)
                            return `[${label ?? asset.stem}](${asset.ref})`
                        }
                        const resolved = resolveNote(target, note.concept)
                        const concept = resolved ? resolved.concept : target.trim()
                        if (fragment) {
                            report.push({
                                category: 'degradation',
                                concept: note.concept,
                                detail: `Link \`[[${target}${fragment}]]\` lost its fragment (heading/block links are not supported)`,
                            })
                        }
                        if (label !== undefined) return linkWithLabel(label, resolved, target, note.concept)
                        return `[[${concept}]]`
                    },
                )

                // Markdown links/images to local files: notes become wikilinks, assets re-point.
                const links = new RegExp(MARKDOWN_LINK, 'g')
                text = text.replace(links, (...args) => {
                    const all = args[0] as string
                    const { bang, label, target: ref } = args.at(-1) as Record<string, string>
                    if (/^[a-z][a-z0-9+.-]*:/i.test(ref)) return all // absolute URL / mailto etc.
                    const asset = resolveAssetByPath(ref, note.dir)
                    if (asset) {
                        assetPlan.markReferenced(asset)
                        return `${bang}[${label}](${asset.ref})`
                    }
                    if (/\.md$/i.test(ref)) {
                        const resolved = resolveNote(normaliseRef(ref, note.dir), note.concept) ?? resolveNote(ref, note.concept)
                        if (resolved) return linkWithLabel(label, resolved, resolved.concept, note.concept)
                    }
                    return all
                })

                return text
            })
            out.push(line)
        }
        return out.join('\n')
    }

    // A `for` loop rather than `.map`, so the pass can yield: it reported per document but
    // never released the thread, so the toast froze until the last tick.
    let converted = 0
    const documents: ConvertedDocument[] = []
    for (const note of notes) {
        await breathe(control)
        onProgress?.({ label: 'Converting documents', done: ++converted, total: notes.length })
        const body = convertBody(note)
        const { title, ...rest } = withAliasesList(note.frontmatter, note.aliases)
        if (typeof title === 'string' && title.trim() !== '' && title !== note.concept) {
            report.push({
                category: 'degradation',
                concept: note.concept,
                detail: `Frontmatter title "${title}" replaced by the concept "${note.concept}" (links reference the file name)`,
            })
        }
        const frontmatter =
            note.kind === 'page' ? { title: note.concept, ...rest } : { ...rest }
        documents.push({
            kind: note.kind,
            concept: note.concept,
            fileName: note.fileName,
            text: `${buildFrontmatter(frontmatter)}${body}`,
        })
    }

    for (const asset of assetPlan.assets.filter((a) => a.unreferenced)) {
        report.push({
            category: 'unreferenced',
            detail: `Asset "${asset.fileName}" is referenced by no document (imported anyway)`,
        })
    }

    return { documents, assets: assetPlan.assets, report }
}

/**
 * A note's aliases in every form Obsidian has read. Obsidian's guidance is an `aliases:` list
 * (https://obsidian.md/help/aliases), but before 1.4 it also read the singular `alias` key and
 * split a text value at its commas, even a quoted one, which Obsidian staff called a divergence
 * from YAML (https://forum.obsidian.md/t/an-alias-wrongly-treated-as-a-list-of-aliases-by-obsidian-if-they-contain-comma-in-them/29734).
 * 1.4 deprecated `alias` and began rewriting both forms to lists, and 1.9 stopped reading them
 * (https://obsidian.md/help/properties, "Deprecated properties"). A vault last saved by an older
 * Obsidian still holds them, so all of them are read here: `aliases` first, then `alias`.
 */
function obsidianAliases(data: Record<string, unknown>): string[] {
    return normaliseAliases([...aliasValues(data.aliases), ...aliasValues(data.alias)])
}

/** One alias property's names: a list's strings, or a text value split at its commas. */
function aliasValues(value: unknown): string[] {
    const items: unknown[] = typeof value === 'string' ? value.split(',') : Array.isArray(value) ? value : []
    return items.filter((item): item is string => typeof item === 'string')
}

/**
 * The note's block with its aliases as the `aliases:` list EtherPK reads (`aliasesOf`), in the
 * place the first alias property held. A block that already has only an `aliases:` list is
 * returned as it is, so an import never rewrites more of the vault's YAML than it must.
 */
function withAliasesList(data: Record<string, unknown>, aliases: string[]): Record<string, unknown> {
    if (!('alias' in data) && typeof data.aliases !== 'string') return data
    const out: Record<string, unknown> = {}
    let placed = false
    for (const [key, value] of Object.entries(data)) {
        if (key !== 'alias' && key !== 'aliases') {
            out[key] = value
            continue
        }
        if (!placed && aliases.length > 0) out.aliases = aliases
        placed = true
    }
    return out
}
