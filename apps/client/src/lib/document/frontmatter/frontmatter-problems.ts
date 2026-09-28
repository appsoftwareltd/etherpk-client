/**
 * What is wrong with a document's [[Frontmatter]], line by line, for the editor to mark (ADR 0108).
 *
 * Two kinds of problem. A block that does not parse is an **error**: EtherPK reads none of it,
 * so a `public: true` in it publishes nothing. A key EtherPK reads that holds something it cannot
 * use is a **warning**: the rest of the block still counts. The publishing keys are judged by the
 * publisher's own readers (`publish/publication.ts`), so the editor and the Publish report can
 * never disagree about the same line. An empty value is never a problem: it means not set yet.
 *
 * Pure: the editor's plugin decides when to show these.
 */
import { frontmatterSpan } from '$lib/storage/fs/frontmatter-span'

import { explicitSlugOf } from '../publish/slugs'
import { readMembership, readPageDate, readPublicationDefinition } from '../publish/publication'
import type { PublishIssue } from '../publish/types'
import { frontmatterData, frontmatterParseProblem, isEmptyValue } from './frontmatter-yaml'

export interface FrontmatterProblem {
    /** 0-based line in the document (the opening `---` is line 0). */
    line: number
    level: 'error' | 'warning'
    /** A sentence for the person, `code` spans in backticks. */
    message: string
}

/** The parser's reasons in words a person reads, for the codes a hand-edited block hits most. */
function parseMessage(code: string, message: string): string {
    switch (code) {
        case 'TAB_AS_INDENT':
            return 'A tab indents this line, and YAML needs spaces.'
        case 'DUPLICATE_KEY':
            return 'This key appears twice; a key can appear only once.'
        case 'BAD_INDENT':
        case 'BLOCK_AS_IMPLICIT_KEY':
        case 'MISSING_CHAR':
        case 'MULTILINE_IMPLICIT_KEY':
            return `This line is not a \`key: value\` pair at the indent the lines around it use. (${message.replace(/\.$/, '')}.)`
        default:
            return message
    }
}

/**
 * The block line a problem belongs on: the line naming `path` (`publication.kind` is the `kind:`
 * line under `publication:`), falling back to its parent's line. 0-based in the document.
 */
function lineOf(blockLines: readonly string[], path: string): number | null {
    const [top, ...rest] = path.split('.')
    const start = blockLines.findIndex((line, i) => i > 0 && line.startsWith(`${top}:`))
    if (start < 0) return null
    if (rest.length === 0) return start
    for (let i = start + 1; i < blockLines.length - 1; i++) {
        if (!/^\s/.test(blockLines[i])) break
        if (new RegExp(`^\\s+${rest[0]}:`).test(blockLines[i])) return i
    }
    return start
}

/** Which key a publisher issue is about, by its code. */
function pathOf(code: string): string {
    const paths: Record<string, string> = {
        'public-not-a-boolean': 'public',
        'publications-not-a-list': 'publications',
        'publications-invalid-id': 'publications',
        'publication-missing-id': 'publication.id',
        'publication-invalid-id': 'publication.id',
        'publication-invalid-kind': 'publication.kind',
        'publication-invalid-selection': 'publication.selection',
        'publication-invalid-url': 'publication.url',
        'publication-invalid-home': 'publication.home',
        'publication-invalid-theme': 'publication.theme',
        'publication-invalid-recent': 'publication.recent',
        'publication-invalid-includes': 'publication.includes',
        'publication-invalid-include': 'publication.includes',
        'invalid-date': 'date',
    }
    return paths[code] ?? 'publication'
}

export function frontmatterProblems(text: string, kind: 'page' | 'journal', concept = ''): FrontmatterProblem[] {
    const span = frontmatterSpan(text)
    if (!span) return []
    const data = frontmatterData(span.body)
    if (data === null) {
        const problem = frontmatterParseProblem(span.body)
        const reason = problem ? parseMessage(problem.code, problem.message) : 'The block does not parse.'
        return [{ line: 1 + (problem?.line ?? 0), level: 'error', message: `${reason} EtherPK ignores the whole block until this is fixed.` }]
    }

    const blockLines = text.slice(0, span.end).split('\n')
    const problems: FrontmatterProblem[] = []
    const add = (path: string, level: FrontmatterProblem['level'], message: string) => {
        const line = lineOf(blockLines, path)
        if (line !== null) problems.push({ line, level, message })
    }
    const fromPublisher = (issues: readonly PublishIssue[]) => {
        for (const issue of issues) add(pathOf(issue.code), issue.level === 'error' ? 'error' : 'warning', issue.message)
    }

    const doc = { concept, kind, text, aliases: [] }
    fromPublisher(readMembership(text, concept).issues)
    if (kind === 'page') {
        fromPublisher(readPublicationDefinition(doc).issues)
        fromPublisher(readPageDate(doc).issues)
    }
    if (!isEmptyValue(data.slug) && explicitSlugOf(text) === null) {
        add('slug', 'warning', '`slug` has no letters or digits to make an address from, so the document keeps the address its name gives it.')
    }
    if (!isEmptyValue(data.aliases) && !Array.isArray(data.aliases)) {
        add('aliases', 'warning', '`aliases` must be a list, one name per line (`  - Name`); a single value is ignored.')
    }
    if (kind === 'journal' && !isEmptyValue(data.title)) {
        add('title', 'warning', 'A journal entry is named by its date, so `title` changes nothing here.')
    }
    return problems.sort((a, b) => a.line - b.line)
}
