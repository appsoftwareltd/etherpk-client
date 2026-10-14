/**
 * The Extension Directory's list for Settings (ADR 0123), as the Client's server last read it:
 * `{ state: 'ok', listing }`, `{ state: 'off' }` when this Client has no directory, or
 * `{ state: 'unavailable', error }` when it has never been able to read it. `?fresh=1` (Refresh in
 * Settings) reads it again first, at most once every half a minute.
 */
import { json } from '@sveltejs/kit'

import { releaseStore } from '$lib/server/extension-directory/store'

import type { RequestHandler } from './$types'

export const GET: RequestHandler = async ({ url }) =>
    json(await releaseStore().listing({ fresh: url.searchParams.get('fresh') === '1' }), { headers: { 'cache-control': 'no-store' } })
