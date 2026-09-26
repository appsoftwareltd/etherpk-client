import { describe, expect, it } from 'vitest'

import { withDiagramId } from './diagram-id'

describe('withDiagramId', () => {
    it('renames the root id and everything Mermaid scoped to it', () => {
        const svg =
            '<svg id="gk-mermaid-4" aria-labelledby="chart-title-gk-mermaid-4"><style>#gk-mermaid-4{font:x}#gk-mermaid-4 .node rect{fill:#ECECFF}</style><marker id="gk-mermaid-4_flowchart-pointEnd"></marker><path marker-end="url(#gk-mermaid-4_flowchart-pointEnd)"></path></svg>'
        expect(withDiagramId(svg, 'mermaid-guide-1')).toBe(
            '<svg id="mermaid-guide-1" aria-labelledby="chart-title-mermaid-guide-1"><style>#mermaid-guide-1{font:x}#mermaid-guide-1 .node rect{fill:#ECECFF}</style><marker id="mermaid-guide-1_flowchart-pointEnd"></marker><path marker-end="url(#mermaid-guide-1_flowchart-pointEnd)"></path></svg>',
        )
    })

    it('never renames a longer id that starts with this one', () => {
        const svg = '<svg id="gk-mermaid-4"><style>#gk-mermaid-4 a{}</style><text>gk-mermaid-41</text></svg>'
        expect(withDiagramId(svg, 'd-1')).toBe('<svg id="d-1"><style>#d-1 a{}</style><text>gk-mermaid-41</text></svg>')
    })

    it('restores the id from the styles when the root has lost it', () => {
        const svg = '<svg class="flowchart"><style>#gk-mermaid-2 .node rect{fill:#ECECFF}</style></svg>'
        expect(withDiagramId(svg, 'mermaid-x-1')).toBe('<svg id="mermaid-x-1" class="flowchart"><style>#mermaid-x-1 .node rect{fill:#ECECFF}</style></svg>')
    })

    it('leaves a drawing with nothing scoped alone', () => {
        expect(withDiagramId('<svg><rect></rect></svg>', 'mermaid-x-1')).toBe('<svg><rect></rect></svg>')
    })
})
