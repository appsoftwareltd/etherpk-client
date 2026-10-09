import { describe, expect, it } from 'vitest'

import { readExtensionPackage } from './manifest'

/** A valid package.json, the Graph View's shape, for each case to break one thing in. */
function graphView(etherpk: Record<string, unknown> = {}, rest: Record<string, unknown> = {}) {
    return {
        name: '@appsoftwareltd/etherpk-extension-graph-view',
        version: '0.8.54',
        license: 'Elastic-2.0',
        ...rest,
        etherpk: {
            id: 'graph-view',
            displayName: 'Graph View',
            publisher: 'App Software',
            minClientVersion: '0.8.54',
            main: './dist/main.js',
            styles: ['./dist/main.css'],
            icons: { 'graph-view': '<circle cx="8" cy="8" r="2"/>' },
            views: [
                { kind: 'graph-view.local', title: 'Graph View', icon: 'graph-view', region: 'right-sidebar', resident: { side: 'right', desktopOnly: true } },
                { kind: 'graph-view.whole', title: 'Whole graph', region: 'main', address: { segment: 'graph-view' } },
            ],
            ...etherpk,
        },
    }
}

function errorsOf(json: unknown): string[] {
    const result = readExtensionPackage(json)
    return result.ok ? [] : result.errors
}

describe('readExtensionPackage', () => {
    it('reads a valid package, its standard fields and its manifest', () => {
        const result = readExtensionPackage(graphView())
        expect(result.ok).toBe(true)
        if (!result.ok) return
        expect(result.extension.name).toBe('@appsoftwareltd/etherpk-extension-graph-view')
        expect(result.extension.version).toBe('0.8.54')
        expect(result.extension.license).toBe('Elastic-2.0')
        expect(result.extension.manifest.id).toBe('graph-view')
        expect(result.extension.manifest.views?.map((view) => view.kind)).toEqual(['graph-view.local', 'graph-view.whole'])
    })

    it('refuses a package with no etherpk field, saying it is not an extension', () => {
        expect(errorsOf({ name: 'left-pad', version: '1.0.0' })).toEqual(['package.json has no "etherpk" field, so it is not an EtherPK extension.'])
    })

    it('refuses a missing name and a version that is not x.y.z', () => {
        expect(errorsOf(graphView({}, { name: '', version: 'latest' }))).toEqual(['package.json has no "name".', 'package.json\'s "version" is not x.y.z.'])
    })

    it.each(['Graph-View', '1graph', 'graph_view', 'graph.view', ''])('refuses the id %j', (id) => {
        expect(errorsOf(graphView({ id, views: [] }))).toContain('"etherpk.id" must be lowercase letters, digits and hyphens, starting with a letter.')
    })

    it.each(['displayName', 'publisher', 'main'])('refuses an empty %s', (key) => {
        expect(errorsOf(graphView({ [key]: ' ' }))).toContain(`"etherpk.${key}" must be a non-empty string.`)
    })

    it.each(['/dist/main.js', '../outside/main.js', 'dist/../../main.js', 'dist\\main.js'])('refuses a main that leaves the package: %j', (main) => {
        expect(errorsOf(graphView({ main }))).toContain('"etherpk.main" must be a path inside the package.')
    })

    it('refuses stylesheets outside the package', () => {
        expect(errorsOf(graphView({ styles: ['../theirs.css'] }))).toContain('"etherpk.styles" must be a list of paths inside the package.')
    })

    it('refuses a minClientVersion that is not x.y.z, and allows none', () => {
        expect(errorsOf(graphView({ minClientVersion: '^0.8' }))).toContain('"etherpk.minClientVersion" must be x.y.z.')
        expect(errorsOf(graphView({ minClientVersion: undefined }))).toEqual([])
    })

    it('refuses icon names that are not lowercase and icons with no markup', () => {
        expect(errorsOf(graphView({ icons: { Fit: '<path d="M1 1"/>', empty: '' } }))).toEqual(['Icon "Fit" must be lowercase letters, digits and hyphens.', 'Icon "empty" has no markup.'])
    })

    it("refuses a View kind outside the extension's own id", () => {
        expect(errorsOf(graphView({ views: [{ kind: 'kanban.board', title: 'Board', region: 'main' }] }))).toEqual([
            '"etherpk.views[0]".kind must be "graph-view.<name>", the name in lowercase letters, digits and hyphens.',
        ])
    })

    it('refuses a View kind declared twice', () => {
        const view = { kind: 'graph-view.whole', title: 'Whole graph', region: 'main' }
        expect(errorsOf(graphView({ views: [view, view] }))).toEqual(['"etherpk.views[1]".kind "graph-view.whole" is declared twice.'])
    })

    it('refuses an empty fixed target', () => {
        expect(errorsOf(graphView({ views: [{ kind: 'graph-view.whole', target: '', title: 'Whole graph', region: 'main' }] }))).toEqual([
            '"etherpk.views[0]".target must be a non-empty string.',
        ])
    })

    it('refuses a region the Layout does not have', () => {
        expect(errorsOf(graphView({ views: [{ kind: 'graph-view.whole', title: 'Whole graph', region: 'bottom' }] }))).toEqual([
            '"etherpk.views[0]".region must be one of main, left-sidebar, right-sidebar.',
        ])
    })

    it('refuses a resident with no side', () => {
        expect(errorsOf(graphView({ views: [{ kind: 'graph-view.local', title: 'Graph View', region: 'right-sidebar', resident: { side: 'top' } }] }))).toEqual([
            '"etherpk.views[0]".resident must be { side: "left" | "right", desktopOnly?: boolean }.',
        ])
    })

    it('refuses an address segment declared twice, and a target other than a concept', () => {
        expect(
            errorsOf(
                graphView({
                    views: [
                        { kind: 'graph-view.a', title: 'A', region: 'main', address: { segment: 'graph' } },
                        { kind: 'graph-view.b', title: 'B', region: 'main', address: { segment: 'graph', target: 'path' } },
                    ],
                }),
            ),
        ).toEqual(['"etherpk.views[1]".address.segment "graph" is declared twice.', '"etherpk.views[1]".address.target may only be "concept".'])
    })

    it('reports every problem at once rather than the first', () => {
        expect(errorsOf(graphView({ displayName: '', publisher: '', main: '' })).length).toBe(3)
    })

    it('reads the settings an extension asks the person for', () => {
        const settings = [
            { id: 'mapbox-token', type: 'secret', title: 'Mapbox key', description: 'For satellite imagery.', placeholder: 'pk.…', link: { title: 'How to get one', url: 'https://docs.etherpk.com/maps' } },
            { id: 'nickname', type: 'text', title: 'Nickname' },
        ]
        const result = readExtensionPackage(graphView({ settings }))
        expect(result.ok && result.extension.manifest.settings).toEqual(settings)
    })

    it('refuses a setting with a bad id, a type it does not know, no title, or a link that is not https', () => {
        expect(
            errorsOf(
                graphView({
                    settings: [
                        { id: 'Key', type: 'secret', title: 'Key' },
                        { id: 'key', type: 'number', title: '' },
                        { id: 'key', type: 'text', title: 'Again', link: { title: 'Guide', url: 'http://example.org' } },
                    ],
                }),
            ),
        ).toEqual([
            '"etherpk.settings[0]".id must be lowercase letters, digits and hyphens, starting with a letter.',
            '"etherpk.settings[1]".type must be one of text, secret.',
            '"etherpk.settings[1]".title must be a non-empty string.',
            '"etherpk.settings[2]".id "key" is declared twice.',
            '"etherpk.settings[2]".link must be { title, url }, the url an https address.',
        ])
        expect(errorsOf(graphView({ settings: {} }))).toEqual(['"etherpk.settings" must be a list.'])
    })
})
