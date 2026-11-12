import { redirect } from '@sveltejs/kit'

import { SHARE_FILES_DROPPED, shareAddress, sharedFilesOf } from '#lib/share/share-post.js'

import type { RequestHandler } from './$types'

/**
 * A posted share that no service worker took (ADR 0186): the worker is what keeps a share's
 * files on the device, and it is not in control on the first launch after an install or where
 * the browser has none. The server keeps nothing a person shares, so the text goes on to the
 * page as its address and the files are dropped, which the page says. Sharing again works: by
 * then the worker is in control.
 */
export const POST: RequestHandler = async ({ request }) => {
    let form: FormData
    try {
        form = await request.formData()
    } catch {
        redirect(303, '/share')
    }
    redirect(303, shareAddress(form, sharedFilesOf(form).length > 0 ? SHARE_FILES_DROPPED : null))
}
