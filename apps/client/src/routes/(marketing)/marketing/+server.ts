import { redirect } from '@sveltejs/kit'
import type { RequestHandler } from './$types'

/** Preserve old public links while making /home the one canonical home-page route. */
export const GET: RequestHandler = ({ url }) => {
    redirect(303, `/home${url.search}`)
}
