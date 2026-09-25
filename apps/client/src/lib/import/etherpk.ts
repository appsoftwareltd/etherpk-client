/**
 * The EtherPK converter: an Export / Local Mirror / Filesystem-Backend folder is
 * already the destination format, so documents and assets copy verbatim - this is the
 * backend-migration path ADR 0007 promised. Graph Settings travel too (CONTEXT.md →
 * [[Graph Settings]] are part of the graph's content).
 */

import { type QuickNote, sanitizeQuickNotes } from '$lib/document/quick-notes'
import { parseDictionaryFile } from '$lib/document/spelling/graph-dictionary'
import type { GraphTheme } from '$lib/document/publish/theme/graph-theme'
import { parseGraphThemeFile, themeIdOfFileName } from '$lib/storage/fs/theme-files'
import { conceptOf, fileStem, journalConceptOf } from '$lib/storage/fs/identity'
import { parseFrontmatter } from '$lib/storage/fs/frontmatter'
import { isJournalConcept } from '$lib/document/journal-concept'
import { withFrontmatterIdentity } from '$lib/document/frontmatter/identity'
import { portableFileStem } from '$lib/document/wikilink'

import { planAssets } from './assets'
import { dedupeConcept } from './convert-shared'
import { baseName, contentFiles, findFile, isMarkdownPath, readText } from './source'
import { containsCipherFence } from '$lib/document/protection/fence-info'
import { PROTECTION_FILE } from '$lib/document/protection/protection-store'
import { ProtectionRecordFormatError, parseProtectionRecord, type ProtectionRecord } from '$lib/crypto'
import { AGENTS_MD_FILE, CLAUDE_MD_FILE } from '$lib/storage/fs/agents-md'

import { breathe, type ConvertedDocument, type ConvertedGraph, type ImportControl, type ReportEntry, type SourceFile } from './types'

/**
 * The root AGENTS.md and CLAUDE.md are the Filesystem Backend's own (fs/agents-md.ts), not
 * content: the graph this lands in writes fresh ones on its first open, and the user's notes in
 * them are about the folder they came from. Silently skipped, like etherpk/.
 */
const AGENT_INSTRUCTION_FILES = new Set([AGENTS_MD_FILE, CLAUDE_MD_FILE])

export async function convertEtherpk(files: SourceFile[], control?: ImportControl): Promise<ConvertedGraph> {
    const onProgress = control?.onProgress
    const report: ReportEntry[] = []
    const content = contentFiles(files)

    const documents: ConvertedDocument[] = []
    const strayMd: SourceFile[] = []
    const mdFiles = content.filter((f) => isMarkdownPath(f.path) && !AGENT_INSTRUCTION_FILES.has(f.path))

    // Two documents can want one identity, and a folder assembled by hand (or by a mirror that
    // had to suffix a colliding file name) is where that arrives. Claiming is what the Logseq and
    // Obsidian converters already do; without it the second document simply replaced the first
    // once the graph was built, which is a silent loss of a page.
    const takenConcepts = new Set<string>()
    const takenFileNames = new Set<string>()
    function claim(doc: ConvertedDocument): void {
        const concept = dedupeConcept(doc.concept, (key) => takenConcepts.has(key))
        if (concept !== doc.concept) {
            report.push({
                category: 'collision',
                concept,
                detail: `Concept "${doc.concept}" already exists; this document was imported as "${concept}"`,
            })
            doc.fileName = `${portableFileStem(concept)}.md`
            doc.concept = concept
            // The rename is real, so the block has to agree with it. A [[Filesystem Backend]]
            // reads identity out of the text and nowhere else (ADR 0007), so leaving the old
            // title there would put both documents back under one concept and shadow one of them.
            if (doc.kind === 'page') {
                doc.text = withFrontmatterIdentity(doc.text, { title: concept }, { addBlock: true })
            }
        }
        takenConcepts.add(doc.concept.toLowerCase())
        const dir = doc.kind === 'journal' ? 'journals' : 'pages'
        let fileName = doc.fileName
        for (let n = 2; takenFileNames.has(`${dir}/${fileName.toLowerCase()}`); n++) {
            fileName = `${fileStem(doc.fileName)} (${n}).md`
        }
        if (fileName !== doc.fileName) {
            report.push({
                category: 'collision',
                concept: doc.concept,
                detail: `File name "${doc.fileName}" already taken; stored as "${fileName}" (frontmatter title keeps the concept)`,
            })
            doc.fileName = fileName
        }
        takenFileNames.add(`${dir}/${doc.fileName.toLowerCase()}`)
        documents.push(doc)
    }

    // Journals first, so a page can never take a day's own name from it.
    const journalFiles: Array<{ file: SourceFile; name: string }> = []
    const pageFiles: Array<{ file: SourceFile; name: string }> = []
    for (const file of mdFiles) {
        const name = baseName(file.path)
        if (file.path === `journals/${name}`) journalFiles.push({ file, name })
        else if (file.path === `pages/${name}`) pageFiles.push({ file, name })
        else strayMd.push(file)
    }

    let converted = 0
    for (const { file, name } of journalFiles) {
        // EtherPK sources pass through nearly untouched, so this one loop is both the read
        // and the convert pass - it awaits per file but reported against no yield budget.
        await breathe(control)
        onProgress?.({ label: 'Converting documents', done: ++converted, total: mdFiles.length })
        const text = await readText(file)
        const stem = journalConceptOf(name)
        if (isJournalConcept(stem)) {
            claim({ kind: 'journal', concept: stem, fileName: name, text })
            continue
        }
        // A day is a Journal Entry's whole identity (ADR 0056), so a file in `journals/` that is
        // not named after one cannot be a journal. A [[Local Mirror]] writes exactly this when a
        // graph holds two entries for one day: the second file carries the day as its title and
        // arrives here as a page, which is the same answer the Obsidian converter gives.
        const concept = conceptOf(parseFrontmatter(text), stem)
        report.push({
            category: 'collision',
            concept,
            detail: `"${file.path}" is not named after a calendar day, so it was imported as a page`,
        })
        claim({ kind: 'page', concept, fileName: `${portableFileStem(concept)}.md`, text })
    }
    for (const { file, name } of pageFiles) {
        await breathe(control)
        onProgress?.({ label: 'Converting documents', done: ++converted, total: mdFiles.length })
        const text = await readText(file)
        claim({ kind: 'page', concept: conceptOf(parseFrontmatter(text), fileStem(name)), fileName: name, text })
    }
    for (const file of strayMd) {
        const stem = fileStem(baseName(file.path))
        report.push({
            category: 'rename',
            concept: stem,
            detail: `"${file.path}" is outside journals/ and pages/; imported as a page`,
        })
        claim({ kind: 'page', concept: stem, fileName: baseName(file.path), text: await readText(file) })
    }

    // The copier's passphrase-wrapped Protection Key record travels with a copy of the graph
    // (ADR 0093), so its protected documents open here with the passphrase they had. A record
    // this build cannot read is reported and dropped: the documents still arrive, as ciphertext,
    // and nothing invents a key for them.
    let protection: ProtectionRecord | undefined
    const protectionFile = findFile(content, `etherpk/${PROTECTION_FILE}`)
    if (protectionFile) {
        try {
            protection = parseProtectionRecord(await readText(protectionFile))
        } catch (error) {
            const why =
                error instanceof ProtectionRecordFormatError && error.problem === 'newer-version'
                    ? 'was written by a newer EtherPK than this one'
                    : 'is malformed'
            report.push({
                category: 'unsupported',
                detail: `etherpk/${PROTECTION_FILE} ${why}, so it was not carried over and protected documents stay unreadable here (${(error as Error).message})`,
            })
        }
    }

    // Protected content passes through byte-for-byte - the fence IS the ciphertext, so an import
    // neither can nor needs to touch it. What it must not do is stay quiet (ADR 0057,
    // [[2026-09-06 Protected Documents]]): with the record beside it the content opens with the
    // passphrase of the graph it came from, and without one it is permanently unreadable here.
    for (const doc of documents) {
        if (!containsCipherFence(doc.text)) continue
        report.push({
            category: 'unsupported',
            concept: doc.concept,
            detail: protection
                ? 'holds protected content, imported unchanged as ciphertext together with the graph’s protection record. Unlock it with the passphrase of the graph it came from.'
                : 'holds protected content, imported unchanged as ciphertext. It stays unreadable until you supply the passphrase of the graph it came from - this graph’s Protection Key will not open it.',
        })
    }

    // Assets keep their names - they already follow the naming convention, and the
    // documents' `../assets/...` references stay valid without any rewriting. The
    // etherpk/ dir is app-internal: settings.json is read below, the rest is skipped.
    const assetFiles = content.filter((f) => !isMarkdownPath(f.path) && !f.path.startsWith('etherpk/'))
    const assetPlan = await planAssets(assetFiles, { verbatim: true, control })
    for (const planned of assetPlan.byPath.values()) {
        if (documents.some((d) => d.text.includes(planned.asset.fileName))) {
            assetPlan.markReferenced(planned)
        }
    }
    for (const asset of assetPlan.assets.filter((a) => a.unreferenced)) {
        report.push({
            category: 'unreferenced',
            detail: `Asset "${asset.fileName}" is referenced by no document (imported anyway)`,
        })
    }

    let settings: Record<string, unknown> | undefined
    const settingsFile = findFile(content, 'etherpk/settings.json')
    if (settingsFile) {
        try {
            const parsed = JSON.parse(await readText(settingsFile)) as unknown
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                settings = parsed as Record<string, unknown>
            }
        } catch {
            report.push({
                category: 'unsupported',
                detail: 'etherpk/settings.json is malformed; Graph Settings were not carried over',
            })
        }
    }

    // Quick Notes are graph content too (ADR 0078): an export made mid-week must not drop
    // the three notes not yet moved to a journal. Malformed entries are dropped by the
    // sanitiser; a malformed file is reported like a malformed settings file.
    let quickNotes: QuickNote[] | undefined
    const quickNotesFile = findFile(content, 'etherpk/quick-notes.json')
    if (quickNotesFile) {
        try {
            quickNotes = sanitizeQuickNotes(JSON.parse(await readText(quickNotesFile)))
        } catch {
            report.push({
                category: 'unsupported',
                detail: 'etherpk/quick-notes.json is malformed; Quick Notes were not carried over',
            })
        }
    }

    // The Graph Dictionary is graph content too (ADR 0095): the words its members added. A line
    // that is not one word is skipped by the parser rather than failing the import.
    const dictionaryFile = findFile(content, 'etherpk/dictionary.txt')
    const spellingDictionary = dictionaryFile ? parseDictionaryFile(await readText(dictionaryFile)) : []

    // Themes are graph content too (ADR 0082): one `etherpk/theme-<id>.jsonc` each. A malformed
    // file, or one whose json names another id, is reported and skipped.
    const themes: GraphTheme[] = []
    for (const file of content) {
        const name = file.path.startsWith('etherpk/') ? file.path.slice('etherpk/'.length) : null
        const id = name === null || name.includes('/') ? null : themeIdOfFileName(name)
        if (id === null) continue
        const theme = parseGraphThemeFile(await readText(file), id)
        if (theme) themes.push(theme)
        else report.push({ category: 'unsupported', detail: `${file.path} is malformed or does not hold the theme its name says; it was not carried over` })
    }

    return {
        documents,
        assets: assetPlan.assets,
        settings,
        ...(quickNotes ? { quickNotes } : {}),
        ...(spellingDictionary.length > 0 ? { spellingDictionary } : {}),
        ...(themes.length > 0 ? { themes } : {}),
        ...(protection ? { protection } : {}),
        report,
    }
}
