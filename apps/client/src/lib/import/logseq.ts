/**
 * The Logseq converter.
 *
 * Structure is preserved verbatim (no heading promotion - see the roadmap's "formatted
 * headings inside outliner blocks"); tabs normalise to the default 2-space indent unit.
 * Namespaces become [[Scoped Concept]]s, journals convert to ISO file names, task
 * markers convert per ADR 0032, and everything lossy lands in the report.
 */

import {
    normalizeDisplaySize,
    parseImageDisplaySizeHint,
} from '$lib/document/view/augmentations/image-display-size'
import { portableFileStem } from '$lib/document/wikilink'
import { MARKDOWN_LINK } from '$lib/document/markdown-link-target'

import { type AssetPlan, normaliseRef, planAssets, tryDecode } from './assets'
import { buildFrontmatter, createFenceTracker, dedupeConcept, outsideInlineCode, scopedConceptName } from './convert-shared'
import { type LogseqConfig, logseqDateToIso, parseLogseqConfig } from './logseq-dates'
import { parseLogseqTask, orgTimestampDate } from './logseq-tasks'
import { baseName, contentFiles, findFile, isMarkdownPath, readText } from './source'
import { type TaskTags, taskLine } from './task-tags'
import { breathe, type ConvertedDocument, type ConvertedGraph, type ImportControl, type ReportEntry, type SourceFile } from './types'

/** Journal file-stem formats tried after the configured one - real graphs mix eras. */
const FALLBACK_STEM_FORMATS = ['yyyy_MM_dd', 'yyyy-MM-dd', 'yyyyMMdd']

const BLOCK_REF = /\(\(([0-9a-fA-F][0-9a-fA-F-]{34,35})\)\)/g
const PAGE_PROP = /^([A-Za-z][A-Za-z0-9_-]*)::\s*(.*)$/

interface LogseqDoc {
    kind: 'journal' | 'page'
    concept: string
    fileName: string
    lines: string[]
    props: Record<string, string>
    sourcePath: string
}

interface BlockRef {
    concept: string
    text: string
}

/** Split `alias:: [[A]], B` style values into clean names. */
function splitPropList(value: string): string[] {
    return value
        .split(',')
        .map((part) => part.trim().replace(/^\[\[/, '').replace(/\]\]$/, '').trim())
        .filter((part) => part !== '')
}

/** The page concept for a Logseq file stem: percent-decoded, `___`/`/` namespaces scoped. */
function pageConcept(stem: string): { concept: string; namespace: boolean } {
    const decoded = tryDecode(stem).replace(/___/g, '/')
    const segments = decoded
        .split('/')
        .map((s) => s.trim())
        .filter((s) => s !== '')
    if (segments.length > 1) return { concept: scopedConceptName(segments), namespace: true }
    return { concept: decoded, namespace: false }
}

/** Leading tabs (Logseq's indent) become two spaces so the bullet/task regexes below read them; the
 *  Indent Unit normaliser in convert.ts then puts the whole document on the grid (ADR 0067). */
function normaliseIndent(line: string): string {
    return line.replace(/^[\t ]*/, (ws) => ws.replace(/\t/g, '  '))
}

/** Top-of-file `key:: value` page properties: collect and strip. */
function extractPageProps(lines: string[]): { props: Record<string, string>; body: string[] } {
    const props: Record<string, string> = {}
    let i = 0
    while (i < lines.length) {
        const match = PAGE_PROP.exec(lines[i])
        if (!match) break
        props[match[1].toLowerCase()] = match[2].trim()
        i += 1
    }
    // Properties are only page properties when they sit at the very top.
    return { props, body: lines.slice(i) }
}

interface InlineContext {
    concept: string
    config: LogseqConfig
    blockRefs: Map<string, BlockRef>
    assetPlan: AssetPlan
    report: ReportEntry[]
    /** Namespace link targets already reported (dedupe - one entry per target). */
    reportedNamespaces: Set<string>
    /** Documents whose image-size conversion has been reported (one entry per document). */
    reportedImageSizes: Set<string>
    sourceDir: string
}

/**
 * Logseq's image dimensions: `![alt](path){:height 609, :width 463}`.
 *
 * EtherPK carries the same idea as a [[Display Size]] hint in the alt text - `![alt|463x609]`
 * - which is the form the Obsidian importer already produces for `![[img|300]]`. Note the
 * **transposition**: Logseq writes height first, the hint is `WIDTHxHEIGHT`. On the graph this
 * was built against, 2097 images carry these attributes, and left alone they both stop the
 * image rendering (the trailing `{...}` means the image is no longer a bullet's sole content)
 * and show up as literal junk.
 *
 * Deliberately permissive about the attribute block's internals: the keys are matched
 * wherever they appear, so `{:width 463, :height 609}` and extra keys both work.
 */
const LOGSEQ_IMAGE_ATTRS = new RegExp(`${MARKDOWN_LINK}\\{(?<attrs>:[^}]*)\\}`, 'g')

/** The inline transform chain, applied outside fences and inline code. */
function transformInline(text: string, ctx: InlineContext): string {
    return outsideInlineCode(text, (segment) => {
        let out = segment

        // Logseq's older ^^highlight^^ spelling becomes the ==highlight== the editor renders (ADR 0077).
        out = out.replace(/\^\^([^\s^](?:[^^\n]*[^\s^])?)\^\^/g, '==$1==')

        // {{embed [[X]]}} → [[X]]; {{embed ((uuid))}} → ((uuid)) (handled next).
        out = out.replace(/\{\{embed\s+(\[\[[^\]]+\]\]|\(\([0-9a-fA-F-]+\)\))\s*\}\}/g, (_all, inner: string) => {
            ctx.report.push({
                category: 'degradation',
                concept: ctx.concept,
                detail: `Embed \`{{embed ${inner}}}\` degraded to a plain reference`,
            })
            return inner
        })

        // ((uuid)) block refs: inline the referenced block's text plus its source link.
        out = out.replace(BLOCK_REF, (all, uuid: string) => {
            const target = ctx.blockRefs.get(uuid.toLowerCase())
            if (!target) {
                ctx.report.push({
                    category: 'unresolved',
                    concept: ctx.concept,
                    detail: `Block reference \`${all}\` could not be resolved; left as-is`,
                })
                return all
            }
            ctx.report.push({
                category: 'degradation',
                concept: ctx.concept,
                detail: `Block reference inlined as its text with a link to [[${target.concept}]]`,
            })
            return `${target.text} ([[${target.concept}]])`
        })

        // Remaining {{...}} macros (query, renderer...) are inert text - leave, report.
        for (const macro of out.matchAll(/\{\{[^}]*\}\}/g)) {
            ctx.report.push({
                category: 'unsupported',
                concept: ctx.concept,
                detail: `Macro \`${macro[0]}\` left as-is (no EtherPK equivalent)`,
            })
        }

        // A Logseq tag IS a page reference: #tag → [[tag]], #[[multi word]] → [[multi word]].
        out = out.replace(/(^|[\s(])#\[\[([^\]]+)\]\]/g, '$1[[$2]]')
        out = out.replace(/(^|[\s(])#([A-Za-z0-9][\w-]*)/g, '$1[[$2]]')

        // Wikilink targets: date-page titles → ISO; namespace paths → scoped chains.
        out = out.replace(/\[\[([^[\]]+)\]\]/g, (all, target: string) => {
            const iso = logseqDateToIso(target, ctx.config.journalTitleFormat)
            if (iso) return `[[${iso}]]`
            if (target.includes('/') && !target.includes('://')) {
                const segments = target
                    .split('/')
                    .map((s) => s.trim())
                    .filter((s) => s !== '')
                if (segments.length > 1) {
                    if (!ctx.reportedNamespaces.has(target)) {
                        ctx.reportedNamespaces.add(target)
                        ctx.report.push({
                            category: 'rename',
                            concept: ctx.concept,
                            detail: `Namespace links to \`${target}\` rewritten to the scoped concept [[${scopedConceptName(segments)}]]`,
                        })
                    }
                    return `[[${scopedConceptName(segments)}]]`
                }
            }
            return all
        })

        // Markdown asset references → the new content-hashed names.
        out = out.replace(new RegExp(MARKDOWN_LINK, 'g'), (...args) => {
            const groups = args.at(-1) as { bang: string; label: string; target: string }
            const path = normaliseRef(groups.target, ctx.sourceDir)
            const planned = ctx.assetPlan.byPath.get(path)
            if (!planned) return args[0] as string
            ctx.assetPlan.markReferenced(planned)
            return `${groups.bang}[${groups.label}](${planned.ref})`
        })

        // Image dimensions → the display-size hint. Runs AFTER the ref rewrite so it moves
        // the size onto the final reference rather than having to resolve the asset again.
        out = out.replace(LOGSEQ_IMAGE_ATTRS, (...args) => {
            const { label: alt, target: ref, attrs } = args.at(-1) as Record<string, string>
            const width = /:width\s+(\d{1,5})/.exec(attrs)?.[1]
            const height = /:height\s+(\d{1,5})/.exec(attrs)?.[1]

            // Width-less: the hint has no height-only form (`|300` / `|300x200` only), so
            // there is nothing faithful to convert to. Drop the attributes - keeping them
            // would leave visible junk AND stop the image rendering - and say so.
            if (!width) {
                if (!ctx.reportedImageSizes.has(ctx.concept)) {
                    ctx.reportedImageSizes.add(ctx.concept)
                    ctx.report.push({
                        category: 'degradation',
                        concept: ctx.concept,
                        detail: `Image attributes \`{:${attrs.trim()}}\` dropped - a display size needs a width (a height alone has no equivalent)`,
                    })
                }
                return `![${alt}](${ref})`
            }

            const spec = normalizeDisplaySize(height ? `${width}x${height}` : width)
            if (!spec) return `![${alt}](${ref})`

            // One entry per document: 2097 images on the source graph would otherwise bury
            // the rest of the report.
            if (!ctx.reportedImageSizes.has(ctx.concept)) {
                ctx.reportedImageSizes.add(ctx.concept)
                ctx.report.push({
                    category: 'degradation',
                    concept: ctx.concept,
                    detail: `Image dimensions converted to display-size hints (\`|${spec}\`); EtherPK treats these as a maximum, so a smaller image is shown at its natural size rather than enlarged`,
                })
            }
            // The alt may already carry a hint (an earlier conversion, or hand-authored);
            // the last one wins in the parser, so strip it rather than stacking `|a|b`.
            return `![${parseImageDisplaySizeHint(alt).cleanAlt}|${spec}](${ref})`
        })

        return out
    })
}

/** A task bullet already emitted, still open to metadata from its continuation lines. */
interface OpenTask {
    index: number
    indent: string
    bullet: string
    done: boolean
    tags: TaskTags
    text: string
}

/** Walk one document's body lines, applying every per-line conversion. */
function convertBody(lines: string[], ctx: InlineContext): string[] {
    const out: string[] = []
    const inFence = createFenceTracker()
    let task: OpenTask | null = null
    let logbook: { completedDate: string | null } | null = null

    const rerender = () => {
        if (task) out[task.index] = taskLine(task.indent, task.bullet, task.done, task.tags, task.text)
    }

    for (const raw of lines) {
        if (inFence(raw)) {
            out.push(raw)
            continue
        }
        const line = normaliseIndent(raw)

        // :LOGBOOK: drawers: mine the DONE date, then drop the drawer.
        if (logbook) {
            const state = /State "DONE"[^[]*\[(\d{4}-\d{2}-\d{2})/.exec(line)
            if (state) logbook.completedDate = state[1]
            if (/^\s*:END:\s*$/.test(line)) {
                if (task && task.done && logbook.completedDate) {
                    task.tags.completed = logbook.completedDate
                    rerender()
                }
                logbook = null
            }
            continue
        }
        if (/^\s*:LOGBOOK:\s*$/.test(line)) {
            logbook = { completedDate: null }
            ctx.report.push({
                category: 'drop',
                concept: ctx.concept,
                detail: 'A :LOGBOOK: drawer was dropped',
            })
            continue
        }

        // Machine-noise block properties.
        if (/^\s*(id|collapsed)::\s/.test(line)) continue

        // DEADLINE / SCHEDULED continuation lines fold into the open task's tag run.
        const dated = /^\s*(DEADLINE|SCHEDULED):\s*(.*)$/.exec(line)
        if (dated && task) {
            const iso = orgTimestampDate(dated[2])
            if (iso) {
                if (dated[1] === 'DEADLINE') task.tags.due = iso
                else task.tags.scheduled = iso
                rerender()
                continue
            }
        }

        const bullet = /^(\s*)([-*])\s+(.*)$/.exec(line)
        if (bullet) {
            const [, indent, marker, content] = bullet
            const parsed = parseLogseqTask(content)
            if (parsed) {
                const text = transformInline(parsed.text, ctx)
                task = { index: out.length, indent, bullet: marker, done: parsed.done, tags: parsed.tags, text }
                out.push(taskLine(indent, marker, parsed.done, parsed.tags, text))
            } else {
                task = null
                out.push(`${indent}${marker} ${transformInline(content, ctx)}`)
            }
            continue
        }

        if (line.trim() === '') task = null
        out.push(transformInline(line, ctx))
    }
    return out
}

export async function convertLogseq(files: SourceFile[], control?: ImportControl): Promise<ConvertedGraph> {
    const onProgress = control?.onProgress
    const report: ReportEntry[] = []
    const configFile = findFile(files, 'logseq/config.edn')
    const config = parseLogseqConfig(configFile ? await readText(configFile) : null)

    const content = contentFiles(files)
    const assetPlan = await planAssets(
        content.filter((f) => !isMarkdownPath(f.path)),
        { control },
    )

    // First pass: identity. Journals first so a date-named page defers to the journal.
    const docs: LogseqDoc[] = []
    const takenConcepts = new Set<string>()
    const takenFileNames = new Set<string>()

    const mdFiles = content.filter((f) => isMarkdownPath(f.path))
    const journalFiles = mdFiles.filter((f) => f.path.startsWith('journals/'))
    const pageFiles = mdFiles.filter((f) => !f.path.startsWith('journals/'))

    const claim = (doc: LogseqDoc) => {
        const concept = dedupeConcept(doc.concept, (key) => takenConcepts.has(key))
        if (concept !== doc.concept) {
            report.push({
                category: 'collision',
                concept,
                detail: `Concept "${doc.concept}" already exists; this document was renamed to "${concept}"`,
            })
            doc.concept = concept
            if (doc.kind === 'page') doc.fileName = `${portableFileStem(concept)}.md`
        }
        takenConcepts.add(doc.concept.toLowerCase())
        let fileName = doc.fileName
        for (let n = 2; takenFileNames.has(fileName.toLowerCase()); n++) {
            fileName = doc.fileName.replace(/\.md$/i, ` (${n}).md`)
        }
        if (fileName !== doc.fileName) {
            report.push({
                category: 'collision',
                concept: doc.concept,
                detail: `File name "${doc.fileName}" already taken; stored as "${fileName}" (frontmatter title keeps the concept)`,
            })
            doc.fileName = fileName
        }
        takenFileNames.add(doc.fileName.toLowerCase())
        docs.push(doc)
    }

    // Reading every markdown file is the long, I/O-bound opening stretch. It awaits (so it
    // never blocked), but it reported nothing at all, which on a big graph is a silent minute.
    let read = 0
    const reportRead = () => onProgress?.({ label: 'Reading files', done: ++read, total: mdFiles.length })

    for (const file of journalFiles) {
        reportRead()
        control?.signal?.throwIfAborted()
        const stem = baseName(file.path).replace(/\.md$/i, '')
        const lines = (await readText(file)).split('\n')
        const { props, body } = extractPageProps(lines)
        let iso: string | null = null
        for (const format of [config.journalFileFormat, ...FALLBACK_STEM_FORMATS]) {
            iso = logseqDateToIso(stem, format)
            if (iso) break
        }
        if (!iso) {
            report.push({
                category: 'rename',
                concept: stem,
                detail: `Journal file "${stem}.md" does not match the journal date format; imported as a page`,
            })
            claim({ kind: 'page', concept: stem, fileName: `${portableFileStem(stem)}.md`, lines: body, props, sourcePath: file.path })
            continue
        }
        if (`${iso}.md` !== baseName(file.path)) {
            report.push({
                category: 'rename',
                concept: iso,
                detail: `Journal "${stem}.md" renamed to "${iso}.md"`,
            })
        }
        claim({ kind: 'journal', concept: iso, fileName: `${iso}.md`, lines: body, props, sourcePath: file.path })
    }

    for (const file of pageFiles) {
        reportRead()
        control?.signal?.throwIfAborted()
        const stem = baseName(file.path).replace(/\.md$/i, '')
        const lines = (await readText(file)).split('\n')
        const { props, body } = extractPageProps(lines)
        const fromTitle = props.title ? pageConcept(props.title) : null
        const fromStem = pageConcept(stem)
        const { concept, namespace } = fromTitle ?? fromStem
        if (namespace) {
            report.push({
                category: 'rename',
                concept,
                detail: `Namespace page "${fromTitle ? props.title : tryDecode(stem)}" became the scoped concept "${concept}"`,
            })
        }
        claim({ kind: 'page', concept, fileName: `${portableFileStem(concept)}.md`, lines: body, props, sourcePath: file.path })
    }

    // Block-ref index: uuid → the owning bullet's cleaned first-line text + final concept.
    // Walks every line of every document with no I/O, so nothing yielded here before.
    const blockRefs = new Map<string, BlockRef>()
    let indexed = 0
    for (const doc of docs) {
        await breathe(control)
        onProgress?.({ label: 'Indexing references', done: ++indexed, total: docs.length })
        let lastBullet: string | null = null
        for (const line of doc.lines) {
            const bullet = /^\s*[-*]\s+(.*)$/.exec(line)
            if (bullet) {
                const parsed = parseLogseqTask(bullet[1])
                lastBullet = parsed ? parsed.text : bullet[1]
                continue
            }
            const id = /^\s*id::\s*([0-9a-fA-F-]{36})\s*$/.exec(line)
            if (id && lastBullet !== null) {
                blockRefs.set(id[1].toLowerCase(), { concept: doc.concept, text: lastBullet.trim() })
            }
        }
    }

    // Second pass: convert bodies and assemble file texts.
    const documents: ConvertedDocument[] = []
    const reportedNamespaces = new Set<string>()
    const reportedImageSizes = new Set<string>()
    let converted = 0
    for (const doc of docs) {
        // The loop that DID report but never yielded: without this the toast froze on the
        // first tick and jumped straight to the last.
        await breathe(control)
        onProgress?.({ label: 'Converting documents', done: ++converted, total: docs.length })
        const ctx: InlineContext = {
            concept: doc.concept,
            config,
            blockRefs,
            assetPlan,
            report,
            reportedNamespaces,
            reportedImageSizes,
            sourceDir: doc.sourcePath.includes('/') ? doc.sourcePath.slice(0, doc.sourcePath.lastIndexOf('/')) : '',
        }
        const body = convertBody(doc.lines, ctx).join('\n')

        const custom = Object.fromEntries(
            Object.entries(doc.props).filter(([key]) => !['title', 'alias', 'aliases'].includes(key)),
        )
        const aliasList = splitPropList(doc.props.aliases ?? doc.props.alias ?? '')
        let frontmatter: Record<string, unknown> = {}
        if (doc.kind === 'page') {
            frontmatter = { title: doc.concept, ...(aliasList.length ? { aliases: aliasList } : {}), ...custom }
        } else {
            if (doc.props.title !== undefined) {
                report.push({
                    category: 'drop',
                    concept: doc.concept,
                    detail: `A journal's title:: property was dropped (a journal's identity is its date)`,
                })
            }
            frontmatter = { ...(aliasList.length ? { aliases: aliasList } : {}), ...custom }
        }

        documents.push({
            kind: doc.kind,
            concept: doc.concept,
            fileName: doc.fileName,
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
