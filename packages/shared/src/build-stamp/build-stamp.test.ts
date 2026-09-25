import { describe, expect, it } from 'vitest'
import { buildStampComment, decorateHtmlWithBuildStamp } from './build-stamp'

const info = { commit: '697f1cf5a1b2c3d4e5f60718293a4b5c6d7e8f90', builtAt: '2026-08-31T09:15:00.000Z' }

describe('buildStampComment', () => {
    it('names the app, the commit and the build instant', () => {
        expect(buildStampComment('etherpk-client', info)).toBe(
            '<!-- etherpk-client commit 697f1cf5a1b2c3d4e5f60718293a4b5c6d7e8f90 built 2026-08-31T09:15:00.000Z -->',
        )
    })

    it('cannot be closed early by a hostile GIT_COMMIT value', () => {
        const stamp = buildStampComment('etherpk-client', { ...info, commit: '--><script>alert(1)</script>' })

        expect(stamp).not.toContain('<script>')
        expect(stamp.indexOf('-->')).toBe(stamp.length - 3)
    })

    it('reports unknown rather than an empty field', () => {
        expect(buildStampComment('etherpk-client', { commit: '', builtAt: '' })).toBe(
            '<!-- etherpk-client commit unknown built unknown -->',
        )
    })
})

describe('decorateHtmlWithBuildStamp', () => {
    const stamp = '<!-- etherpk-client commit abc built 2026-08-31T09:15:00.000Z -->'

    it('inserts the stamp immediately after the doctype', () => {
        expect(decorateHtmlWithBuildStamp('<!doctype html>\n<html lang="en">', stamp)).toBe(
            `<!doctype html>\n${stamp}\n<html lang="en">`,
        )
    })

    it('stamps only the first doctype it sees', () => {
        const html = '<!doctype html><html lang="en"><body>&lt;!doctype html&gt;<!doctype html></body>'

        expect(html.split(stamp).length - 1).toBe(0)
        expect(decorateHtmlWithBuildStamp(html, stamp).split(stamp).length - 1).toBe(1)
    })

    it('leaves a chunk without a doctype untouched', () => {
        expect(decorateHtmlWithBuildStamp('<div>tail chunk</div>', stamp)).toBe('<div>tail chunk</div>')
    })
})
