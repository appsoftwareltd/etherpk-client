/**
 * Reading and saving a file of a [[Plain Folder]] without changing what the person did not edit
 * (ADR 0196).
 *
 * Such a file was written elsewhere and is often under git. So it is read as bytes with a strict
 * decoder, its byte order mark and line endings are kept, and a save places only the edited lines
 * into the text that was read: every other line keeps its own bytes, ending included. The editor's
 * buffer holds line feeds only, as everywhere in the Client; the file's own endings live here.
 *
 * Pure: bytes and strings in, bytes and strings out.
 */

/** What a file's bytes say about how to write it, beyond its text. */
export interface FileForm {
    /** The file starts with a UTF-8 byte order mark. */
    bom: boolean
    /** The file's commonest line ending: what a new or edited line is given. */
    eol: '\n' | '\r\n' | '\r'
}

export type DecodedFile =
    /** `text` is the file as written, line endings and all, without the byte order mark. */
    | { ok: true; text: string; form: FileForm }
    /** The bytes are not UTF-8: decoding would replace some of them, and a save would write the damage. */
    | { ok: false; reason: 'not-utf8' }

/** One line of a text and the ending that followed it; the last line's ending is empty. */
export interface TextLine {
    text: string
    eol: '' | '\n' | '\r\n' | '\r'
}

const LINE_ENDING = /\r\n|\r|\n/g

/** The text as lines, each with its own ending. `'a\n'` is two lines: `a`, and an empty last one. */
export function splitLines(text: string): TextLine[] {
    const lines: TextLine[] = []
    let from = 0
    for (const match of text.matchAll(LINE_ENDING)) {
        lines.push({ text: text.slice(from, match.index), eol: match[0] as TextLine['eol'] })
        from = match.index + match[0].length
    }
    lines.push({ text: text.slice(from), eol: '' })
    return lines
}

/** The ending most lines use, the first seen winning a tie; line feeds when the text has none. */
function commonestEnding(text: string): FileForm['eol'] {
    const counts = new Map<FileForm['eol'], number>()
    for (const match of text.matchAll(LINE_ENDING)) {
        const eol = match[0] as FileForm['eol']
        counts.set(eol, (counts.get(eol) ?? 0) + 1)
    }
    let best: FileForm['eol'] = '\n'
    let most = 0
    for (const [eol, count] of counts) {
        if (count > most) {
            best = eol
            most = count
        }
    }
    return best
}

/** Read a file's bytes as UTF-8 text, refusing bytes that are not. */
export function decodeFile(bytes: Uint8Array): DecodedFile {
    const bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
    let text: string
    try {
        // `fatal` refuses invalid bytes rather than replacing them with U+FFFD. The mark is cut off
        // here, so it is never taken for a character of the first line.
        text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bom ? bytes.subarray(3) : bytes)
    } catch {
        return { ok: false, reason: 'not-utf8' }
    }
    return { ok: true, text, form: { bom, eol: commonestEnding(text) } }
}

/** The bytes to write for `text`, with the byte order mark the file had. */
export function encodeFile(text: string, form: FileForm): Uint8Array<ArrayBuffer> {
    const body = new TextEncoder().encode(text)
    if (!form.bom) return body
    const out = new Uint8Array(body.length + 3)
    out.set([0xef, 0xbb, 0xbf])
    out.set(body, 3)
    return out
}

/** Above this many cells the middle of a large change is taken as replaced, not matched line by line. */
const MATCH_LIMIT = 4_000_000

/**
 * For each line of `next`, the index of the line of `prior` it is, or -1 for a line that is new
 * or changed. Lines are matched in order (a longest common subsequence), after the unchanged head
 * and tail are set aside, which is the whole of an ordinary edit.
 */
function matchLines(prior: readonly string[], next: readonly string[]): Int32Array {
    const from = new Int32Array(next.length).fill(-1)
    const head = sharedHead(prior, next)
    for (let line = 0; line < head; line++) from[line] = line
    const tail = sharedTail(prior, next, head)
    for (let back = 1; back <= tail; back++) from[next.length - back] = prior.length - back
    const rows = prior.length - head - tail
    const cols = next.length - head - tail
    if (rows === 0 || cols === 0 || (rows + 1) * (cols + 1) > MATCH_LIMIT) return from
    matchMiddle(prior.slice(head, head + rows), next.slice(head, head + cols), (i, j) => {
        from[head + j] = head + i
    })
    return from
}

/** How many lines the two start with in common. */
function sharedHead(prior: readonly string[], next: readonly string[]): number {
    let head = 0
    while (head < prior.length && head < next.length && prior[head] === next[head]) head++
    return head
}

/** How many lines the two end with in common, past the first `head`. */
function sharedTail(prior: readonly string[], next: readonly string[], head: number): number {
    let tail = 0
    while (tail < prior.length - head && tail < next.length - head && prior[prior.length - 1 - tail] === next[next.length - 1 - tail]) tail++
    return tail
}

/** A longest common subsequence of the lines of `prior` and `next`: `matched(i, j)` for each pair, in order. */
function matchMiddle(prior: readonly string[], next: readonly string[], matched: (i: number, j: number) => void): void {
    const rows = prior.length
    const cols = next.length
    // lengths[i][j]: the longest run of matched lines within prior[i..] and next[j..].
    const width = cols + 1
    const lengths = new Uint32Array((rows + 1) * width)
    for (let i = rows - 1; i >= 0; i--) {
        for (let j = cols - 1; j >= 0; j--) {
            lengths[i * width + j] = prior[i] === next[j] ? lengths[(i + 1) * width + j + 1] + 1 : Math.max(lengths[(i + 1) * width + j], lengths[i * width + j + 1])
        }
    }
    let i = 0
    let j = 0
    while (i < rows && j < cols) {
        if (prior[i] === next[j]) matched(i++, j++)
        else if (lengths[(i + 1) * width + j] >= lengths[i * width + j + 1]) i++
        else j++
    }
}

/**
 * The text to write for `buffer` (line feeds only), given the file's text as last read. A line the
 * edit left alone keeps the ending it had. A new or changed line, and a line that used to be the
 * last and no longer is, takes the file's commonest ending. Whether the text ends with a newline is
 * the buffer's to say.
 */
export function placeEdits(diskText: string, buffer: string, form: FileForm): string {
    const prior = splitLines(diskText)
    const next = buffer.split('\n')
    const from = matchLines(
        prior.map((line) => line.text),
        next,
    )
    // The ending after each line but the last.
    const endings: string[] = []
    for (let index = 0; index < next.length - 1; index++) {
        const kept = from[index] >= 0 ? prior[from[index]].eol : ''
        endings.push(kept === '' ? form.eol : kept)
    }
    // A kept `\r` followed by an empty line that ends `\n` would read back as one `\r\n`, and a
    // line would be lost. Only an edit beside an old-Mac ending in a mixed file can bring the two
    // together; that one ending is then written `\r\n`.
    for (let index = 0; index < endings.length - 1; index++) {
        if (endings[index] === '\r' && next[index + 1] === '' && endings[index + 1].startsWith('\n')) endings[index] = '\r\n'
    }
    let out = ''
    for (let index = 0; index < next.length; index++) out += next[index] + (endings[index] ?? '')
    return out
}
