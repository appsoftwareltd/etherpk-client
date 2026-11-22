import { dev } from '$app/env'

import type { LayoutLoad } from './$types'

// A [[Plain Folder]]'s workspace is built in the browser: it reads a folder through a handle the
// browser holds. The name is all the address gives; the gate finds the folder it means.
export const load: LayoutLoad = ({ params, url }) => {
    // Dev and end-to-end tests only, as for a graph: how long after an edit a save starts.
    const autosave = dev ? Number(url.searchParams.get('autosaveMs') ?? NaN) : NaN
    return { name: params.name, autosaveMs: Number.isFinite(autosave) ? autosave : undefined }
}
