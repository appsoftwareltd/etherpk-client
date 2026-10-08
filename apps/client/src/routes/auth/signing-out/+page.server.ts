import { error } from '@sveltejs/kit'
import type { PageServerLoad } from './$types'
import { env } from '$env/dynamic/private'
import { parseOptionalManagedClientAuthConfig } from '$lib/server/auth/config'
import { nextHopAfterClient } from '$lib/server/auth/managed-logout'

/**
 * The Client's step in a sign-out started on the account site or the Sync portal: the page clears
 * this browser's part, then goes on to `next`. Only those two sources stop here (a sign-out started
 * in the Client did its part before it left), and `next` is built from configuration.
 */
export const load: PageServerLoad = async ({ url }) => {
    const config = parseOptionalManagedClientAuthConfig(env)
        ?? error(404, 'Managed Sync is not configured for this Client')
    const from = url.searchParams.get('from')
    if (from !== 'sync' && from !== 'corporate') error(400, 'Invalid managed logout continuation')
    return { next: nextHopAfterClient(from, config) }
}
