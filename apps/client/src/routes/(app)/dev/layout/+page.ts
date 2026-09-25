import { dev } from '$app/environment'
import { error } from '@sveltejs/kit'

import type { PageLoad } from './$types'

// The dev harness (and its Playwright fixture) must 404 in production.
export const load: PageLoad = () => {
    if (!dev) error(404, 'Not found')
    return {}
}
