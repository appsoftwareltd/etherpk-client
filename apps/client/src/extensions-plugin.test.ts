import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { readLoadedExtensions } from '../extensions-plugin'

let scratch: string

afterEach(() => rmSync(scratch, { recursive: true, force: true }))

/** A Client folder whose package.json names `builtIn`, with each named package installed as pnpm links it. */
function setUp(builtIn: string[], packages: Record<string, Record<string, unknown>>) {
    scratch = mkdtempSync(join(tmpdir(), 'etherpk-extensions-'))
    const client = join(scratch, 'client')
    mkdirSync(join(client, 'node_modules', '@appsoftwareltd'), { recursive: true })
    writeFileSync(join(client, 'package.json'), JSON.stringify({ name: 'client', etherpk: { builtInExtensions: builtIn } }))
    for (const [folder, packageJson] of Object.entries(packages)) {
        const directory = join(scratch, folder)
        mkdirSync(join(directory, 'dist'), { recursive: true })
        writeFileSync(join(directory, 'package.json'), JSON.stringify(packageJson))
        writeFileSync(join(directory, 'dist', 'main.js'), 'export function activate() {}')
        const name = packageJson.name as string
        symlinkSync(directory, join(client, 'node_modules', ...name.split('/')))
    }
    return client
}

const graphView = (version: string) => ({
    name: '@appsoftwareltd/etherpk-extension-graph-view',
    version,
    etherpk: { id: 'graph-view', main: './dist/main.js', styles: ['./dist/main.css'] },
})

describe('reading the loaded extensions', () => {
    it("reads each package the Client's package.json names, from where it really is, served under its id and version", () => {
        const client = setUp(['@appsoftwareltd/etherpk-extension-graph-view'], { 'graph-view': graphView('1.2.3') })
        const [extension] = readLoadedExtensions(client)
        expect(extension.base).toBe('/extensions/graph-view/1.2.3/')
        expect(extension.directory).toBe(join(scratch, 'graph-view'))
        expect(extension.folders).toEqual(['dist'])
        expect((extension.packageJson.etherpk as { id: string }).id).toBe('graph-view')
    })

    it('lets a development folder replace the built-in with the same id', () => {
        const client = setUp(['@appsoftwareltd/etherpk-extension-graph-view'], { 'graph-view': graphView('1.2.3') })
        const local = join(scratch, 'my-graph-view')
        mkdirSync(join(local, 'dist'), { recursive: true })
        writeFileSync(join(local, 'package.json'), JSON.stringify(graphView('1.3.0')))
        const extensions = readLoadedExtensions(client, ['../my-graph-view'])
        expect(extensions.map((extension) => [extension.base, extension.directory])).toEqual([['/extensions/graph-view/1.3.0/', local]])
    })

    it('says plainly when a named package is not installed', () => {
        const client = setUp(['@appsoftwareltd/etherpk-extension-missing'], {})
        expect(() => readLoadedExtensions(client)).toThrow(
            "The Client's package.json names @appsoftwareltd/etherpk-extension-missing under etherpk.builtInExtensions, but it is not installed. Run pnpm install.",
        )
    })

    it('names none when the Client lists none', () => {
        expect(readLoadedExtensions(setUp([], {}))).toEqual([])
    })
})
