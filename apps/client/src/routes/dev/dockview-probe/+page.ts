import { dev } from '$app/environment'
import { error } from '@sveltejs/kit'

import type { PageLoad } from './$types'

// Dev-only: the probe (and the dev harness) must 404 in production.
export const load: PageLoad = () => {
    if (!dev) error(404, 'Not found')
    return {}
}
