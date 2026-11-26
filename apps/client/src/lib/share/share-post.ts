/**
 * A share as the device's share sheet posts it (ADR 0186): the manifest's share target is a
 * `multipart/form-data` POST, because that is the only flavour that carries files.
 *
 * A page is opened with an address, not a form, so whoever receives the post (the service worker,
 * or the server when no worker is in control) turns it into the address the [[Share Target]]'s
 * page has always read: `/share?title=…&text=…&url=…`, with `files=` naming where the files
 * are kept. Pure, so both receivers agree and the rule is pinned down without a browser.
 */

/** The form field the manifest names for files (`share_target.params.files[].name`). */
export const SHARE_FILES_FIELD = 'files'

/**
 * On the address when the post carried files that could not be kept: no service worker was in
 * control, or its store refused them. The page says so, and that sharing again will work.
 */
export const SHARE_FILES_DROPPED = 'dropped'

/** The files of a posted share. An empty file field (a share of text alone) is not a file. */
export function sharedFilesOf(form: FormData): File[] {
    return form.getAll(SHARE_FILES_FIELD).filter((entry): entry is File => typeof entry !== 'string' && entry.size > 0)
}

/** The words of a share: a posted form, or what a Native App's shell was handed. */
export type SharedWords = Pick<FormData, 'get'>

/**
 * The address to send a posted share to. `files` is the id its files are kept under,
 * {@link SHARE_FILES_DROPPED}, or null for a share with none. `leftOut` is how many more there were
 * than one share may carry (share-limits.ts).
 */
export function shareAddress(words: SharedWords, files: string | null, leftOut = 0): string {
    const query = new URLSearchParams()
    for (const field of ['title', 'text', 'url']) {
        const value = words.get(field)
        if (typeof value === 'string' && value !== '') query.set(field, value)
    }
    if (files) query.set('files', files)
    if (leftOut > 0) query.set('leftOut', String(leftOut))
    const search = query.toString()
    return search === '' ? '/share' : `/share?${search}`
}
