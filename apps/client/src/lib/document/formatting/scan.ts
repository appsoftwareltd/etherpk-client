/**
 * A [[Formatting Scan]] over a graph's documents (ADR 0109): list them, read each whole text,
 * skip Protected Documents, run every [[Formatting Check]], and keep one [[Formatting Issue]] per
 * check per page. Approving an issue writes its fix through a compare-and-set, then re-checks the
 * page, so every other issue on it describes the page as it now is.
 *
 * Framework-free, over an injected {@link FormattingSource}: the workspace supplies one per
 * backend, and the tests a fake.
 */

import { frontmatterLines } from '$lib/storage/fs/frontmatter-span'

import { containsCipherFence } from '../protection/fence-info'
import type { SpliceOutcome } from '../types'
import type { TextSplice } from '../wikilink/rename'
import { type FormattingCheckId, type FormattingFinding, FORMATTING_CHECKS, findIssues } from './checks'
import { lineSplices, splitLines } from './line-diff'

/** A Document as the scan lists it. */
export interface ScanDocument {
    /** The source's key for it: the docId on a synced graph, the name on a folder graph. */
    key: string
    concept: string
    kind: 'page' | 'journal'
}

/** Why a document was not checked: its text may be behind (a synced page still syncing), or could not be read. */
export type UnreadReason = 'syncing' | 'unreadable'

/** One document's text as the source read it. */
export type DocumentRead = { kind: 'text'; text: string } | { kind: 'unread'; reason: UnreadReason } | { kind: 'gone' }

/** A graph's documents as the scan reads and fixes them, whatever the backend. */
export interface FormattingSource {
    /** Documents per {@link read}: the unit of progress, and of how soon Cancel is heard. */
    chunkSize: number
    /** Every Document to check, in the order the results list them. */
    list(): Promise<readonly ScanDocument[]>
    /** The documents' whole current texts, frontmatter included. */
    read(keys: readonly string[], signal: AbortSignal): Promise<Map<string, DocumentRead>>
    /** Write `splices` (in `expected`'s offsets) only if the document still holds `expected`. */
    write(key: string, expected: string, splices: readonly TextSplice[]): Promise<SpliceOutcome>
}

/**
 * Where an issue stands. `changed`: the page changed after the scan, so the write was refused and
 * the issue now shows the diff for the page's current text. `resolved`: it changed and no longer
 * has the issue. `unconfirmed` and `failed` can be tried again.
 */
export type IssueStatus = 'pending' | 'applying' | 'fixed' | 'skipped' | 'changed' | 'resolved' | 'gone' | 'protected' | 'unconfirmed' | 'failed'

/** One check's finding on one page, as scanned: what a person approves or skips. */
export interface FormattingIssue {
    /** `${check}:${document key}`: one issue per check per page. */
    id: string
    check: FormattingCheckId
    document: ScanDocument
    /** The page's text the finding was made on, and the text a fix expects to find. */
    scannedText: string
    finding: FormattingFinding
    status: IssueStatus
    /** Why the last write failed, while `status` is `failed`. */
    error?: string
}

export interface ScanReport {
    /** Documents listed. */
    total: number
    /** Documents read and checked. */
    checked: number
    /** Protected Documents, which are not checked. */
    protectedCount: number
    /** Documents not checked, and why. */
    unread: { document: ScanDocument; reason: UnreadReason }[]
    issues: FormattingIssue[]
    /** Cancel stopped the scan before every document was read. */
    stopped: boolean
}

/** Statuses a later re-check may move on; the rest record an outcome or a decision in flight. */
const OPEN: ReadonlySet<IssueStatus> = new Set(['pending', 'changed', 'unconfirmed', 'failed'])

function issuesFor(document: ScanDocument, text: string): FormattingIssue[] {
    return findIssues(text).map(({ check, finding }) => ({
        id: `${check}:${document.key}`,
        check,
        document,
        scannedText: text,
        finding,
        status: 'pending',
    }))
}

function isAbort(error: unknown): boolean {
    return error instanceof DOMException && error.name === 'AbortError'
}

/**
 * Scan every document the source lists. Progress is reported before the first read and after
 * each chunk. Cancel (`signal`) keeps what was checked and marks the report stopped; any other
 * failure rejects.
 */
export async function scanGraph(source: FormattingSource, options: { signal: AbortSignal; onProgress?: (done: number, total: number) => void }): Promise<ScanReport> {
    const { signal, onProgress } = options
    const documents = await source.list()
    const report: ScanReport = { total: documents.length, checked: 0, protectedCount: 0, unread: [], issues: [], stopped: false }
    onProgress?.(0, documents.length)
    for (let start = 0; start < documents.length; start += source.chunkSize) {
        if (signal.aborted) {
            report.stopped = true
            break
        }
        const chunk = documents.slice(start, start + source.chunkSize)
        let reads: Map<string, DocumentRead>
        try {
            reads = await source.read(
                chunk.map((d) => d.key),
                signal,
            )
        } catch (error) {
            if (!isAbort(error)) throw error
            report.stopped = true
            break
        }
        for (const document of chunk) {
            const read = reads.get(document.key)
            if (!read || read.kind === 'gone') continue // deleted since it was listed
            if (read.kind === 'unread') {
                report.unread.push({ document, reason: read.reason })
                continue
            }
            // Stored text is ciphertext whether the document is locked or not, so the scan never
            // sees plaintext; a page with one protected region is left whole, as import leaves it.
            if (containsCipherFence(read.text)) {
                report.protectedCount++
                continue
            }
            report.checked++
            report.issues.push(...issuesFor(document, read.text))
        }
        onProgress?.(Math.min(start + chunk.length, documents.length), documents.length)
    }
    return report
}

/** Every issue on the page `key` whose status a re-check or an outcome may change. */
function openIssuesOn(issues: readonly FormattingIssue[], key: string): FormattingIssue[] {
    return issues.filter((i) => i.document.key === key && (OPEN.has(i.status) || i.status === 'skipped'))
}

/**
 * Bring a page's issues up to date with its current text: each check's issue takes the new
 * finding, becomes `resolved` when the check no longer finds anything, and a finding with no issue
 * yet is added. `refused` is the issue whose write found the page changed. An issue with a write
 * in flight is left to that write; a fixed one stays fixed unless its check finds something again.
 */
export function recheckPage(issues: FormattingIssue[], document: ScanDocument, text: string, refused?: FormattingIssue): void {
    const found = new Map(findIssues(text).map(({ check, finding }) => [check, finding]))
    for (const check of FORMATTING_CHECKS) {
        const existing = issues.find((i) => i.document.key === document.key && i.check === check.id)
        const finding = found.get(check.id)
        if (!existing) {
            if (finding) issues.push({ id: `${check.id}:${document.key}`, check: check.id, document, scannedText: text, finding, status: 'pending' })
            continue
        }
        if (existing.status === 'applying') continue
        if (!finding) {
            if (existing.status !== 'fixed') existing.status = 'resolved'
            continue
        }
        existing.scannedText = text
        existing.finding = finding
        existing.error = undefined
        if (existing === refused || existing.status === 'fixed') existing.status = 'changed'
        else if (existing.status !== 'skipped' && existing.status !== 'changed') existing.status = 'pending'
    }
}

/** Mark every issue on the page still open, or skipped, with an outcome that covers the whole page. */
function settlePage(issues: readonly FormattingIssue[], key: string, status: 'gone' | 'protected'): void {
    for (const issue of openIssuesOn(issues, key)) issue.status = status
}

/** Read the page again after a write and re-check its issues against what it now holds. */
async function refreshPage(source: FormattingSource, issues: FormattingIssue[], document: ScanDocument, refused?: FormattingIssue): Promise<void> {
    const read = (await source.read([document.key], new AbortController().signal)).get(document.key)
    if (!read || read.kind === 'gone') return settlePage(issues, document.key, 'gone')
    if (read.kind === 'unread') {
        // The page cannot be trusted as read; its issues keep their diffs, which a write will refuse
        // if they are stale. The refused one says why it has nothing new to show.
        if (refused) refused.status = 'unconfirmed'
        return
    }
    if (containsCipherFence(read.text)) return settlePage(issues, document.key, 'protected')
    recheckPage(issues, document, read.text, refused)
}

/**
 * Apply one issue's fix: a compare-and-set against the text it was scanned from, then a re-check of
 * the page. Never rejects: a failed write leaves the issue `failed` with the reason.
 */
export async function approveIssue(source: FormattingSource, issues: FormattingIssue[], issue: FormattingIssue): Promise<void> {
    const fixed = issue.finding.fixed
    if (fixed === null || !OPEN.has(issue.status)) return
    const expected = issue.scannedText
    issue.status = 'applying'
    issue.error = undefined
    let outcome: SpliceOutcome
    try {
        outcome = await source.write(issue.document.key, expected, lineSplices(expected, fixed))
    } catch (error) {
        issue.status = 'failed'
        issue.error = error instanceof Error ? error.message : String(error)
        return
    }
    switch (outcome) {
        case 'written':
            issue.status = 'fixed'
            return refreshPage(source, issues, issue.document)
        case 'changed':
            issue.status = 'pending' // back in the re-check's hands, which marks it changed or resolved
            return refreshPage(source, issues, issue.document, issue)
        case 'unconfirmed':
            issue.status = 'unconfirmed'
            return
        case 'gone':
        case 'protected':
            issue.status = 'pending'
            return settlePage(issues, issue.document.key, outcome)
    }
}

/**
 * The issue's first line as the editor's reveal counts it (`revealLine`): 0-based and below any
 * frontmatter, since the editor adds the frontmatter's lines itself. A line inside the frontmatter
 * (only a line-endings fix reaches one) is the top of the page.
 */
export function revealLineOf(issue: FormattingIssue): number {
    const frontmatter = frontmatterLines(splitLines(issue.scannedText).map((line) => line.text))
    return Math.max(0, (issue.finding.lines[0] ?? 0) - frontmatter)
}

/**
 * Approve every pending issue of one check, one at a time. Issues that changed since the scan
 * come back re-checked and are never applied blind; skipped ones are left alone.
 */
export async function approveAll(source: FormattingSource, issues: FormattingIssue[], check: FormattingCheckId): Promise<{ total: number; fixed: number; changed: number }> {
    const targets = issues.filter((i) => i.check === check && i.status === 'pending' && i.finding.fixed !== null)
    for (const target of targets) {
        // An earlier fix can have re-checked this one's page since the list was taken.
        if (target.status === 'pending') await approveIssue(source, issues, target)
    }
    return {
        total: targets.length,
        fixed: targets.filter((i) => i.status === 'fixed').length,
        changed: targets.filter((i) => i.status === 'changed').length,
    }
}
