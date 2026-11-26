/**
 * A write that names the file it expects to replace, and what its refusal means.
 *
 * An installed app's shell writes only while the file still has the stamps the save read, so another
 * program's write that lands in between is not replaced. It refuses with `NoModificationAllowedError`,
 * and so does a browser for a file another program has locked. The file's own stamps tell the two
 * apart: a file that moved is read and judged again, and one that did not is a save that failed.
 *
 * A browser's adapter ignores what is expected and writes, as it always has: the File System Access
 * API has nothing to compare with (spec/folder-save, `OutsideInWindow`).
 */
import type { ExpectedStamp } from './directory-adapter'

type Stamp = Exclude<ExpectedStamp, 'absent'>

/** The expectation a file as just read makes. Null is a file that is not there. */
export function expectedOf(file: Stamp | null): ExpectedStamp {
    return file === null ? 'absent' : { lastModified: file.lastModified, size: file.size }
}

function holds(expected: ExpectedStamp, now: Stamp | null): boolean {
    if (now === null || expected === 'absent') return now === null && expected === 'absent'
    return now.lastModified === expected.lastModified && now.size === expected.size
}

/** Run `write`, and answer null when it was refused because the file is no longer as `expected`. */
export async function writeUnlessMoved<T>(expected: ExpectedStamp, write: (expected: ExpectedStamp) => Promise<T>, stampsNow: () => Promise<Stamp | null>): Promise<T | null> {
    try {
        return await write(expected)
    } catch (error) {
        if ((error as { name?: unknown } | null)?.name !== 'NoModificationAllowedError') throw error
        if (holds(expected, await stampsNow())) throw error
        return null
    }
}

/**
 * How often a guarded save reads, judges and writes again before it gives up. A file refused for having
 * moved is read again, and a program that touches a file without changing its words (a sync tool that
 * rewrites every file it sees) would otherwise keep a save going round for ever.
 */
export const MOST_WRITE_TRIES = 5

/**
 * Run one try of a guarded save until it answers, at most `MOST_WRITE_TRIES` times. A try answers
 * `undefined` to go round again. Past the limit the save fails as a file another program was using,
 * which the save's notice words and offers to retry.
 */
export async function untilWritten<T>(attempt: () => Promise<T | undefined>): Promise<T> {
    for (let tries = 0; tries < MOST_WRITE_TRIES; tries++) {
        const answer = await attempt()
        if (answer !== undefined) return answer
    }
    throw new DOMException(`The file changed each of the ${MOST_WRITE_TRIES} times it was about to be saved.`, 'InvalidStateError')
}
