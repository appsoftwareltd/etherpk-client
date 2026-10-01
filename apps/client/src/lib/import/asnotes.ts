/**
 * The AS Notes converter (ADR 0115). An AS Notes workspace is close to EtherPK's own format:
 * EtherPK took its task grammar (ADR 0032) and its nested wikilinks (ADR 0011) from AS Notes, and
 * AS Notes names journals by ISO date. Most text therefore passes through, and the work is where
 * the two differ:
 *
 * - Notes live in any folder and a link names a file, resolved to the closest folder when two
 *   files share a name. Folders flatten as they do for Obsidian (`folder-pages.ts`), and each link
 *   is re-pointed to the page AS Notes would have opened.
 * - AS Notes writes `/ ? < > \ : * | "` in a link target as `_` in the file name, so `[[A/B]]`
 *   opens `A_B.md`. Such a link is rewritten to the page's name.
 * - `title:` is only used when publishing in AS Notes, where EtherPK reads it as the page's name
 *   (ADR 0007). A page is named after its file, as every AS Notes link names it.
 * - Frontmatter is read line by line in AS Notes, so a block YAML rejects is read that way
 *   (`asnotes-frontmatter.ts`).
 * - Tasks accept a `*` bullet, and a few tokens are prose to AS Notes but tags to EtherPK.
 * - Kanban boards, templates, the publish setup and encrypted notes each have their own handling
 *   (`asnotes-kanban.ts`, `asnotes-layout.ts`).
 *
 * AS Notes has no pipes, fragments or embeds in its links (`[[a|b]]` targets `a_b.md`), so
 * nothing here reads Obsidian's constructs.
 */

import { MARKDOWN_LINK } from '$lib/document/markdown-link-target'
import { normaliseAliases } from '$lib/document/frontmatter/identity'
import { isJournalConcept } from '$lib/document/journal-concept'
import { parseTaskTags } from '$lib/document/task-tags'
import { parseWikilinks } from '$lib/document/wikilink'

import { type PlannedAsset, planAssets, tryDecode } from './assets'
import { readAsNotesFrontmatter } from './asnotes-frontmatter'
import { boardPageBody, readKanbanBoards } from './asnotes-kanban'
import { readAsNotesLayout } from './asnotes-layout'
import {
    buildFrontmatter,
    createFenceTracker,
    outsideInlineCode,
    readSourceFrontmatter,
    scopedConceptName,
    UNREADABLE_FRONTMATTER_DETAIL,
} from './convert-shared'
import { claimPageName, placeFolderPages, type TakenNames } from './folder-pages'
import { baseName, dirName, readText } from './source'
import { breathe, type ConvertedDocument, type ConvertedGraph, type ImportControl, type ReportEntry, type SourceFile } from './types'

interface AsNote {
    kind: 'journal' | 'page'
    concept: string
    fileName: string
    /** Root-relative source path. */
    path: string
    dir: string
    body: string
    frontmatter: Record<string, unknown>
    /** A block neither YAML nor AS Notes could read, carried over as written. */
    keptBlock?: string
    /** The block was read the AS Notes way because YAML rejected it. */
    readLeniently: boolean
    aliases: string[]
}

/** A note AS Notes indexes: `.md`, and `.markdown`, which it indexes but never finds by name. */
function isNotePath(path: string): boolean {
    return /\.(md|markdown)$/i.test(path)
}

/** The characters AS Notes replaces with `_` when it turns a link target into a file name. */
function sanitise(name: string): string {
    return name.replace(/[/?<>\\:*|"]/g, '_')
}

/** AS Notes's folder distance: steps up to the common folder, then down, ignoring case. */
function pathDistance(a: string, b: string): number {
    const as = a === '' ? [] : a.split('/')
    const bs = b === '' ? [] : b.split('/')
    let common = 0
    while (common < Math.min(as.length, bs.length) && as[common].toLowerCase() === bs[common].toLowerCase()) common++
    return as.length - common + (bs.length - common)
}

/** A file a link can name: the folder it sits in, and the concept it became here. */
interface LinkTarget {
    dir: string
    concept: string
}

/**
 * The file AS Notes opens for a name several files share: one in the linking note's own folder
 * outright, otherwise the nearest by folder distance, the first found on a tie.
 */
function closest(fromDir: string, candidates: LinkTarget[]): LinkTarget {
    const same = candidates.find((c) => c.dir === fromDir)
    if (same) return same
    let best = candidates[0]
    for (const candidate of candidates) {
        if (pathDistance(fromDir, candidate.dir) < pathDistance(fromDir, best.dir)) best = candidate
    }
    return best
}

/** A root-relative path for a markdown link's target, from the linking note's folder. */
function resolvePath(ref: string, fromDir: string): string {
    const clean = tryDecode(ref.split(/[?#]/)[0])
    // VS Code reads a leading slash as the workspace folder, which is the notes folder unless
    // AS Notes was set up in a subfolder.
    const start = clean.startsWith('/') ? [] : fromDir === '' ? [] : fromDir.split('/')
    const out = [...start]
    for (const segment of clean.split('/')) {
        if (segment === '' || segment === '.') continue
        if (segment === '..') out.pop()
        else out.push(segment)
    }
    return out.join('/')
}

/** AS Notes's alias values: a list, or one text value (never split at commas), cleaned as AS Notes cleans them. */
function asNotesAliases(value: unknown): string[] {
    const items: unknown[] = typeof value === 'string' ? [value] : Array.isArray(value) ? value : []
    return normaliseAliases(
        items
            .filter((item): item is string => typeof item === 'string')
            .map((item) => item.replace(/^["']|["']$/g, '').replace(/\[\[|\]\]/g, '')),
    )
}

/** AS Notes's leading tag run (its `parseTaskMeta`): what follows it, which AS Notes shows as the task's text. */
function asNotesTaskText(label: string): string {
    const tag = /^(#P[123]|#W|#D-\d{4}-\d{2}-\d{2}|#C-\d{4}-\d{2}-\d{2})\s*/
    let remaining = label.trimStart()
    for (let match = tag.exec(remaining); match; match = tag.exec(remaining)) remaining = remaining.slice(match[0].length)
    return remaining
}

const STAR_TASK = /^(\s*)\*(\s+\[[ xX]\])/
const TASK = /^\s*-\s+\[[ xX]\]\s?(.*)$/
const RETINA = /\s*\{\.retina\}\s*/g

export async function convertAsNotes(files: SourceFile[], control?: ImportControl): Promise<ConvertedGraph> {
    const onProgress = control?.onProgress
    const report: ReportEntry[] = []
    const layout = await readAsNotesLayout(files, report)
    const { boards, consumed } = await readKanbanBoards(layout.files)

    const noteFiles = layout.files.filter((f) => isNotePath(f.path) && !consumed.has(f.path))
    const assetPlan = await planAssets(
        layout.files.filter((f) => !isNotePath(f.path) && !consumed.has(f.path)),
        { control },
    )

    // ---- Read every note and sort it: journal-folder journals, other day-named notes, templates, pages.
    interface Pending {
        path: string
        stem: string
        dir: string
        segments: string[]
        body: string
        frontmatter: Record<string, unknown>
        keptBlock?: string
        readLeniently: boolean
        aliases: string[]
    }
    const inJournalFolder: Array<{ note: Pending; iso: string }> = []
    const dayNamed: Array<{ note: Pending; iso: string }> = []
    const templates: Pending[] = []
    const pages: Pending[] = []
    const journalFolder = layout.journalFolder.toLowerCase()
    const templateFolder = layout.templateFolder.toLowerCase()

    let read = 0
    for (const file of noteFiles) {
        control?.signal?.throwIfAborted()
        onProgress?.({ label: 'Reading files', done: ++read, total: noteFiles.length })
        const stem = baseName(file.path).replace(/\.(md|markdown)$/i, '')
        const dir = dirName(file.path)
        const source = readSourceFrontmatter(await readText(file))
        let frontmatter = source.data
        let keptBlock: string | undefined
        let readLeniently = false
        if (source.kind === 'unreadable') {
            const lenient = readAsNotesFrontmatter(source.yaml)
            if (lenient) {
                frontmatter = lenient
                readLeniently = true
            } else {
                keptBlock = source.block
            }
        }
        const note: Pending = {
            path: file.path,
            stem,
            dir,
            segments: dir === '' ? [] : dir.split('/'),
            body: source.body,
            frontmatter,
            keptBlock,
            readLeniently,
            aliases: asNotesAliases(frontmatter.aliases),
        }
        const folder = dir.toLowerCase()
        // Journals before AS Notes renamed them were `YYYY_MM_DD.md`; it has a command that renames them.
        const iso = stem.replace(/^(\d{4})_(\d{2})_(\d{2})$/, '$1-$2-$3')
        if (folder === journalFolder && isJournalConcept(iso)) inJournalFolder.push({ note, iso })
        else if (isJournalConcept(stem)) dayNamed.push({ note, iso: stem })
        else if (folder === templateFolder || folder.startsWith(`${templateFolder}/`)) templates.push(note)
        else pages.push(note)
    }

    const notes: AsNote[] = []
    const taken: TakenNames = { concepts: new Set(), fileNames: new Set() }
    const toNote = (pending: Pending, kind: AsNote['kind'], concept: string, fileName: string): AsNote => ({
        kind,
        concept,
        fileName,
        path: pending.path,
        dir: pending.dir,
        body: pending.body,
        frontmatter: pending.frontmatter,
        keptBlock: pending.keptBlock,
        readLeniently: pending.readLeniently,
        aliases: pending.aliases,
    })

    // ---- Identity. Journals first, so a page can never take a day's own name from it, and the
    // journal folder's before any other note named for a day.
    for (const { note, iso } of [...inJournalFolder, ...dayNamed]) {
        if (taken.concepts.has(iso)) {
            report.push({
                category: 'collision',
                concept: iso,
                detail: `More than one note is named for ${iso} - "${note.path}" was imported as a page`,
            })
            pages.push(note)
            continue
        }
        taken.concepts.add(iso)
        taken.fileNames.add(`${iso}.md`)
        notes.push(toNote(note, 'journal', iso, `${iso}.md`))
        // Only an older `YYYY_MM_DD.md` in the journal folder has a name that is not its day.
        if (note.stem !== iso) {
            report.push({ category: 'rename', concept: iso, detail: `Journal "${note.path}" renamed to "${iso}.md"` })
        }
    }
    // Templates hold placeholders such as `{{date}}` and EtherPK has no templates, so each is kept
    // as a page under one scope, where it cannot take the name of the note it was a template for.
    for (const note of templates) {
        const { concept, fileName } = claimPageName(scopedConceptName(['Templates', note.stem]), taken)
        notes.push(toNote(note, 'page', concept, fileName))
        report.push({ category: 'rename', concept, detail: `AS Notes template "${note.path}" imported as a page. EtherPK has no templates.` })
    }
    for (const { page, concept, fileName } of placeFolderPages(pages, taken, report)) {
        notes.push(toNote(page, 'page', concept, fileName))
    }
    const boardPages = boards.map((board) => ({ board, ...claimPageName(scopedConceptName([board.name, 'Kanban']), taken) }))

    // ---- Link resolution. AS Notes looks a link up by file name first and by alias only when no
    // file has the name. A link that finds its note by alias keeps working unchanged, because the
    // note keeps its aliases, so only file names are indexed here.
    const byFileName = new Map<string, LinkTarget[]>()
    const addTarget = (fileName: string, target: LinkTarget) => {
        const key = fileName.toLowerCase()
        byFileName.set(key, [...(byFileName.get(key) ?? []), target])
    }
    const byPath = new Map<string, AsNote>()
    for (const note of notes) {
        byPath.set(note.path.toLowerCase(), note)
        // Only `.md` files are found by name: AS Notes looks a link up as `<name>.md`.
        if (/\.md$/i.test(note.path)) addTarget(baseName(note.path), { dir: note.dir, concept: note.concept })
    }
    // A link to a card file now leads to its board's page.
    for (const { board, concept } of boardPages) {
        for (const card of board.cards) addTarget(`${card.id}.md`, { dir: dirName(card.path), concept })
    }

    // ---- Body conversion.
    const convertText = (text: string, fromDir: string, concept: string): string => {
        const inFence = createFenceTracker()
        let starTasks = 0
        let retina = false
        const out: string[] = []
        for (const raw of text.split('\n')) {
            if (inFence(raw)) {
                out.push(raw)
                continue
            }
            let line = raw
            // EtherPK reads a task only after a `-` bullet; AS Notes also reads one after `*`.
            if (STAR_TASK.test(line)) {
                line = line.replace(STAR_TASK, '$1-$2')
                starTasks++
            }
            const task = TASK.exec(line)
            if (task) {
                // AS Notes stops its tag run at the first token it does not know, so `#D` or
                // `#S-...` after its tags is text there and a tag here. The text is left alone,
                // because rewriting it would guess at what the person meant.
                const asNotesText = asNotesTaskText(task[1])
                const etherpkText = parseTaskTags(task[1]).text
                if (etherpkText.length < asNotesText.length) {
                    const extra = asNotesText.slice(0, asNotesText.length - etherpkText.length).trim()
                    const many = extra.includes(' ')
                    report.push({
                        category: 'degradation',
                        concept,
                        detail: `Task "${task[1]}" - EtherPK reads ${extra} as ${many ? 'task tags' : 'a task tag'}, where AS Notes read ${many ? 'them' : 'it'} as text`,
                    })
                }
            }
            line = outsideInlineCode(line, (segment) => {
                let converted = rewriteWikilinks(segment, fromDir)
                const links = new RegExp(MARKDOWN_LINK, 'g')
                converted = converted.replace(links, (...args) => {
                    const all = args[0] as string
                    const { bang, label: rawLabel, target: ref } = args.at(-1) as Record<string, string>
                    if (/^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith('#')) return all
                    let label = rawLabel
                    if (bang && label.includes('{.retina}')) {
                        label = label.replace(RETINA, ' ').trim()
                        retina = true
                    }
                    const path = resolvePath(ref, fromDir)
                    const asset = assetPlan.byPath.get(path) ?? assetPlan.byPath.get(resolvePath(ref, ''))
                    if (asset) {
                        assetPlan.markReferenced(asset)
                        return `${bang}[${label}](${asset.ref})`
                    }
                    const note = isNotePath(path) ? byPath.get(path.toLowerCase()) : undefined
                    if (note && !bang) return labelledLink(label, note, ref, concept)
                    return label === rawLabel ? all : `${bang}[${label}](${ref})`
                })
                return converted
            })
            out.push(line)
        }
        if (starTasks > 0) {
            report.push({
                category: 'degradation',
                concept,
                detail:
                    starTasks === 1
                        ? '1 task written with a * bullet now uses -, which EtherPK needs to read it as a task'
                        : `${starTasks} tasks written with a * bullet now use -, which EtherPK needs to read them as tasks`,
            })
        }
        if (retina) {
            report.push({
                category: 'degradation',
                concept,
                detail: 'Retina image marker `{.retina}` removed. EtherPK sizes an image by a width in its alt text, such as `![alt|300](...)`',
            })
        }
        return out.join('\n')
    }

    /**
     * Re-point each link that is not part of a nested link. A nested link (`[[Outer [[Inner]] text]]`)
     * names a file whose name is the same text, which EtherPK reads as a scoped concept, so it is
     * already right.
     */
    function rewriteWikilinks(segment: string, fromDir: string): string {
        const links = parseWikilinks(segment)
        const standalone = links.filter(
            (link) => !links.some((other) => other !== link && other.start <= link.end && link.start <= other.end),
        )
        let out = segment
        for (const link of standalone.reverse()) {
            const concept = resolveLink(link.concept, fromDir)
            if (concept === null || concept.toLowerCase() === link.concept.toLowerCase()) continue
            out = `${out.slice(0, link.start)}[[${concept}]]${out.slice(link.end + 1)}`
        }
        return out
    }

    /** The concept of the file a link opens in AS Notes by name, or null (no such file, or found by an alias). */
    function resolveLink(target: string, fromDir: string): string | null {
        const candidates = byFileName.get(`${sanitise(target)}.md`.toLowerCase())
        return candidates && candidates.length > 0 ? closest(fromDir, candidates).concept : null
    }

    /** `[label](Note.md)` as a wikilink: the label alone when it names the note, beside it otherwise. */
    function labelledLink(label: string, note: AsNote, ref: string, fromConcept: string): string {
        const names = [note.concept, ...note.aliases].map((n) => n.toLowerCase())
        if (names.includes(label.toLowerCase())) return `[[${label}]]`
        report.push({
            category: 'degradation',
            concept: fromConcept,
            detail: `Link \`[${label}](${ref})\` became "${label} ([[${note.concept}]])"`,
        })
        return `${label} ([[${note.concept}]])`
    }

    // ---- Documents.
    const documents: ConvertedDocument[] = []
    const total = notes.length + boardPages.length
    let converted = 0
    for (const note of notes) {
        await breathe(control)
        onProgress?.({ label: 'Converting documents', done: ++converted, total })
        const body = convertText(note.body, note.dir, note.concept)
        if (note.keptBlock !== undefined) {
            report.push({ category: 'unsupported', concept: note.concept, detail: UNREADABLE_FRONTMATTER_DETAIL })
            documents.push({ kind: note.kind, concept: note.concept, fileName: note.fileName, text: `${note.keptBlock}${body}` })
            continue
        }
        if (note.readLeniently) {
            report.push({
                category: 'degradation',
                concept: note.concept,
                detail: 'Frontmatter is not valid YAML. It was read the way AS Notes reads it and written back as valid YAML.',
            })
        }
        const data = { ...note.frontmatter }
        if ('aliases' in data) {
            if (note.aliases.length > 0) data.aliases = note.aliases
            else delete data.aliases
        }
        const { title, ...rest } = data
        if (typeof title === 'string' && title.trim() !== '' && title !== note.concept) {
            report.push({
                category: 'degradation',
                concept: note.concept,
                detail: `Frontmatter title "${title}" replaced by the page's name "${note.concept}" (AS Notes links name the file, and the title was only used when publishing)`,
            })
        }
        const frontmatter = note.kind === 'page' ? { title: note.concept, ...rest } : rest
        documents.push({ kind: note.kind, concept: note.concept, fileName: note.fileName, text: `${buildFrontmatter(frontmatter)}${body}` })
    }

    for (const { board, concept, fileName } of boardPages) {
        await breathe(control)
        onProgress?.({ label: 'Converting documents', done: ++converted, total })
        const cardFile = (card: { path: string; id: string }, name: string): PlannedAsset | null =>
            assetPlan.byPath.get(`kanban/${board.slug}/assets/${card.id}/${name}`) ?? null
        const body = boardPageBody(
            board,
            concept,
            (text, card) => convertText(text, dirName(card.path), concept),
            cardFile,
            (planned) => assetPlan.markReferenced(planned),
            report,
        )
        documents.push({ kind: 'page', concept, fileName, text: `${buildFrontmatter({ title: concept })}${body}` })
    }

    for (const asset of assetPlan.assets.filter((a) => a.unreferenced)) {
        report.push({ category: 'unreferenced', detail: `Asset "${asset.fileName}" is referenced by no document (imported anyway)` })
    }

    return { documents, assets: assetPlan.assets, report }
}
