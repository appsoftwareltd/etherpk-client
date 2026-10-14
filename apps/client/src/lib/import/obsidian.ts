/**
 * The Obsidian converter.
 * Also the `markdown` fallback pipeline - an arbitrary folder of markdown is an Obsidian
 * vault without the `.obsidian/` config, and every step degrades gracefully.
 *
 * Folders flatten; only colliding base names become [[Scoped Concept]]s (the
 * distinguishing folder as scope). Piped links are alias-aware with a visible prose
 * fallback. Daily notes come from `.obsidian/daily-notes.json`, falling back to exact
 * ISO-named files. Files are otherwise native GFM and pass through untouched. The pages in the
 * templates folder (`.obsidian/templates.json`) become [[Template]]s (ADR 0144), and the daily
 * notes template the [[Journal Template]] (ADR 0145).
 */

import { MARKDOWN_LINK } from '$lib/document/markdown-link-target'
import { normaliseAliases } from '$lib/document/frontmatter/identity'

import { type PlannedAsset, normaliseRef, planAssets } from './assets'
import { buildFrontmatter, createFenceTracker, outsideInlineCode, readSourceFrontmatter, UNREADABLE_FRONTMATTER_DETAIL } from './convert-shared'
import { placeFolderPages, type TakenNames } from './folder-pages'
import { logseqDateToIso } from './logseq-dates'
import { calloutHeading, obsidianComments, unsupportedConstructs, unsupportedMomentTokens, withoutComments } from './obsidian-constructs'
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
    /** A block YAML rejects, carried over as written in place of a rebuilt one (see `readSourceFrontmatter`). */
    keptBlock?: string
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
    /** The note a new daily note starts from, as the setting names it: vault-relative, usually without `.md`. */
    template?: string
}

async function readDailyNotesConfig(files: SourceFile[]): Promise<DailyNotesConfig | null> {
    const file = findFile(files, '.obsidian/daily-notes.json')
    if (!file) return null
    try {
        const parsed = JSON.parse(await readText(file)) as { folder?: string; format?: string; template?: unknown }
        const template = typeof parsed.template === 'string' ? parsed.template.trim() : ''
        return {
            folder: (parsed.folder ?? '').replace(/\/$/, ''),
            grammar: momentFormat(parsed.format || 'YYYY-MM-DD'),
            ...(template ? { template } : {}),
        }
    } catch {
        return null
    }
}

/** The core Templates plugin's settings: its folder, and the formats its `{{date}}` and `{{time}}` used. */
interface TemplatesConfig {
    /** Vault-relative, without slashes at either end. */
    folder: string | null
    dateFormat?: string
    timeFormat?: string
}

async function readTemplatesConfig(files: SourceFile[]): Promise<TemplatesConfig | null> {
    const file = findFile(files, '.obsidian/templates.json')
    if (!file) return null
    try {
        const parsed = JSON.parse(await readText(file)) as { folder?: unknown; dateFormat?: unknown; timeFormat?: unknown }
        const folder = typeof parsed.folder === 'string' ? parsed.folder.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '') : ''
        const format = (value: unknown) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined)
        return { folder: folder === '' ? null : folder, dateFormat: format(parsed.dateFormat), timeFormat: format(parsed.timeFormat) }
    } catch {
        return null
    }
}

/** The formats Obsidian's `{{date}}` and `{{time}}` use by default, which EtherPK's always use. */
const DEFAULT_DATE_FORMAT = 'YYYY-MM-DD'
const DEFAULT_TIME_FORMAT = 'HH:mm'

/** A `{{date:FORMAT}}` or `{{time:FORMAT}}` variable, read as EtherPK's renderer reads it. */
const FORMAT_VARIABLE = /(\\?)\{\{\s*(?:date|time):([^{}]+)\}\}/gi

export async function convertObsidian(files: SourceFile[], control?: ImportControl): Promise<ConvertedGraph> {
    const onProgress = control?.onProgress
    const report: ReportEntry[] = []
    const dailyNotes = await readDailyNotesConfig(files)
    const templatesConfig = await readTemplatesConfig(files)

    const content = contentFiles(files)
    const assetPlan = await planAssets(
        content.filter((f) => !isMarkdownPath(f.path)),
        { control },
    )
    const mdFiles = content.filter((f) => isMarkdownPath(f.path))
    // A canvas is Obsidian's JSON board: it arrives as a file, and a link to it downloads the JSON.
    for (const planned of assetPlan.byPath.values()) {
        if (!/\.canvas$/i.test(planned.path)) continue
        report.push({
            category: 'unsupported',
            detail: `Canvas "${baseName(planned.path)}" imported as a file: EtherPK has no canvas view`,
        })
    }

    // ---- Identity: journals by date, pages flattened with scoped-collision handling.
    const notes: ObsidianNote[] = []
    interface PendingPage {
        stem: string
        dir: string
        segments: string[]
        body: string
        frontmatter: Record<string, unknown>
        keptBlock?: string
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
        const fm = readSourceFrontmatter(await readText(file))
        const keptBlock = fm.kind === 'unreadable' ? fm.block : undefined
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
                keptBlock,
                aliases,
            })
            continue
        }
        if (iso) {
            report.push({
                category: 'collision',
                concept: iso,
                detail: `More than one note maps to the ${iso} journal - "${file.path}" imported as a page`,
            })
        }
        pendingPages.push({ stem, dir, segments: dir === '' ? [] : dir.split('/'), body: fm.body, frontmatter: fm.data, keptBlock, aliases, pathKey })
    }

    // Pages flatten: a colliding name takes its nearest distinguishing folders as a scope chain.
    const taken: TakenNames = {
        concepts: new Set(notes.map((n) => n.concept.toLowerCase())),
        fileNames: new Set(notes.map((n) => n.fileName.toLowerCase())),
    }
    for (const { page, concept, fileName } of placeFolderPages(pendingPages, taken, report)) {
        notes.push({
            kind: 'page',
            concept,
            fileName,
            pathKey: page.pathKey,
            stemKey: page.stem.toLowerCase(),
            dir: page.dir,
            body: page.body,
            frontmatter: page.frontmatter,
            keptBlock: page.keptBlock,
            aliases: page.aliases,
        })
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
                detail: `Links to \`${target}\` are ambiguous (${matches.length} notes share the name) - resolved to [[${matches[0].concept}]]`,
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

    // ---- Templates. Every page in the core Templates plugin's folder is a Template (ADR 0144), and
    // so is the note the Daily notes plugin starts each day from, which Obsidian fills in the same way.
    const templateNotes = new Set<ObsidianNote>()
    const templateFolder = templatesConfig?.folder?.toLowerCase() ?? null
    if (templateFolder !== null) {
        for (const note of notes) {
            const dir = note.dir.toLowerCase()
            if (note.kind === 'page' && (dir === templateFolder || dir.startsWith(`${templateFolder}/`))) templateNotes.add(note)
        }
    }
    let dailyTemplate: ObsidianNote | null = null
    if (dailyNotes?.template) {
        // The setting is a vault path, read the way Obsidian reads a link to it.
        const found = resolveNote(dailyNotes.template.replace(/^\/+/, ''), '')
        if (found?.kind === 'page') {
            dailyTemplate = found
            templateNotes.add(found)
        }
    }
    // Obsidian's `{{date}}` and `{{time}}` used these formats. EtherPK's always use its own, and a
    // Template that links a day as `[[{{date}}]]` needs the ISO form to reach the journal, so the
    // variables are left alone and the difference is reported.
    if (templatesConfig?.dateFormat && templatesConfig.dateFormat !== DEFAULT_DATE_FORMAT) {
        report.push({
            category: 'degradation',
            detail: `.obsidian/templates.json sets the date format to "${templatesConfig.dateFormat}". In EtherPK, \`{{date}}\` always gives YYYY-MM-DD. To keep the old form, write \`{{date:${templatesConfig.dateFormat}}}\` in a Template.`,
        })
    }
    if (templatesConfig?.timeFormat && templatesConfig.timeFormat !== DEFAULT_TIME_FORMAT) {
        report.push({
            category: 'degradation',
            detail: `.obsidian/templates.json sets the time format to "${templatesConfig.timeFormat}". In EtherPK, \`{{time}}\` always gives HH:mm. To keep the old form, write \`{{time:${templatesConfig.timeFormat}}}\` in a Template.`,
        })
    }

    // ---- Body conversion.
    const convertBody = (note: ObsidianNote, body: string): string => {
        const inFence = createFenceTracker()
        const out: string[] = []
        for (const raw of body.split('\n')) {
            if (inFence(raw)) {
                out.push(raw)
                continue
            }
            // A callout header becomes a quote with a bold heading; its body lines already are one.
            const callout = calloutHeading(raw)
            if (callout) {
                report.push({
                    category: 'degradation',
                    concept: note.concept,
                    detail: `Callout \`[!${callout.type}]\` became a quote with a bold heading`,
                })
            }
            let line = convertObsidianTaskLine(callout ? callout.line : raw, note.concept, report)
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
        // Comments are hidden in Obsidian and would show, and publish, here: removed, and each
        // listed with its text so nothing in them is lost.
        const comments = obsidianComments(note.body)
        for (const comment of comments) {
            report.push({
                category: 'drop',
                concept: note.concept,
                detail: `Comment removed: "${comment.text.replace(/\s+/g, ' ').trim()}"`,
            })
        }
        const uncommented = withoutComments(note.body, comments)
        const { footnotes, tags } = unsupportedConstructs(uncommented)
        if (footnotes) {
            report.push({ category: 'unsupported', concept: note.concept, detail: 'Footnotes kept as written: EtherPK does not render them' })
        }
        if (tags.length > 0) {
            report.push({
                category: 'unsupported',
                concept: note.concept,
                detail: `Tags kept as plain text (${tags.join(', ')}): EtherPK has no tags`,
            })
        }
        const body = convertBody(note, uncommented)
        const template = templateNotes.has(note)
        if (note.keptBlock !== undefined) {
            // Nothing is rebuilt from a block nothing could read, so no `title:` either: the page's
            // name is its file name, which is already written from the concept.
            report.push({ category: 'unsupported', concept: note.concept, detail: UNREADABLE_FRONTMATTER_DETAIL })
            if (template) {
                templateNotes.delete(note)
                report.push({
                    category: 'unsupported',
                    concept: note.concept,
                    detail: 'This page is a template in Obsidian, but its frontmatter is not valid YAML, so it was not made a Template. Correct the frontmatter and add `template: true` to make it one.',
                })
            }
            documents.push({ kind: note.kind, concept: note.concept, fileName: note.fileName, text: `${note.keptBlock}${body}` })
            continue
        }
        if (template) {
            // Obsidian fills a template's formats in wherever they are, code included, as EtherPK does.
            const unfilled = new Set<string>()
            for (const match of body.matchAll(FORMAT_VARIABLE)) {
                if (!match[1]) for (const token of unsupportedMomentTokens(match[2])) unfilled.add(token)
            }
            if (unfilled.size > 0) {
                report.push({ category: 'unsupported', concept: note.concept, detail: momentTokensDetail([...unfilled]) })
            }
        }
        const { title, ...rest } = withAliasesList(note.frontmatter, note.aliases)
        if (typeof title === 'string' && title.trim() !== '' && title !== note.concept) {
            report.push({
                category: 'degradation',
                concept: note.concept,
                detail: `Frontmatter title "${title}" replaced by the concept "${note.concept}" (links reference the file name)`,
            })
        }
        const frontmatter =
            note.kind === 'page' ? { title: note.concept, ...rest, ...(template ? { template: true } : {}) } : { ...rest }
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

    // The daily notes template becomes the Journal Template (ADR 0145), carried in Graph Settings
    // as an EtherPK source's settings are. A template that is not a Template here cannot be one.
    let settings: Record<string, unknown> | undefined
    if (dailyNotes?.template) {
        if (dailyTemplate && templateNotes.has(dailyTemplate)) {
            settings = { journalTemplate: dailyTemplate.concept }
        } else if (!dailyTemplate) {
            report.push({
                category: 'unresolved',
                detail: `.obsidian/daily-notes.json names "${dailyNotes.template}" as the template for new daily notes, but the import found no note there. The graph has no Journal Template.`,
            })
        }
    }

    return { documents, assets: assetPlan.assets, ...(settings ? { settings } : {}), report }
}

/** The Import Report's line for the Moment tokens a Template's formats use that EtherPK does not fill in. */
function momentTokensDetail(tokens: string[]): string {
    const quoted = tokens.map((token) => `\`${token}\``)
    const list = quoted.length === 1 ? quoted[0] : `${quoted.slice(0, -1).join(', ')} and ${quoted.at(-1)}`
    const which = quoted.length === 1 ? 'token' : 'tokens'
    return `The date and time formats in this Template use the Moment ${which} ${list}, which EtherPK does not fill in. EtherPK fills in only YYYY, YY, MM, DD, HH, mm and ss.`
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
