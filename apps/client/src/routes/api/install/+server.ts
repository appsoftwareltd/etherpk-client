/**
 * Counts install outcomes in the request log, and nothing else (see `installOutcomeResponse`).
 */
import { installOutcomeResponse } from '$lib/server/install-outcome'
import type { RequestHandler } from './$types'

export const GET: RequestHandler = ({ url }) => installOutcomeResponse(url)
