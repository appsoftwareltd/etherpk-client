import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { NOT_FOUND_POLICY, PUBLIC_SETTINGS, accountIssuerOf, settingsFileOf, SETTINGS_FILE, bakedEnvironment, checkInstalledBuild, type InstalledAnswer, installedAnswer, installedSettings, isPageAddress, isShippedFile, staticPage } from '../installed-build'
import { variables } from './env'

const hash = (script: string) => `'sha256-${createHash('sha256').update(script).digest('base64')}'`

describe('the settings an Installed Build is made with', () => {
    it('has none unless the environment gives some', () => {
        expect(installedSettings({ PATH: '/bin', HOME: '/home/someone', DATABASE_PASSWORD: 'x' })).toEqual({ accountIssuer: null, webClientUrl: null, publicEnvironment: {} })
    })

    it('takes the account site and the managed Sync Server under names of their own', () => {
        expect(
            installedSettings({ INSTALLED_ACCOUNT_ISSUER: 'https://account.example.com', INSTALLED_MANAGED_SYNC_URL: 'https://sync.example.com', PUBLIC_DICTIONARY_URL: 'https://words.example.com/v1' }),
        ).toEqual({
            accountIssuer: 'https://account.example.com',
            webClientUrl: null,
            publicEnvironment: { PUBLIC_MANAGED_SYNC_URL: 'https://sync.example.com', PUBLIC_DICTIONARY_URL: 'https://words.example.com/v1' },
        })
    })

    it('names the account site one way, with no slash at the end, for the page and both shells', () => {
        for (const value of ['https://account.example.com', 'https://account.example.com/', ' https://account.example.com// ']) {
            expect(accountIssuerOf(value)).toBe('https://account.example.com')
        }
        expect(accountIssuerOf('http://localhost:5275/')).toBe('http://localhost:5275')
        expect(accountIssuerOf('')).toBeNull()
        expect(accountIssuerOf(undefined)).toBeNull()
        for (const value of ['http://account.example.com', 'https://someone:pw@account.example.com', 'account.example.com']) expect(() => accountIssuerOf(value)).toThrow(/https/)
        expect(installedSettings({ INSTALLED_ACCOUNT_ISSUER: 'https://account.example.com/' }).accountIssuer).toBe('https://account.example.com')
        expect(JSON.parse(settingsFileOf({ accountIssuer: 'https://account.example.com' }))).toEqual({ accountIssuer: 'https://account.example.com' })
    })

    it('reads an empty account site as none, and keeps an empty public setting, which turns a feature off', () => {
        expect(installedSettings({ INSTALLED_ACCOUNT_ISSUER: '', INSTALLED_MANAGED_SYNC_URL: '', PUBLIC_MAP_STYLE_URL: '' })).toEqual({
            accountIssuer: null,
            webClientUrl: null,
            publicEnvironment: { PUBLIC_MAP_STYLE_URL: '' },
        })
    })

    it('takes the web Client by its origin alone', () => {
        expect(installedSettings({ INSTALLED_WEB_CLIENT_URL: 'https://notes.example.com/graphs' }).webClientUrl).toBe('https://notes.example.com')
        expect(() => installedSettings({ INSTALLED_WEB_CLIENT_URL: 'http://notes.example.com' })).toThrow(/INSTALLED_WEB_CLIENT_URL/)
    })

    it('refuses a setting it has no list entry for, so a misspelt name cannot pass silently', () => {
        expect(() => installedSettings({ PUBLIC_API_SECRET: 'x' })).toThrow(/PUBLIC_API_SECRET/)
        expect(() => installedSettings({ INSTALLED_ISSUER: 'https://account.example.com' })).toThrow(/INSTALLED_ISSUER/)
        expect(() => installedSettings({ PUBLIC_MANAGED_SYNC_URL: 'https://sync.example.com' })).toThrow(/INSTALLED_MANAGED_SYNC_URL/)
    })

    it.each(['http://sync.example.com', 'not an address', 'https://name:word@sync.example.com', 'javascript:alert(1)'])('refuses %s as an address', (url) => {
        expect(() => installedSettings({ INSTALLED_MANAGED_SYNC_URL: url })).toThrow(/INSTALLED_MANAGED_SYNC_URL/)
    })

    it('takes a server on this machine over plain HTTP, for a test build', () => {
        expect(installedSettings({ INSTALLED_MANAGED_SYNC_URL: 'http://localhost:5174' }).publicEnvironment.PUBLIC_MANAGED_SYNC_URL).toBe('http://localhost:5174')
    })

    it('lists only settings the Client declares as public', () => {
        const declared = Object.entries(variables).filter(([, variable]) => (variable as { public?: boolean }).public).map(([name]) => name)
        expect([...PUBLIC_SETTINGS].sort()).toEqual(declared.sort())
    })

    it('never carries a name that is not public, whatever the environment holds', () => {
        fc.assert(
            fc.property(fc.dictionary(fc.stringMatching(/^[A-Z][A-Z_]{0,12}$/), fc.string()), (environment) => {
                let settings
                try {
                    settings = installedSettings(environment)
                } catch {
                    return
                }
                for (const name of Object.keys(settings.publicEnvironment)) expect(PUBLIC_SETTINGS.has(name)).toBe(true)
            }),
            { seed: 20261125, numRuns: 300 },
        )
    })
})

const NONCE = 'AbC+/=='
const PAGE = `<!doctype html><html><head><link rel="manifest" href="/site.webmanifest" /><script>theme()</script>
<link nonce="${NONCE}" href="/_app/immutable/a.js" rel="modulepreload"></head><body><script nonce="${NONCE}">
 { x = { env: {PUBLIC_DICTIONARY_URL:void 0} } }
</script><script src="/x.js" nonce="${NONCE}"></script></body></html>`
const POLICY = `default-src 'self'; script-src 'self' 'wasm-unsafe-eval' 'sha256-stale=' 'nonce-${NONCE}'; frame-ancestors 'none'; report-uri /api/csp-report; trusted-types default`

describe('a captured page', () => {
    const page = staticPage(PAGE, POLICY)

    it('lets a form send itself only to the app, which has no server to take it', () => {
        expect(page.policy.split('; ')).toContain("form-action 'self'")
        expect(staticPage(PAGE, `${POLICY}; form-action 'none'`).policy.split('; ').filter((directive) => directive.startsWith('form-action'))).toEqual(["form-action 'none'"])
    })

    it('loses its nonce everywhere, in the page and in the policy', () => {
        expect(page.html).not.toContain('nonce')
        expect(page.policy).not.toContain('nonce')
        expect(page.html).toContain('<script src="/x.js"></script>')
    })

    it('has every inline script named by its hash, and no hash of a script it does not hold', () => {
        const scriptSrc = page.policy.split('; ').find((directive) => directive.startsWith('script-src'))!
        const inline = [...page.html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1])
        expect(inline).toHaveLength(2)
        expect(scriptSrc).toBe(`script-src 'self' 'wasm-unsafe-eval' ${inline.map(hash).join(' ')}`)
    })

    it('reports violations nowhere, having no server, and keeps the rest of the policy', () => {
        expect(page.policy).not.toContain('report-uri')
        expect(page.policy).toContain("frame-ancestors 'none'")
        expect(page.policy).toContain('trusted-types default')
    })

    it('offers no web app manifest, as nothing installs it', () => {
        expect(page.html).not.toContain('manifest')
    })

    it('is refused when the policy has no script-src to narrow', () => {
        expect(() => staticPage(PAGE, "default-src 'self'")).toThrow(/script-src/)
    })

    it('hashes every inline script there is, whatever it holds', () => {
        const script = fc.string().filter((text) => !/<\/script|nonce|<script/i.test(text))
        fc.assert(
            fc.property(fc.array(script, { minLength: 1, maxLength: 5 }), (scripts) => {
                const result = staticPage(scripts.map((text) => `<script nonce="${NONCE}">${text}</script>`).join(''), POLICY)
                for (const text of scripts) expect(result.policy).toContain(hash(text))
            }),
            { seed: 20261125, numRuns: 200 },
        )
    })
})

describe('the environment a page was built with', () => {
    it('is read back as the names it holds and their values', () => {
        expect(bakedEnvironment('x = {base:"",env:{PUBLIC_A:void 0,PUBLIC_B:"https://b.example.com/{z}",PUBLIC_C:""}};')).toEqual({
            PUBLIC_A: undefined,
            PUBLIC_B: 'https://b.example.com/{z}',
            PUBLIC_C: '',
        })
    })

    it('is refused where none can be found, rather than taken to be empty', () => {
        expect(() => bakedEnvironment('<script>start()</script>')).toThrow(/env/)
    })
})

/** The cases every shell is checked against: apps/desktop and apps/android read the same file. */
const serving = JSON.parse(readFileSync(new URL('../../../packages/native-bridge/test-vectors/installed-build-serving.json', import.meta.url), 'utf8')) as {
    files: Record<string, string>
    shellPolicy: string
    notFoundPolicy: string
    requests: { path: string; navigation: boolean; method?: string; status: number; body?: string; policy: string }[]
    pageAddresses: [string, boolean][]
}

describe('which addresses with no file a shell answers with the shell page', () => {
    it.each(serving.pageAddresses)('%s: %s', (path, page) => expect(isPageAddress(path)).toBe(page))
})

describe('what a shell answers', () => {
    const has = (file: string) => file in serving.files
    const policyOf = (answer: InstalledAnswer) => (answer.status === 200 ? serving.files[answer.policyFile].trim() : NOT_FOUND_POLICY)

    it.each(serving.requests.map((request) => [`${request.method ?? 'GET'} ${request.path}${request.navigation ? ' (navigation)' : ''}`, request] as const))('%s', (_name, request) => {
        const answer = installedAnswer({ method: request.method ?? 'GET', path: request.path, navigation: request.navigation }, has)
        expect(answer.status).toBe(request.status)
        if (answer.status === 200) expect(serving.files[answer.file]).toBe(request.body)
        expect(policyOf(answer)).toBe(request.policy)
    })

    it('property: asks for no file outside the build or of a policy, whatever the path', () => {
        const part = fc.constantFrom('..', '%2e%2e', '.', '', '%2f', '%5c', '\\', '%00', 'csp.txt', 'index.html', 'a.csp.txt', '_app', 'Garden')
        fc.assert(fc.property(fc.array(part, { maxLength: 6 }), fc.boolean(), (parts, navigation) => {
            const asked: string[] = []
            installedAnswer({ method: 'GET', path: `/${parts.join('/')}`, navigation }, (file) => {
                asked.push(file)
                return false
            })
            for (const file of asked) {
                // The one policy file asked of is the page's own, beside a page the build holds.
                if (file.endsWith('csp.txt')) expect(file).toMatch(/\.html\.csp\.txt$/)
                expect(file.split('/')).not.toContain('..')
                expect(file.startsWith('/')).toBe(false)
            }
        }), { seed: 20261126, numRuns: 500 })
    })
})

describe('which files an Installed Build ships', () => {
    it.each([
        ['_app/immutable/chunks/a.js', true],
        ['_app/immutable/chunks/a.js.br', false],
        ['_app/immutable/chunks/a.js.gz', false],
        ['extensions/graph-view/1.0.0/dist/main.js', true],
        ['extensions/graph-view/1.0.0/dist/main.js.map', false],
        ['demo-graph/pages/Garden.md', true],
        ['marketing/editor-dark.webp', false],
        ['screenshots/editor-wide.jpg', false],
        ['site.webmanifest', false],
        ['robots.txt', false],
        ['service-worker.js', false],
        ['favicon.svg', true],
        ['icon-512.png', true],
    ])('%s: %s', (path, shipped) => expect(isShippedFile(path)).toBe(shipped))
})

describe('the check on a finished Installed Build', () => {
    const { html, policy } = staticPage(PAGE, POLICY)
    const good = () => new Map<string, string | Uint8Array>([
        ['index.html', html],
        ['csp.txt', policy],
        [SETTINGS_FILE, settingsFileOf({ accountIssuer: null })],
        ['_app/env.js', 'export const env={PUBLIC_DICTIONARY_URL:void 0}'],
        ['_app/immutable/a.js', 'x()'],
        ['x.js', 'x()'],
        ['service-worker.js', 'y()'],
        ['__etherpk-ebook/reader.html', '<!doctype html>'],
        ['__etherpk-ebook/reader.html.csp.txt', "default-src 'none'"],
    ])
    const problems = (change: (files: Map<string, string | Uint8Array>) => void, secrets: Record<string, string> = {}) => {
        const files = good()
        change(files)
        return checkInstalledBuild(files, { secrets, sizeLimit: 10_000 })
    }

    it('passes one with nothing wrong', () => expect(problems(() => {})).toEqual([]))
    it('finds a missing file the shell needs', () => expect(problems((files) => files.delete('csp.txt')).join()).toContain('csp.txt'))
    it('finds a file the page loads and the build does not hold', () => expect(problems((files) => files.delete('_app/immutable/a.js')).join()).toContain('_app/immutable/a.js'))
    it('finds a nonce', () => expect(problems((files) => files.set('index.html', html.replace('<script>', '<script nonce="a">'))).join()).toContain('nonce'))
    it('finds an inline script the policy does not name', () => expect(problems((files) => files.set('index.html', html.replace('</body>', '<script>more()</script></body>'))).join()).toContain('hash'))
    it('finds a setting that is not public', () => {
        const page = staticPage(PAGE.replace('PUBLIC_DICTIONARY_URL:void 0', 'CLIENT_KEY:"abc"'), POLICY)
        expect(problems((files) => files.set('index.html', page.html).set('csp.txt', page.policy)).join()).toContain('CLIENT_KEY')
        expect(problems((files) => files.set('_app/env.js', 'export const env={CLIENT_KEY:"abc"}')).join()).toContain('CLIENT_KEY')
    })
    it('finds the value of a private setting in any file', () => {
        expect(problems((files) => files.set('x.js', 'let a="a-long-secret-value"'), { CLIENT_SESSION_SECRET: 'a-long-secret-value' }).join()).toContain('CLIENT_SESSION_SECRET')
        // Never the value itself: what this says goes to a build log.
        expect(problems((files) => files.set('x.js', 'let a="a-long-secret-value"'), { CLIENT_SESSION_SECRET: 'a-long-secret-value' }).join()).not.toContain('a-long-secret-value')
    })
    it('finds one too large', () => expect(problems((files) => files.set('big.bin', new Uint8Array(20_000))).join()).toMatch(/bytes/))
    it('finds a file that should not ship', () => expect(problems((files) => files.set('x.js.map', '{}')).join()).toContain('x.js.map'))
})
