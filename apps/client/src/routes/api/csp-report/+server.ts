/**
 * Where the Client's pages report Content Security Policy violations (`report-uri`, ADR 0130): a
 * script blocked, or a write Trusted Types refused. Each is logged as one JSON line, so a policy
 * that breaks a page in use shows in the logs before anyone reports it. The route needs no sign-in,
 * since a browser sends reports without one, so the lines it writes are capped per minute.
 *
 * In development the reports are also kept in memory, the newest few hundred, and `GET` returns
 * them: the Client's e2e suite reads them once it has run, and fails on any Trusted Types violation.
 */
import { dev } from '$app/environment'
import { json } from '@sveltejs/kit'
import { createLogBudget, parseCspReport, readLimitedText, type CspViolation } from '$lib/server/csp-report'
import { logger } from '$lib/server/logger'
import type { RequestHandler } from './$types'

/** A report is a few hundred bytes: anything far larger is not one. */
const MAX_REPORT_BYTES = 16 * 1024
const KEPT_IN_DEVELOPMENT = 500

/** One broken page sends a few reports a minute: many more than that is a loop or a flood. */
const logBudget = createLogBudget(60, 60_000)

const kept: CspViolation[] = []

export const POST: RequestHandler = async ({ request }) => {
    const body = await readLimitedText(request, MAX_REPORT_BYTES)
    if (body === null) return new Response(null, { status: 413 })
    const violation = parseCspReport(body)
    if (!violation) return new Response(null, { status: 400 })
    const turn = logBudget.take()
    if (turn) logger.warn('csp violation', turn.suppressed > 0 ? { ...violation, suppressed: turn.suppressed } : { ...violation })
    if (dev) {
        kept.push(violation)
        if (kept.length > KEPT_IN_DEVELOPMENT) kept.shift()
    }
    return new Response(null, { status: 204 })
}

export const GET: RequestHandler = () => (dev ? json(kept) : new Response(null, { status: 404 }))
