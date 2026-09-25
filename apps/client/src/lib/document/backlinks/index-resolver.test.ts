import { describe, expect, it } from 'vitest'

import { type IndexDoc, buildBacklinkIndex } from './backlink-index'
import { createIndexResolver } from './index-resolver'

function doc(partial: Partial<IndexDoc> & { concept: string }): IndexDoc {
    return { kind: 'page', aliases: [], text: '', ...partial }
}

describe('createIndexResolver', () => {
    const index = buildBacklinkIndex([
        doc({ concept: 'Quantum Mechanics', aliases: ['QM'] }),
        doc({ concept: 'Physics' }),
    ])
    const resolve = createIndexResolver(index)

    it('resolves an existing concept (not missing) to its slug', () => {
        expect(resolve('Physics')).toEqual({ href: 'physics.html', missing: false })
    })

    it('matches case-insensitively', () => {
        expect(resolve('physics').missing).toBe(false)
    })

    it('resolves an alias to the canonical slug, not missing', () => {
        expect(resolve('QM')).toEqual({ href: 'quantum-mechanics.html', missing: false })
    })

    it('marks an unknown concept as missing', () => {
        expect(resolve('Chemistry').missing).toBe(true)
    })
})
