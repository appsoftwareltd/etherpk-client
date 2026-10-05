import { describe, expect, it } from 'vitest'
import { defaultPolicyRules, setSandboxedSrcdoc } from './trusted-types'

/** Enough of an iframe for the srcdoc helper: its sandbox tokens and the property it sets. */
function frame(sandbox: string[]) {
    return { sandbox: { contains: (token: string) => sandbox.includes(token) }, srcdoc: '' } as unknown as HTMLIFrameElement
}

describe('a page shown in a sandboxed frame (ADR 0130)', () => {
    it('is given to a frame with an opaque origin', () => {
        const opaque = frame(['allow-scripts'])
        setSandboxedSrcdoc(opaque, '<p>preview</p>')
        expect(opaque.srcdoc).toBe('<p>preview</p>')
    })

    it('is refused to a frame that shares the app’s origin, where it could reach the app', () => {
        const shared = frame(['allow-scripts', 'allow-same-origin'])
        expect(() => setSandboxedSrcdoc(shared, '<p>preview</p>')).toThrow('must not share the app')
        expect(shared.srcdoc).toBe('')
    })
})

const ORIGIN = 'https://app.example.com'
const sanitize = (html: string) => `[clean]${html.replace(/<script[\s\S]*?<\/script>/g, '')}`
const rules = defaultPolicyRules(sanitize, ORIGIN)

describe('the default Trusted Types policy (ADR 0130)', () => {
    it('passes text with no markup as it is, which is how libraries write style text and labels', () => {
        expect(rules.createHTML('fill: red; stroke: blue')).toBe('fill: red; stroke: blue')
        expect(rules.createHTML('A label')).toBe('A label')
    })

    it('sends anything with markup through the sanitizer', () => {
        expect(rules.createHTML('<b>bold</b><script>alert(1)</script>')).toBe('[clean]<b>bold</b>')
        expect(rules.createHTML('1 < 2')).toBe('[clean]1 < 2')
    })

    it('takes script URLs from this origin only, its own blob URLs included', () => {
        expect(rules.createScriptURL('/sw.js')).toBe('/sw.js')
        expect(rules.createScriptURL(`${ORIGIN}/_app/immutable/workers/index.js`)).toBe(`${ORIGIN}/_app/immutable/workers/index.js`)
        expect(rules.createScriptURL(`blob:${ORIGIN}/0f1e2d3c`)).toBe(`blob:${ORIGIN}/0f1e2d3c`)
    })

    it('refuses script URLs from anywhere else, and ones that carry script themselves', () => {
        expect(rules.createScriptURL('https://cdn.example.net/x.js')).toBeNull()
        expect(rules.createScriptURL('//cdn.example.net/x.js')).toBeNull()
        expect(rules.createScriptURL('blob:https://other.example/0f1e2d3c')).toBeNull()
        expect(rules.createScriptURL('data:text/javascript,alert(1)')).toBeNull()
        expect(rules.createScriptURL('javascript:alert(1)')).toBeNull()
    })

    it('refuses script text', () => {
        expect(rules.createScript('alert(1)')).toBeNull()
    })
})
