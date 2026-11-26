import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { ownArguments, startedWithAll } from './arguments.ts'

describe('what the app was started with', () => {
    it('is files, folders and links', () => {
        expect(startedWithAll(['notes/A.md', '/home/someone/Notes', 'file:///home/someone/My%20Notes/B.md'], '/tmp')).toEqual([
            { kind: 'path', path: '/tmp/notes/A.md' }, { kind: 'path', path: '/home/someone/Notes' }, { kind: 'path', path: '/home/someone/My Notes/B.md' },
        ])
        expect(startedWithAll(['etherpk:/graph/sync/1/d/Garden#task=3-ab'], '/tmp')).toEqual([{ kind: 'link', url: 'etherpk:/graph/sync/1/d/Garden#task=3-ab' }])
    })
    it('is not a switch, another address, or nothing', () => {
        for (const argument of ['--no-sandbox', '-x', '', 'https://example.com/a', 'javascript:alert(1)', 'file://server/share/a', 'file:///a%2Fb']) expect([argument, startedWithAll([argument], '/tmp')]).toEqual([argument, []])
    })
    it('a link that breaks into more arguments opens nothing but the link', () => {
        expect(startedWithAll(['etherpk:/graph/1', '/etc/hosts', '--renderer-cmd-prefix=x'], '/tmp')).toEqual([{ kind: 'link', url: 'etherpk:/graph/1' }])
    })
    it('leaves out the executable, and the folder of a development run', () => {
        expect(ownArguments(['/opt/EtherPK/etherpk', 'A.md'], null)).toEqual(['A.md'])
        expect(ownArguments(['electron', '--inspect=0', '/repo/apps/desktop', 'A.md'], '/repo/apps/desktop/')).toEqual(['A.md'])
    })
    it('property: a switch is never a path', () => {
        fc.assert(fc.property(fc.string(), (text) => { expect(startedWithAll([`-${text}`], '/tmp')).toEqual([]) }), { seed: 20261125 })
    })
})
