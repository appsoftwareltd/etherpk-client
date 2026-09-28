/**
 * Reading, editing and writing a [[Frontmatter]] block's YAML in the one style EtherPK writes
 * (ADR 0108).
 *
 * Every writer goes through here: the identity write-back, publishing, the arbitrary-key patch,
 * the importers, Add frontmatter and the editor's tidy when an editing episode ends. Edits go
 * through the `yaml` library's document model rather than a plain object, so a comment, and any
 * key the edit does not touch, survives. The block is then written in the EtherPK style:
 *
 * - two-space indentation, a list under its key as `  - item`, one item per line;
 * - an inline list (`[a, b]`) written as a block list, an empty `[]` kept;
 * - quotes only where a value needs them (`"true"` stays quoted, `"hello"` does not);
 * - no line wrapping, no blank lines, key order as found, comments kept;
 * - an empty value written bare (`slug:`), which reads as "fill this in".
 *
 * Restyling never changes what the block says: the value is compared before and after, and a
 * rewrite that would change it is dropped. A block that does not parse is never rewritten.
 *
 * Pure: no store, no editor. What counts as a block comes from `frontmatter-span.ts`.
 */
import { Document, isMap, isScalar, parseDocument, visit, type ToStringOptions, YAMLMap } from 'yaml'

import { frontmatterSpan } from '$lib/storage/fs/frontmatter-span'

/** The `yaml` serialiser options that make up the EtherPK style. */
const STYLE: ToStringOptions = {
    indent: 2,
    indentSeq: true,
    lineWidth: 0,
    minContentWidth: 0,
    nullStr: '',
}

/**
 * The block's YAML parsed as a document, or null when it does not parse or is not a mapping.
 * An empty block (or one holding only comments) is an empty mapping.
 */
function parseBlock(body: string): Document | null {
    // Widened from the parsed type: an empty block is given a new mapping below, which is not a parsed node.
    const doc: Document = parseDocument(body)
    if (doc.errors.length > 0) return null
    if (doc.contents === null) {
        // Nothing but comments, or nothing at all: a mapping with no keys. The comments stay on
        // the document, before the mapping.
        doc.contents = new YAMLMap()
        return doc
    }
    return isMap(doc.contents) ? doc : null
}

/** The block's YAML as a plain object, or null when it does not parse to a mapping. */
export function frontmatterData(body: string): Record<string, unknown> | null {
    const doc = parseBlock(body)
    return doc === null ? null : (doc.toJS() as Record<string, unknown>)
}

/** Apply the EtherPK style to a document in place. */
function applyStyle(doc: Document): void {
    visit(doc, {
        Scalar(_, node) {
            node.spaceBefore = false
            // A single-line quoted string goes back to plain; the serialiser quotes it again when
            // plain would read as something else (`true`, `42`, `a: b`).
            if (typeof node.value === 'string' && !node.value.includes('\n') && (node.type === 'QUOTE_DOUBLE' || node.type === 'QUOTE_SINGLE')) {
                node.type = 'PLAIN'
            }
        },
        Map(_, node) {
            node.spaceBefore = false
            if (node.items.length > 0) node.flow = false
        },
        Seq(_, node) {
            node.spaceBefore = false
            if (node.items.length > 0) node.flow = false
        },
    })
}

/** The styled YAML of a document, ending in a newline, or '' when it has no keys and no comment. */
function styledYaml(doc: Document): string {
    applyStyle(doc)
    const map = doc.contents
    if (isMap(map) && map.items.length === 0) {
        // `yaml` writes an empty mapping as `{}`; a block with no keys is written empty, keeping
        // any comment it carries.
        return doc.commentBefore ? `${doc.commentBefore.replace(/^/gm, '#')}\n` : ''
    }
    return doc.toString(STYLE)
}

/** Deep equality over the plain values a block parses to. */
function sameValue(a: unknown, b: unknown): boolean {
    return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * A new block holding `data`, in the EtherPK style: `---\n…---\n`, or '' when `data` has no keys.
 * For a document that has no block yet; to change a block that exists use {@link editFrontmatter},
 * which keeps what the block already says.
 */
export function renderFrontmatter(data: Readonly<Record<string, unknown>>): string {
    if (Object.keys(data).length === 0) return ''
    const doc = new Document(data)
    return `---\n${styledYaml(doc)}---\n`
}

/** The line terminator a block uses, so a rewrite does not mix endings in a CRLF file. */
function eolOf(text: string, end: number): string {
    return text.slice(0, end).includes('\r\n') ? '\r\n' : '\n'
}

function withEol(yaml: string, eol: string): string {
    return eol === '\n' ? yaml : yaml.replace(/\n/g, eol)
}

/**
 * The text with its block written in the EtherPK style. The same string comes back when the block
 * is already in the style, when there is no block, when its YAML does not parse, or when the
 * restyled block would say something different. The body is never touched.
 */
export function tidyFrontmatter(text: string): string {
    const span = frontmatterSpan(text)
    if (!span) return text
    const doc = parseBlock(span.body)
    if (doc === null) return text
    const before = doc.toJS()
    const eol = eolOf(text, span.end)
    const next = `---${eol}${withEol(styledYaml(doc), eol)}---${eol}`
    // The closing delimiter may be the last line with no terminator; keep it that way.
    const closed = span.end === text.length && !text.endsWith('\n') ? next.slice(0, -eol.length) : next
    const tidied = closed + text.slice(span.end)
    if (tidied === text) return text
    const after = frontmatterSpan(tidied)
    if (!after || !sameValue(frontmatterData(after.body), before)) return text
    return tidied
}

/** Reading and changing one block's keys, as {@link editFrontmatter} hands it to its caller. */
export interface FrontmatterEditor {
    /** Whether the block names `key`, whatever its value. */
    has(key: string): boolean
    /** The plain value of `key`, or undefined when the block does not name it. */
    get(key: string): unknown
    /**
     * Set `key` to `value`. A key the block already names keeps its place and the comment above
     * it; a new key goes last, or first when asked. `null` writes an empty value (`slug:`).
     */
    set(key: string, value: unknown, where?: 'first' | 'last'): void
    /** Remove `key` and its value. */
    delete(key: string): void
    /** The block's keys, in order. */
    keys(): string[]
}

function editorFor(doc: Document): FrontmatterEditor {
    const map = doc.contents as YAMLMap
    const keyOf = (item: { key: unknown }): string => String(isScalar(item.key) ? item.key.value : item.key)
    return {
        has: (key) => map.has(key),
        get: (key) => (map.has(key) ? (doc.toJS() as Record<string, unknown>)[key] : undefined),
        set(key, value, where = 'last') {
            if (map.has(key)) {
                const current = (doc.toJS() as Record<string, unknown>)[key]
                // An unchanged value keeps its node, and with it any comment or quoting it has.
                if (sameValue(current, value)) return
                map.set(key, doc.createNode(value))
                return
            }
            const pair = doc.createPair(key, value)
            if (where === 'first') map.items.unshift(pair)
            else map.items.push(pair)
        },
        delete: (key) => {
            map.delete(key)
        },
        keys: () => map.items.map(keyOf),
    }
}

export interface EditOptions {
    /**
     * Add a block to a document that has none. Off by default: a document without a block has
     * made no claim, and a synced document never grows one unprompted (ADR 0061).
     */
    addBlock?: boolean
}

/**
 * The text with its block changed by `edit`, then written in the EtherPK style. The same string
 * comes back when the edit changes nothing the block says, so a writer that runs on every save
 * never restyles a block it agrees with. A block whose YAML does not parse is left alone: rewriting
 * it would destroy whatever the person was typing. A block the edit empties of every key is
 * removed.
 */
export function editFrontmatter(text: string, edit: (block: FrontmatterEditor) => void, options: EditOptions = {}): string {
    const span = frontmatterSpan(text)
    if (!span && !options.addBlock) return text
    const doc = span ? parseBlock(span.body) : parseBlock('')
    if (doc === null) return text
    const before = doc.toJS()
    edit(editorFor(doc))
    if (sameValue(doc.toJS(), before)) return text

    const body = span ? text.slice(span.end) : text
    const map = doc.contents as YAMLMap
    if (map.items.length === 0) return body
    const eol = span ? eolOf(text, span.end) : '\n'
    return `---${eol}${withEol(styledYaml(doc), eol)}---${eol}${body}`
}

/**
 * Whether a value counts as not set (ADR 0108): nothing, a blank string, an empty list, or a
 * mapping whose every value is itself empty. `false` and `0` are values.
 */
export function isEmptyValue(value: unknown): boolean {
    if (value === null || value === undefined) return true
    if (typeof value === 'string') return value.trim() === ''
    if (Array.isArray(value)) return value.length === 0
    if (typeof value === 'object' && !(value instanceof Date)) return Object.values(value).every(isEmptyValue)
    return false
}

/** Why a block's YAML cannot be read, and where. */
export interface FrontmatterParseProblem {
    /** The parser's reason, as a sentence without its position. */
    message: string
    /** The parser's error code (`TAB_AS_INDENT`, `DUPLICATE_KEY`, …), or `NOT_A_MAPPING`. */
    code: string
    /** 0-based line within the block's YAML (the line after the opening `---` is 0). */
    line: number
}

/**
 * The first reason `body` does not read as a block, or null when it does. A block that parses to
 * something other than a mapping (a list, a lone value) is a problem too: EtherPK reads keys.
 */
export function frontmatterParseProblem(body: string): FrontmatterParseProblem | null {
    const doc = parseDocument(body)
    const error = doc.errors[0]
    if (error) {
        const first = error.message.split('\n')[0]
        const message = first.replace(/ at line \d+, column \d+:?$/, '').trim()
        return { message: message.endsWith('.') ? message : `${message}.`, code: error.code, line: Math.max(0, (error.linePos?.[0]?.line ?? 1) - 1) }
    }
    if (doc.contents !== null && !isMap(doc.contents)) {
        return { message: 'The block must hold `key: value` lines.', code: 'NOT_A_MAPPING', line: 0 }
    }
    return null
}

/** `value` written as a YAML scalar, quoted only when plain would read as something else. */
export function yamlScalar(value: string): string {
    return new Document(value).toString(STYLE).trimEnd()
}
