import { describe, expect, it } from 'vitest'
import { createLogBudget, parseCspReport, readLimitedText } from './csp-report'

/** A report as Chromium sends one to `report-uri` for a write Trusted Types refused. */
const TRUSTED_TYPES_REPORT = {
    'csp-report': {
        'document-uri': 'https://app.example.com/g/graph-1?code=secret#part',
        referrer: '',
        'violated-directive': 'require-trusted-types-for',
        'effective-directive': 'require-trusted-types-for',
        'original-policy': "require-trusted-types-for 'script'",
        disposition: 'enforce',
        'blocked-uri': 'trusted-types-sink',
        'line-number': 12,
        'column-number': 34,
        'source-file': 'https://app.example.com/_app/immutable/chunks/x.js?v=1',
        'status-code': 200,
        'script-sample': 'Element innerHTML|<img src=x onerror=alert(1)>',
    },
}

describe('reading a CSP violation report', () => {
    it('keeps the fields that say what was refused and where', () => {
        expect(parseCspReport(JSON.stringify(TRUSTED_TYPES_REPORT))).toEqual({
            documentUri: 'https://app.example.com/g/graph-1',
            effectiveDirective: 'require-trusted-types-for',
            violatedDirective: 'require-trusted-types-for',
            blockedUri: 'trusted-types-sink',
            sourceFile: 'https://app.example.com/_app/immutable/chunks/x.js',
            lineNumber: 12,
            columnNumber: 34,
            sample: 'Element innerHTML|<img src=x onerror=alert(1)>',
            disposition: 'enforce',
        })
    })

    it('leaves out the query and fragment of every address, which can carry a sign-in code', () => {
        const parsed = parseCspReport(JSON.stringify(TRUSTED_TYPES_REPORT))!
        expect(JSON.stringify(parsed)).not.toContain('secret')
    })

    it('refuses what is not a report', () => {
        expect(parseCspReport('not json')).toBeNull()
        expect(parseCspReport('{}')).toBeNull()
        expect(parseCspReport('{"csp-report": "text"}')).toBeNull()
    })

    it('cuts long values short', () => {
        const long = { 'csp-report': { ...TRUSTED_TYPES_REPORT['csp-report'], 'script-sample': 'x'.repeat(5000) } }
        expect(parseCspReport(JSON.stringify(long))!.sample).toHaveLength(200)
    })
})

describe('reading a request body up to a limit', () => {
    const request = (body: string, headers: Record<string, string> = {}) =>
        new Request('https://app.example.com/api/csp-report', { method: 'POST', body, headers })

    it('reads a body within the limit', async () => {
        await expect(readLimitedText(request('hello'), 16)).resolves.toBe('hello')
    })

    it('refuses a body over the limit, whether or not its length was declared', async () => {
        await expect(readLimitedText(request('x'.repeat(17)), 16)).resolves.toBeNull()
        await expect(readLimitedText(request('short', { 'content-length': '999999' }), 16)).resolves.toBeNull()
    })
})

describe('the budget of violation log lines', () => {
    it('lets a set number of lines through in each window, then holds the rest back', () => {
        let now = 0
        const budget = createLogBudget(3, 60_000, () => now)

        const taken = [budget.take(), budget.take(), budget.take(), budget.take(), budget.take()]

        expect(taken).toEqual([{ suppressed: 0 }, { suppressed: 0 }, { suppressed: 0 }, null, null])
        now = 59_999
        expect(budget.take()).toBeNull()
    })

    it('says, on the first line of the next window, how many were held back', () => {
        let now = 0
        const budget = createLogBudget(1, 60_000, () => now)
        budget.take()
        budget.take()
        budget.take()

        now = 60_000
        expect(budget.take()).toEqual({ suppressed: 2 })
        expect(budget.take()).toBeNull()
        now = 120_000
        expect(budget.take()).toEqual({ suppressed: 1 })
    })
})
