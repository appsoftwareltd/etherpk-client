/**
 * How much one share may carry. A share's files are held whole on their way into a note, so what a
 * share sheet can send (a whole album) is more than a phone's browser can hold.
 *
 * The limits are applied where a share is received, by the service worker and by a Native App,
 * before a file is read. What does not fit is left out and counted, and the page says so: the rest of
 * the share still arrives.
 */

export const MAX_SHARED_FILES = 20
export const MAX_SHARED_BYTES = 100 * 1024 * 1024

/** The files a share may keep, in the order they came, and how many were left out. */
export function withinShareLimits<T extends { size: number }>(files: readonly T[]): { kept: T[]; leftOut: number } {
    const kept: T[] = []
    let bytes = 0
    for (const file of files) {
        // A smaller file after one that does not fit still fits, so each is judged by itself.
        if (kept.length >= MAX_SHARED_FILES || bytes + file.size > MAX_SHARED_BYTES) continue
        kept.push(file)
        bytes += file.size
    }
    return { kept, leftOut: files.length - kept.length }
}

/** What the share page says about files left out. */
export function leftOutMessage(leftOut: number): string {
    const files = leftOut === 1 ? '1 file was left out of this share.' : `${leftOut} files were left out of this share.`
    return `${files} A share can hold up to ${MAX_SHARED_FILES} files and ${MAX_SHARED_BYTES / 1024 / 1024} MB in total. Share the missing files in smaller groups, or add a larger file to a note in EtherPK.`
}
