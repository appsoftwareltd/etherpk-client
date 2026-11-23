import { describe, expect, it } from 'vitest'

import { graphExportStem } from './export-stem'

describe('graphExportStem', () => {
    it('is the graph name, made safe for a file name', () => {
        expect(graphExportStem('Notes General', 'g1')).toBe('Notes General')
        expect(graphExportStem('Work / Home', 'g1')).not.toContain('/')
    })

    it('calls a graph with no name "Graph", as the Explorer tab does, never "_"', () => {
        expect(graphExportStem('', 'g1')).toBe('Graph')
        expect(graphExportStem('   ', 'g1')).toBe('Graph')
        expect(graphExportStem('g1', 'g1')).toBe('Graph')
    })
})
