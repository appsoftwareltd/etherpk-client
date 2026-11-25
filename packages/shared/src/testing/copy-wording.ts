/**
 * Holds the words a person reads to the parts of the style guide's Copy rules that a scan can
 * check. A rendered page is not read: this is the source, and the Markdown of docs and posts.
 *
 * Three rules fail a test ({@link findCopyViolations}):
 *
 *   - `computer`: the place EtherPK runs is a device, and a phone is one. Where a phone is ruled
 *     out the word is desktop.
 *   - `make`: a token, key, code, graph, page, document, folder, account, copy or task is created.
 *   - `retired-term`: a name the interface no longer uses, with the name that replaced it.
 *
 * One more only warns ({@link findUnclearReferences}): a pronoun that could point at more than one
 * thing ("one of them", "after it", "This is kept …"). It is a guess from the words alone, so it
 * is shown to the writer and never fails anything.
 *
 * Both are lexical, not parsers. In code they read every line that is not a comment, as a rule
 * word is rare in an identifier. A comment reading `copy-exempt: <reason>` on the line, or the
 * line above, excuses that line; Markdown has no comment a reader does not see, so its exceptions
 * are passed in as `ignore` patterns.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join } from 'node:path'

export type CopyRule = 'computer' | 'make' | 'retired-term'

export interface CopyViolation {
    file: string
    line: number
    rule: CopyRule
    /** The offending words, as written. */
    excerpt: string
    /** What to write instead. */
    fix: string
}

export interface CopyWarning {
    file: string
    line: number
    /** The sentence or phrase the warning is about. */
    excerpt: string
    reason: string
}

export interface CopyScanOptions {
    /** The rules to hold. All three when left out. */
    rules?: readonly CopyRule[]
    /** Text that is not copy, such as an address: every match is skipped. Give each the `g` flag. */
    ignore?: readonly RegExp[]
}

export interface CopyPassage {
    line: number
    text: string
}

const CODE_EXTENSIONS = new Set(['.ts', '.js', '.mjs', '.svelte'])
const MARKDOWN_EXTENSION = '.md'
const EXEMPT = /copy-exempt:/

/** Addresses that keep an old word because pages outside the repository link to them. */
const KEPT_ADDRESSES: readonly RegExp[] = [/running-etherpk-on-your-own-computer/g]

/**
 * A name the interface no longer uses, and the one to write. The older name for a Folder Graph is
 * not here: scripts/repository-rules.test.mjs refuses it in all tracked text.
 */
export const RETIRED_TERMS: readonly { pattern: RegExp; now: string }[] = [
    // A capital P only: "the Graphs page marks them" is plain English.
    { pattern: /\bPage [Mm]arks?\b/g, now: 'PDF Bookmarks' },
    { pattern: /\bcopy task reference\b/gi, now: 'Copy agent instruction' },
    { pattern: /\bgraph sidebar\b/gi, now: 'Explorer' },
    { pattern: /(?<![a-z])book bookmarks\b/gi, now: 'EBook Bookmarks' },
    { pattern: /\bReplace Encryption Keys and lock out other\s+devices\b/gi, now: 'Replace Encryption Keys' },
]

const RESOURCES = 'tokens?|keys?|codes?|graphs?|pages?|documents?|folders?|accounts?|cop(?:y|ies)|tasks?'

/** What follows a resource that was created: the clause ends, or goes on to say where, how or why. */
const CREATED = '(?=[ \\t]*(?:[.,;:)<…|"\']|\\n\\s*\\n|$|\\s*(?:on|in|for|with|from|by|at|and|or|to|there|here|afterwards|first|when|that|which|so|since|because)\\b))'

const RULES: readonly { rule: CopyRule; pattern: RegExp; fix: string }[] = [
    {
        rule: 'computer',
        pattern: /\bcomputers?\b/gi,
        fix: 'say "device" for where EtherPK runs, or "desktop" where a phone is ruled out',
    },
    {
        rule: 'make',
        // At least one determiner, so "make sure the page loads" is not read as making a page. The
        // words after the resource tell creating from changing: "makes a page, and" creates one,
        // "makes the page public" and "makes a task Done" do not.
        pattern: new RegExp(`\\b(?:mak(?:e|es|ing)|made)\\s+(?:(?:a|an|the|new|another|your)\\s+)+(?:[\\w-]+\\s+)?(?:${RESOURCES})\\b${CREATED}`, 'gi'),
        fix: 'say "create" for a token, key, code, graph, page, document, folder, account, copy or task',
    },
    ...RETIRED_TERMS.map(({ pattern, now }) => ({ rule: 'retired-term' as const, pattern, fix: `say "${now}"` })),
]

/** The match with every character but a line break turned to a space, so positions still hold. */
function blank(match: string): string {
    return match.replace(/[^\n]/g, ' ')
}

function isMarkdown(file: string): boolean {
    return extname(file) === MARKDOWN_EXTENSION
}

/** Source with its comments blanked: block, HTML, and a `//` comment at a line's start or end. */
export function readableCode(source: string): string {
    return source
        .replace(/\/\*[\s\S]*?\*\//g, blank)
        .replace(/<!--[\s\S]*?-->/g, blank)
        .replace(/(^|\s)\/\/(?:\s.*)?$/gm, blank)
}

/** Frontmatter with every line blanked but `title:` and `description:`, which a reader sees. */
function readableFrontmatter(block: string): string {
    return block
        .split('\n')
        .map((line) => (/^(?:title|description):/.test(line) ? line : blank(line)))
        .join('\n')
}

/** Markdown with what is not prose blanked: most frontmatter, code, link targets and addresses. */
export function readableMarkdown(source: string): string {
    return source
        .replace(/^---\n[\s\S]*?\n---(?=\n|$)/, readableFrontmatter)
        .replace(/^(`{3,})[^\n]*\n[\s\S]*?\n\1[ \t]*$/gm, blank)
        .replace(/<!--[\s\S]*?-->/g, blank)
        .replace(/`[^`\n]*`/g, blank)
        .replace(/\]\([^)\n]*\)/g, (target) => `]${blank(target.slice(1))}`)
        .replace(/\bhttps?:\/\/[^\s)>\]]+/g, blank)
}

function readable(source: string, file: string, ignore: readonly RegExp[]): string {
    const text = isMarkdown(file) ? readableMarkdown(source) : readableCode(source)
    return [...KEPT_ADDRESSES, ...ignore].reduce((kept, pattern) => kept.replace(pattern, blank), text)
}

function lineAt(text: string, index: number): number {
    return text.slice(0, index).split('\n').length
}

/** Every violation in one file's source. `file` decides how it is read, and is carried into the result. */
export function findCopyViolations(source: string, file: string, options: CopyScanOptions = {}): CopyViolation[] {
    const lines = source.split('\n')
    const exempt = (line: number) => EXEMPT.test(lines[line - 1] ?? '') || EXEMPT.test(lines[line - 2] ?? '')
    const text = readable(source, file, options.ignore ?? [])
    const rules = RULES.filter(({ rule }) => !options.rules || options.rules.includes(rule))
    return rules
        .flatMap(({ rule, pattern, fix }) =>
            [...text.matchAll(pattern)].map((match) => ({ file, line: lineAt(text, match.index), rule, excerpt: match[0], fix })),
        )
        .filter(({ line }) => !exempt(line))
        .sort((a, b) => a.line - b.line)
}

/** The files a scan reads under a folder, or the file itself: source and Markdown, never a test. */
export function copyFiles(path: string): string[] {
    if (!statSync(path).isDirectory()) return [path]
    return readdirSync(path).flatMap((name) => {
        const child = join(path, name)
        if (statSync(child).isDirectory()) return name === 'node_modules' || name.startsWith('.') ? [] : copyFiles(child)
        const read = CODE_EXTENSIONS.has(extname(name)) || extname(name) === MARKDOWN_EXTENSION
        return read && !/\.(?:test|spec)\.ts$/.test(name) ? [child] : []
    })
}

/** Every violation under the given folders and files. */
export function scanCopyWording(roots: readonly string[], options: CopyScanOptions = {}): CopyViolation[] {
    return roots.flatMap(copyFiles).flatMap((file) => findCopyViolations(readFileSync(file, 'utf8'), file, options))
}

/** The violations as a test's failure message: where, what to write, and the words found. */
export function describeCopyViolations(violations: readonly CopyViolation[]): string {
    return violations.map(({ file, line, fix, excerpt }) => `${file}:${line}: ${fix} (found "${excerpt}")`).join('\n')
}

// ── Unclear references (a warning) ───────────────────────────────────────────────────────────

const REFERENCE_PHRASES: readonly { pattern: RegExp; reason: string }[] = [
    { pattern: /\bone of them\b/i, reason: '"one of them": say which things' },
    { pattern: /\b(?:do|does|did|doing) (?:that|so)\b/i, reason: '"do that": name the action' },
    {
        pattern: /\b(?:after|before|around|with|to|from|for|on|in|of|under|onto|into) it(?=[.,;:!?)]|\s+(?:and|or|but)\b|\s*$)/i,
        reason: '"it" ending a clause: name the thing',
    },
    { pattern: /\b(?:has|have|had) it\b/i, reason: '"has it": name the thing' },
    { pattern: /\b(?:has|have|had|gets?|needs?) one(?=[.,;:!?)]|\s*$)/i, reason: '"one" ending a clause: name the thing' },
]

/** "This" with a verb straight after it, in a sentence that follows another. */
const BARE_THIS = /^This (?:is|was|will|can|cannot|does|did|means|applies|lets|makes|happens|needs|has|keeps|takes|works|goes|covers)\b/
/** A whole sentence that is a pronoun and a verb: "It does not." */
const BARE_IT = /^It (?:does|is|will|can|did|has|was)(?: not)?[.!]?$/

function sentences(text: string): string[] {
    return text
        .split(/(?<=[.!?…])\s+/)
        .map((sentence) => sentence.trim())
        .filter(Boolean)
}

function sentenceReasons(sentence: string, follows: boolean): string[] {
    const reasons = REFERENCE_PHRASES.filter(({ pattern }) => pattern.test(sentence)).map(({ reason }) => reason)
    if (follows && BARE_THIS.test(sentence)) reasons.push('"This" with no noun: say "this setting" or "this page"')
    if (BARE_IT.test(sentence)) reasons.push('a sentence that is only "it" and a verb: say what does or is')
    return reasons
}

/** The sentences of a passage that may leave a reader unsure what a pronoun points at, each with why. */
export function findUnclearReferences(text: string): { excerpt: string; reason: string }[] {
    return sentences(text).flatMap((sentence, index) => sentenceReasons(sentence, index > 0).map((reason) => ({ excerpt: sentence, reason })))
}

// ── Passages: the runs of prose a warning reads ──────────────────────────────────────────────

/** A boundary between two runs of text that are not one sentence. */
const BREAK = '\u0001'
const INLINE_TAGS = /^<\/?(?:strong|em|b|i|a|code|span|kbd|sup|sub|small|abbr|br|wbr|mark)\b/i
const TEXT_ATTRIBUTES = /\b(?:placeholder|title|aria-label|aria-description|data-tooltip|label|alt|summary)=(["'])([^"'{}]*?)\1/g
const MIN_WORDS = 4

function collapse(text: string): string {
    return text.replace(/\s+/g, ' ').trim()
}

function isProse(text: string): boolean {
    return text.split(' ').length >= MIN_WORDS && /[a-z]{3,} [a-z]{2,}/i.test(text)
}

/** Split blanked text on its breaks, keeping each run's line. */
function runs(text: string): CopyPassage[] {
    const passages: CopyPassage[] = []
    let from = 0
    for (const run of text.split(BREAK)) {
        const start = from + run.search(/\S|$/)
        const collapsed = collapse(run)
        if (isProse(collapsed)) passages.push({ line: lineAt(text, start), text: collapsed })
        from += run.length + 1
    }
    return passages
}

/** A tag or a block of Svelte logic as a break, an inline tag as a space, an expression as a word. */
function markupText(template: string): string {
    return template
        .replace(/\{[#:/@][^{}]*\}/g, (tag) => BREAK + blank(tag).slice(1))
        .replace(/\{[^{}]*\}/g, (expression) => (expression.includes('\n') ? BREAK + blank(expression).slice(1) : `X${blank(expression).slice(1)}`))
        .replace(/<[^<>]*>/g, (tag) => (INLINE_TAGS.test(tag) ? blank(tag) : BREAK + blank(tag).slice(1)))
}

/** The words of string literals, each literal a run: a `+` between two joins them. */
function literalText(script: string): string {
    const literal = /(['"`])((?:\\.|(?!\1)[^\\])*?)\1/g
    let text = blank(script)
    for (const match of script.matchAll(literal)) {
        const words = match[2].replace(/\$\{[^{}]*\}/g, (expression) => `X${blank(expression).slice(1)}`)
        const at = match.index + 1
        text = text.slice(0, at) + words + text.slice(at + words.length)
        const joined = /^\s*\+\s*['"`]/.test(script.slice(match.index + match[0].length))
        if (!joined) text = `${text.slice(0, at + words.length)}${BREAK}${text.slice(at + words.length + 1)}`
    }
    return text
}

function sveltePassages(source: string): CopyPassage[] {
    const code = readableCode(source)
    const blocks = /<(script|style)\b[^>]*>[\s\S]*?<\/\1>/g
    const scripts = code.replace(/[\s\S]/g, (char) => (char === '\n' ? '\n' : ' ')).split('')
    for (const match of code.matchAll(blocks)) {
        if (match[1] === 'script') for (let i = 0; i < match[0].length; i++) scripts[match.index + i] = match[0][i]
    }
    const template = code.replace(blocks, blank)
    const attributes = [...template.matchAll(TEXT_ATTRIBUTES)]
        .map((match) => ({ line: lineAt(template, match.index), text: collapse(match[2]) }))
        .filter(({ text }) => isProse(text))
    return [...runs(markupText(template)), ...attributes, ...runs(literalText(scripts.join('')))]
}

function markdownPassages(source: string): CopyPassage[] {
    return readableMarkdown(source)
        .split('\n')
        .map((line, index) => ({ line: index + 1, text: collapse(line.replace(/^\s*(?:[-*>#|]+|\d+\.)\s*/, '').replace(/[*_|]/g, ' ')) }))
        .filter(({ text }) => isProse(text))
}

/** The runs of prose in a file: a paragraph of Markdown, the text of markup, a string in code. */
export function copyPassages(source: string, file: string): CopyPassage[] {
    if (isMarkdown(file)) return markdownPassages(source)
    if (extname(file) === '.svelte') return sveltePassages(source)
    return runs(literalText(readableCode(source)))
}

/** Every unclear reference in one file's source. A `copy-exempt:` comment excuses a line of code. */
export function findCopyWarnings(source: string, file: string): CopyWarning[] {
    const lines = source.split('\n')
    const exempt = (line: number) => EXEMPT.test(lines[line - 1] ?? '') || EXEMPT.test(lines[line - 2] ?? '')
    return copyPassages(source, file)
        .filter(({ line }) => !exempt(line))
        .flatMap(({ line, text }) => findUnclearReferences(text).map(({ excerpt, reason }) => ({ file, line, excerpt, reason })))
}
