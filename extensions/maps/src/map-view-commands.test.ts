import { EditorSelection, EditorState, type TransactionSpec } from '@codemirror/state'
import { type EditorView, showTooltip } from '@codemirror/view'
import { afterEach, describe, expect, it } from 'vitest'

import { setActiveEditorView } from '$lib/document/active-editor'
import { conceptPicker } from '$lib/document/view/augmentations/concept-picker'
import { editorDocument } from '$lib/document/view/editor-document'
import { commandMenuDetail, commandMenuItemsInOrder, listCommandMenuItems } from '$lib/surface/command-menu'
import { listContextMenuItems } from '$lib/surface/context-menu'
import { graphSidebarButtons } from '$lib/surface'

import { MAP_WHOLE_KIND, MAPS_OPEN_AT_CARET, MAPS_OPEN_FOR, MAPS_OPEN_WHOLE } from './identity'
import { registerMapViewCommands } from './map-view-commands'
import { mapsContext } from './testing'

// The ways to a [[Map View]] (ADR 0118): a document tab's row, the Command Menu's Map View row for
// a concept at the caret, its whole graph row, and Open page on a map's own tab. Every device.

/** The Commands registered through the context the Client builds, and where they asked to open things. */
function setup(options: { desktop?: boolean } = {}) {
    const { context, services } = mapsContext(options)
    registerMapViewCommands(context)
    type Opened = [{ kind: string; target: string } | string, { inPaneOf?: string; beside?: string } | undefined]
    const calls = (mock: unknown) => (mock as { mock: { calls: Opened[] } }).mock.calls
    return {
        commands: services.commands,
        contributions: services.contributions,
        /** Each map opened: its concept, or null for the whole graph's, and the panel whose Pane it was asked into. */
        get opened() {
            return calls(services.layout.openView).map(([view, options]) => {
                const ref = view as { kind: string; target: string }
                return [ref.kind === MAP_WHOLE_KIND ? null : ref.target, options?.inPaneOf]
            })
        },
        /** Each page opened: its concept and the panel whose Pane it was asked into. */
        get pages() {
            return calls(services.layout.openDocument).map(([concept, options]) => [concept as string, options?.inPaneOf])
        },
        /** How the graph resolves names, which a test may change. */
        concepts: services.concepts,
    }
}

describe("a document tab's Open Map View row", () => {
    it("opens the Map View of the tab's concept, in the tab's Pane, on a phone as on a desktop", async () => {
        const maps = setup()
        const tab = { kind: 'document-tab', concept: 'Campsites', panelId: 'document:Campsites', vertical: true } as const
        const row = listContextMenuItems(maps.contributions, tab).find((r) => r.label === 'Open Map View')
        // The manifest's icon, which the Client holds under the extension's id.
        expect(row?.icon).toBe('maps.map')
        await maps.commands.execute(row!.command, tab)
        expect(maps.opened).toEqual([['Campsites', 'document:Campsites']])
    })

    it('is not offered on a favourite or a recent, which are not tabs', () => {
        const { contributions } = setup()
        expect(listContextMenuItems(contributions, { kind: 'favourite', concept: 'Campsites' }).map((r) => r.label)).not.toContain('Open Map View')
    })
})

describe("a wikilink's Open Map View row", () => {
    it('opens the Map View of the concept the link names, under the name it resolves to, in the Pane of the editor holding the link, on a phone as on a desktop', async () => {
        const maps = setup({ desktop: false })
        // An alias, resolved to its page, as following the link would.
        maps.concepts.canonicalName = (name) => (name === 'camping' ? 'Campsites' : name)
        const link = { kind: 'wikilink', concept: 'camping', panelId: 'document:Trips' } as const
        const row = listContextMenuItems(maps.contributions, link).find((r) => r.label === 'Open Map View')
        expect(row?.icon).toBe('maps.map')
        await maps.commands.execute(row!.command, link)
        expect(maps.opened).toEqual([['Campsites', 'document:Trips']])
    })
})

describe("the Graph Sidebar's Graph Map View button", () => {
    it("opens the Graph Map View, with the map's own icon", async () => {
        const maps = setup()
        const [button] = graphSidebarButtons(maps.contributions)
        expect([button.title, button.icon]).toEqual(['Graph Map View', 'maps.map'])
        await maps.commands.execute(button.command, button.args)
        expect(maps.opened).toEqual([[null, undefined]])
    })
})

describe("a Map View tab's context menu", () => {
    it("offers Open page on a concept's map, which opens the concept in the map's Pane", async () => {
        const maps = setup()
        const tab = { kind: 'tab', panelId: 'maps.map:Campsites' } as const
        const rows = listContextMenuItems(maps.contributions, tab)
        expect(rows.map((r) => r.label)).toEqual(['Open page'])
        await maps.commands.execute(rows[0].command, tab)
        expect(maps.pages).toEqual([['Campsites', 'maps.map:Campsites']])
    })

    it("offers nothing on the Graph Map View, which is about no one concept", () => {
        const { contributions } = setup()
        expect(listContextMenuItems(contributions, { kind: 'tab', panelId: 'maps.whole:whole' })).toEqual([])
    })
})

describe('the Command Menu rows', () => {
    const editing = { inTable: false, tableInsertable: true, bodyWritable: true }

    it('offers the Map View of a concept here and the Graph Map View, on a locked page too', () => {
        const titles = listCommandMenuItems(setup().contributions, { ...editing, bodyWritable: false }).map((item) => item.title)
        expect(titles).toContain('Open Map View')
        expect(titles).toContain('Graph Map View')
    })

    it('says which concept the Map View is for, and how many more the picker offers', () => {
        const row = commandMenuItemsInOrder(setup().contributions).find((item) => item.title === 'Open Map View')!
        expect(commandMenuDetail(row, { ...editing, conceptsAtCaret: ['Garden'] })).toBe('For Garden')
        expect(commandMenuDetail(row, { ...editing, conceptsAtCaret: ['Garden', 'Kitchen'] })).toBe('For Garden and 1 more')
    })

    it("opens the Graph Map View, and the map a pick in the list names, in the Pane they were asked from", async () => {
        const maps = setup()
        await maps.commands.execute(MAPS_OPEN_WHOLE)
        await maps.commands.execute(MAPS_OPEN_FOR, { concept: 'Campsites', panelId: 'document:Trips' })
        expect(maps.opened).toEqual([
            [null, undefined],
            ['Campsites', 'document:Trips'],
        ])
    })
})

describe('the Map View row at the caret', () => {
    /** A focused editor over `doc` for the page `concept`, caret at the end: what the Command reads. */
    function focusedEditor(doc: string, concept: string, hasFocus = true) {
        let state = EditorState.create({
            doc,
            selection: EditorSelection.cursor(doc.length),
            extensions: [conceptPicker(), editorDocument.of({ concept, panelId: `document:${concept}` })],
        })
        const view = {
            get state() {
                return state
            },
            dispatch(...specs: TransactionSpec[]) {
                state = state.update(...specs).state
            },
            hasFocus,
        } as unknown as EditorView
        setActiveEditorView(view)
        return view
    }

    afterEach(() => setActiveEditorView(null))

    it('opens the map at once when the caret answers to one concept, beside the editor', async () => {
        const maps = setup()
        focusedEditor('- Pebble Cove was lovely', 'Trips')
        await maps.commands.execute(MAPS_OPEN_AT_CARET)
        expect(maps.opened).toEqual([['Trips', 'document:Trips']])
    })

    it('offers a choice at the caret when it answers to several, and opens nothing yet', async () => {
        const maps = setup()
        const view = focusedEditor('- [[Campsites]]\n  - Pebble Cove was lovely', 'Trips')
        await maps.commands.execute(MAPS_OPEN_AT_CARET)
        expect(maps.opened).toEqual([])
        expect(view.state.facet(showTooltip).some(Boolean)).toBe(true)
    })

    it('does nothing from an editor that is not focused, where a list would get none of the keys', async () => {
        const maps = setup()
        focusedEditor('- [[Campsites]]\n  - Pebble Cove', 'Trips', false)
        await maps.commands.execute(MAPS_OPEN_AT_CARET)
        expect(maps.opened).toEqual([])
    })
})
