import { contentSecurityPolicy, html } from 'virtual:etherpk-ebook-frame'

import type { RequestHandler } from './$types'

/**
 * The page an EBook reads in (ADR 0181). It holds no script of its own: a `data:` document inside it has
 * the opaque origin the EBook reads in, and takes its policy from this response rather than the app's.
 * The service worker keeps a copy with this version's files, for reading offline.
 */
export const GET: RequestHandler = () =>
    new Response(html, {
        headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Content-Security-Policy': contentSecurityPolicy,
            'Cache-Control': 'no-cache',
        },
    })
