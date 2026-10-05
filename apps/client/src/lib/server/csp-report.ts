/**
 * Content Security Policy violation reports, as the browser sends them to `report-uri`
 * (`application/csp-report`): what was refused, on which page, and where in which script. Only
 * those fields are kept, every address without its query or fragment, since a page's address can
 * carry a sign-in code.
 */

export interface CspViolation {
    documentUri?: string
    effectiveDirective?: string
    violatedDirective?: string
    /** A blocked address, or `trusted-types-sink` and the like for a refused write. */
    blockedUri?: string
    sourceFile?: string
    lineNumber?: number
    columnNumber?: number
    /** The browser's sample of what was refused: for Trusted Types, the sink and the value's start. */
    sample?: string
    disposition?: string
}

const MAX_TEXT = 300
const MAX_SAMPLE = 200

/** The violation in a report body, or null when the body is not a report. */
export function parseCspReport(body: string): CspViolation | null {
    let parsed: unknown
    try {
        parsed = JSON.parse(body)
    } catch {
        return null
    }
    const report = (parsed as { 'csp-report'?: unknown } | null)?.['csp-report']
    if (typeof report !== 'object' || report === null) return null
    const fields = report as Record<string, unknown>
    const text = (key: string, max = MAX_TEXT) => (typeof fields[key] === 'string' ? (fields[key] as string).slice(0, max) : undefined)
    const number = (key: string) => (typeof fields[key] === 'number' ? (fields[key] as number) : undefined)
    return {
        documentUri: withoutQuery(text('document-uri')),
        effectiveDirective: text('effective-directive'),
        violatedDirective: text('violated-directive'),
        blockedUri: withoutQuery(text('blocked-uri')),
        sourceFile: withoutQuery(text('source-file')),
        lineNumber: number('line-number'),
        columnNumber: number('column-number'),
        sample: text('script-sample', MAX_SAMPLE),
        disposition: text('disposition'),
    }
}

/** An address without its query and fragment; a keyword such as `inline` stays as it is. */
function withoutQuery(value: string | undefined): string | undefined {
    if (value === undefined) return undefined
    const end = value.search(/[?#]/)
    return end === -1 ? value : value.slice(0, end)
}

/** The request body as text, or null when it is larger than `maxBytes`, declared or not. */
export async function readLimitedText(request: Request, maxBytes: number): Promise<string | null> {
    const declared = Number(request.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > maxBytes) return null
    if (!request.body) return ''
    const reader = request.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > maxBytes) {
            await reader.cancel()
            return null
        }
        chunks.push(value)
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
        bytes.set(chunk, offset)
        offset += chunk.byteLength
    }
    return new TextDecoder().decode(bytes)
}

/**
 * At most `perWindow` log lines in each window of `windowMs`, in this process. The route answers
 * every report the same way whether or not it logs it, so a page or a script sending reports in a
 * loop costs log volume only up to the budget. The first line written after some were held back
 * carries how many.
 */
export function createLogBudget(perWindow: number, windowMs: number, now: () => number = Date.now) {
    let windowStart = now()
    let written = 0
    let suppressed = 0
    return {
        /** `null` when the budget is spent; otherwise how many lines were held back since the last one written. */
        take(): { suppressed: number } | null {
            const at = now()
            if (at - windowStart >= windowMs) {
                windowStart = at
                written = 0
            }
            if (written >= perWindow) {
                suppressed += 1
                return null
            }
            written += 1
            const heldBack = suppressed
            suppressed = 0
            return { suppressed: heldBack }
        },
    }
}
