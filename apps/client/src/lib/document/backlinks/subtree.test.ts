import { describe, expect, it } from 'vitest'

import { nestSubtree } from './subtree'

describe('nestSubtree', () => {
    it('nests a subtree listed in document order by depth', () => {
        const nodes = [
            { id: 'a', depth: 0 },
            { id: 'a1', depth: 1 },
            { id: 'a1x', depth: 2 },
            { id: 'a2', depth: 1 },
        ]
        expect(nestSubtree(nodes)).toEqual([
            {
                node: nodes[0],
                children: [
                    { node: nodes[1], children: [{ node: nodes[2], children: [] }] },
                    { node: nodes[3], children: [] },
                ],
            },
        ])
    })

    it('gives a leaf no children, and nothing for nothing', () => {
        expect(nestSubtree([{ depth: 0 }])).toEqual([{ node: { depth: 0 }, children: [] }])
        expect(nestSubtree([])).toEqual([])
    })
})
