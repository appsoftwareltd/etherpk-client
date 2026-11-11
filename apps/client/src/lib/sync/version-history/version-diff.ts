/**
 * The changes between two versions of a document, as a unified diff: the lines removed and added,
 * each run with three unchanged lines either side, and runs whose context would meet joined into
 * one hunk, as `git diff` shows them (ADR 0184). The Version History preview shows a version this
 * way against the version before it.
 *
 * Lines are compared whole. The lines both texts share at the start and the end are set aside
 * first, so an edit in one place costs only the lines around it; the rest is Myers' O(ND) search
 * for the fewest lines removed and added ("An O(ND) Difference Algorithm and Its Variations",
 * 1986). Two texts too different to search within `maxEdits` are shown as one replaced outright,
 * which is still a true account of the change, only a longer one.
 *
 * Pure: no DOM.
 */

export interface VersionDiffRow {
    kind: 'context' | 'removed' | 'added'
    /** 1-based line in the version before; null for an added line. */
    oldLine: number | null
    /** 1-based line in this version; null for a removed line. */
    newLine: number | null
    text: string
    /** Unique within the diff, for a keyed list. */
    key: string
}

export interface VersionDiffHunk {
    /** Unchanged lines left out between the previous hunk (or the start) and this one. */
    skippedBefore: number
    rows: VersionDiffRow[]
}

export interface VersionDiff {
    hunks: VersionDiffHunk[]
    /** Lines added and removed in all. */
    added: number
    removed: number
    /** Unchanged lines left out after the last hunk. */
    skippedAfter: number
}

export interface VersionDiffOptions {
    /** Unchanged lines shown either side of a change. */
    context?: number
    /** The most lines removed and added the search looks for before treating the texts as replaced. */
    maxEdits?: number
}

const CONTEXT = 3
/** Enough for any edit a person makes between two versions; keeps the search's memory to a few MB. */
const MAX_EDITS = 2000

type Step = 'same' | 'removed' | 'added'

/**
 * A text's lines. `\r\n`, `\r` and `\n` each end a line, as the editor reads them, and a final line
 * break ends the last line rather than starting an empty one. An empty text has no lines.
 */
export function splitVersionLines(text: string): string[] {
    if (text === '') return []
    const lines = text.split(/\r\n?|\n/)
    if (lines.at(-1) === '') lines.pop()
    return lines
}

export function diffVersions(before: string, after: string, options: VersionDiffOptions = {}): VersionDiff {
    const was = splitVersionLines(before)
    const now = splitVersionLines(after)
    const rows = toRows(was, now, alignedSteps(was, now, options.maxEdits ?? MAX_EDITS))
    return grouped(rows, options.context ?? CONTEXT)
}

/** The steps from `was` to `now`: the shared ends set aside, the middle searched. */
function alignedSteps(was: string[], now: string[], maxEdits: number): Step[] {
    let start = 0
    while (start < was.length && start < now.length && was[start] === now[start]) start++
    let end = 0
    while (end < was.length - start && end < now.length - start && was[was.length - 1 - end] === now[now.length - 1 - end]) end++
    const middleWas = was.slice(start, was.length - end)
    const middleNow = now.slice(start, now.length - end)
    const middle: Step[] = shortestSteps(middleWas, middleNow, maxEdits) ?? [
        ...middleWas.map((): Step => 'removed'),
        ...middleNow.map((): Step => 'added'),
    ]
    return [...new Array<Step>(start).fill('same'), ...middle, ...new Array<Step>(end).fill('same')]
}

/**
 * Myers' greedy search. `v[k]` holds how far along `a` the furthest path on diagonal `k` (x − y)
 * reaches with `d` lines removed or added; each round's `v` is kept so the path can be walked back.
 * Null when the texts need more than `maxEdits` steps.
 */
function shortestSteps(a: string[], b: string[], maxEdits: number): Step[] | null {
    const max = Math.min(a.length + b.length, maxEdits)
    const offset = max + 1
    const v = new Int32Array(2 * max + 3)
    // trace[d] is `v` as round d starts, for diagonals −(d+1) to d+1, at index k + d + 1.
    const trace: Int32Array[] = []
    for (let d = 0; d <= max; d++) {
        trace.push(v.slice(offset - d - 1, offset + d + 2))
        for (let k = -d; k <= d; k += 2) {
            const x = furthest(a, b, k, d, (diagonal) => v[offset + diagonal])
            v[offset + k] = x
            if (x >= a.length && x - k >= b.length) return walkBack(trace, a.length, b.length)
        }
    }
    return null
}

/** Whether the path to diagonal `k` comes down from k + 1 (a line added) rather than across from k − 1. */
function fromAbove(k: number, d: number, at: (diagonal: number) => number): boolean {
    return k === -d || (k !== d && at(k - 1) < at(k + 1))
}

/** How far along `a` diagonal `k` reaches in round `d`, following lines the two texts share. */
function furthest(a: string[], b: string[], k: number, d: number, at: (diagonal: number) => number): number {
    let x = fromAbove(k, d, at) ? at(k + 1) : at(k - 1) + 1
    let y = x - k
    while (x < a.length && y < b.length && a[x] === b[y]) {
        x++
        y++
    }
    return x
}

/** The steps of the path that reached the end, from the last round back to the first. */
function walkBack(trace: Int32Array[], n: number, m: number): Step[] {
    const steps: Step[] = []
    let x = n
    let y = m
    for (let d = trace.length - 1; d >= 0; d--) {
        const at = (diagonal: number) => trace[d][diagonal + d + 1]
        const k = x - y
        const previousK = fromAbove(k, d, at) ? k + 1 : k - 1
        const previousX = at(previousK)
        const previousY = previousX - previousK
        while (x > previousX && y > previousY) {
            steps.push('same')
            x--
            y--
        }
        if (d > 0) steps.push(x === previousX ? 'added' : 'removed')
        x = previousX
        y = previousY
    }
    return steps.reverse()
}

function toRows(was: string[], now: string[], steps: Step[]): VersionDiffRow[] {
    const rows: VersionDiffRow[] = []
    let i = 0
    let j = 0
    for (const step of steps) {
        if (step === 'same') {
            rows.push({ kind: 'context', oldLine: i + 1, newLine: j + 1, text: now[j], key: `c${i}-${j}` })
            i++
            j++
        } else if (step === 'removed') {
            rows.push({ kind: 'removed', oldLine: i + 1, newLine: null, text: was[i], key: `r${i}` })
            i++
        } else {
            rows.push({ kind: 'added', oldLine: null, newLine: j + 1, text: now[j], key: `a${j}` })
            j++
        }
    }
    return rows
}

/** The rows cut into hunks: each run of changes with `context` unchanged rows either side. */
function grouped(rows: VersionDiffRow[], context: number): VersionDiff {
    const changed = rows.flatMap((row, i) => (row.kind === 'context' ? [] : [i]))
    const hunks: VersionDiffHunk[] = []
    let shownTo = 0
    for (let i = 0; i < changed.length; ) {
        let j = i
        while (j + 1 < changed.length && changed[j + 1] - changed[j] - 1 <= 2 * context) j++
        const from = Math.max(shownTo, changed[i] - context)
        const to = Math.min(rows.length, changed[j] + context + 1)
        hunks.push({ skippedBefore: from - shownTo, rows: rows.slice(from, to) })
        shownTo = to
        i = j + 1
    }
    return {
        hunks,
        added: rows.filter((row) => row.kind === 'added').length,
        removed: rows.filter((row) => row.kind === 'removed').length,
        skippedAfter: changed.length > 0 ? rows.length - shownTo : 0,
    }
}
