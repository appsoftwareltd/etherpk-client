import { EditorSelection, EditorState } from '@codemirror/state'
import { afterEach, describe, expect, it } from 'vitest'

import { registerEditorCommands } from '$lib/document/commands/editor-commands'
import { editorAnalysis } from '$lib/document/view/analysis/editor-analysis'
import { interactiveFenceAugmentation } from '$lib/document/view/augmentations/interactive-fence'
import { registerInteractiveFence } from '$lib/document/view/augmentations/interactive-fence-contract'
import { setActiveContributionRegistry } from '$lib/surface'
import { commandMenuItemsInOrder, listCommandMenuItems } from '$lib/surface/command-menu'
import { createContributionRegistry } from '$lib/surface/contribution-registry'

import { mapInsertable, mapInsertPlan, registerMapCommands } from './map-commands'
import { mapsContext } from './testing'

// Where `/map` is offered (ADR 0118): wherever a map can be drawn and written, and never where it
// would not be drawn or would break what is there.

function titles(context: Partial<Parameters<typeof listCommandMenuItems>[1]> = {}): string[] {
    const maps = mapsContext()
    registerMapCommands(maps.context, { unfoldEmpty: () => {}, requestFocus: () => {} })
    return listCommandMenuItems(maps.services.contributions, { inTable: false, tableInsertable: true, bodyWritable: true, ...context }).map((item) => item.title)
}

describe('/map', () => {
    it('is offered in a page that can be written', () => {
        expect(titles()).toContain('Map')
    })

    it('is not offered in a Protected Document, unlocked or not, where no map is drawn', () => {
        expect(titles({ protectedDocument: true })).not.toContain('Map')
    })

    it('is not offered on a locked page, nor inside a table', () => {
        expect(titles({ bodyWritable: false })).not.toContain('Map')
        expect(titles({ inTable: true })).not.toContain('Map')
    })

    it("sits among the Client's rows straight after Table, with the other blocks a person puts in", () => {
        // The whole first-party order is written down in the Client's command-menu-order.test.ts.
        const maps = mapsContext()
        registerEditorCommands(maps.services.commands, maps.services.contributions)
        registerMapCommands(maps.context, { unfoldEmpty: () => {}, requestFocus: () => {} })
        const all = commandMenuItemsInOrder(maps.services.contributions).map((item) => item.title)
        expect(all[all.indexOf('Table') + 1]).toBe('Map')
    })
})

// Where the map goes is read from the caret's line, and never inside the frontmatter or a fenced block
// (a map's text shown, a code sample at any depth), where a map is refused as a table is.
describe('/map by the caret', () => {
    afterEach(() => setActiveContributionRegistry(null))

    function stateAt(doc: string, caret: number): EditorState {
        const registry = createContributionRegistry()
        registerInteractiveFence(registry, 'map', { height: () => 320, mount: () => ({ update: () => {}, destroy: () => {} }) })
        setActiveContributionRegistry(registry)
        return EditorState.create({ doc, selection: EditorSelection.cursor(caret), extensions: [editorAnalysis(), interactiveFenceAugmentation()] })
    }

    /** The document once the plan is applied, with `|` where the caret waits. */
    function plan(doc: string, caret: number) {
        const p = mapInsertPlan(stateAt(doc, caret))
        const text = doc.slice(0, p.from) + p.insert + doc.slice(p.to)
        return `${text.slice(0, p.caret)}|${text.slice(p.caret)}`
    }

    const map = '```map\nA @ 1, 2\n```'
    const blocks = ['```mermaid\ngraph TD\n```', map, '| Day | Place |\n| --- | --- |\n| 1 | Harbour |', '![Plan](plan.png)']

    it('reads the caret by its line, and adds nothing between the new map and one below', () => {
        expect(plan(`Intro\n${map}`, 2)).toBe(`Intro|\n\`\`\`map\n\`\`\`\n${map}`)
    })

    it('waits beside a map that took its line on whichever line beside it no block starts or ends on', () => {
        for (const block of blocks) {
            expect(plan(`Intro\n\n${block}`, 'Intro\n'.length)).toBe(`Intro|\n\`\`\`map\n\`\`\`\n${block}`)
            expect(plan(`${block}\n\nAfter`, `${block}\n`.length)).toBe(`${block}\n\`\`\`map\n\`\`\`\n|After`)
        }
        expect(plan('Intro\n\nAfter', 'Intro\n'.length)).toBe('Intro\n```map\n```\n|After')
    })

    it('adds a line after a map that would be all the document holds after its frontmatter', () => {
        expect(plan('', 0)).toBe('```map\n```\n|')
        expect(plan('---\ntitle: Trips\n---\n', '---\ntitle: Trips\n---\n'.length)).toBe('---\ntitle: Trips\n---\n```map\n```\n|')
    })

    it('is refused in a map whose text the caret is in, and in a code block', () => {
        expect(mapInsertable(stateAt(`${map}\nAfter`, 0))).toBe(false)
        expect(mapInsertable(stateAt(`${map}\nAfter`, '```map\nA @'.length))).toBe(false)
        expect(mapInsertable(stateAt('Intro\n```js\nx\n```', 'Intro\n```js\nx'.length))).toBe(false)
        expect(mapInsertable(stateAt(`${map}\nAfter`, `${map}\nAf`.length))).toBe(true)
    })

    it('is refused in a code sample that holds a fenced block of its own, on the inner block\'s lines too', () => {
        const sample = ['````markdown', '- item', '  ```js', '  x', '  ```', '````', 'After'].join('\n')
        expect(mapInsertable(stateAt(sample, sample.indexOf('  x') + 3))).toBe(false)
        expect(mapInsertable(stateAt(sample, sample.indexOf('- item') + 3))).toBe(false)
        expect(mapInsertable(stateAt(sample, sample.length))).toBe(true)
    })

    it('is refused in the frontmatter, its closing line included', () => {
        const doc = '---\ntitle: T\n---\nBody'
        expect(mapInsertable(stateAt(doc, 'title'.length))).toBe(false)
        expect(mapInsertable(stateAt(doc, '---\ntitle: T\n---'.length))).toBe(false)
        expect(mapInsertable(stateAt(doc, doc.length))).toBe(true)
    })
})
