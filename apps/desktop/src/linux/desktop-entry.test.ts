import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import fc from 'fast-check'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { desktopEntry, desktopEntryPaths, entryState, execArgument, removeEntry, writeEntry } from './desktop-entry.ts'

let data: string
beforeEach(async () => { data = await mkdtemp(join(tmpdir(), 'etherpk-entry-')) })
afterEach(() => rm(data, { recursive: true, force: true }))
const icon = Buffer.from('png')

describe('the menu entry of an AppImage', () => {
    it('is written, followed when the file moves, and removed', async () => {
        expect(await entryState({ data }, '/a/EtherPK.AppImage')).toBe('none')
        await writeEntry({ data }, '/a/EtherPK.AppImage', icon)
        expect(await entryState({ data }, '/a/EtherPK.AppImage')).toBe('current')
        expect(await entryState({ data }, '/b/EtherPK.AppImage')).toBe('old')
        await removeEntry({ data }, '/b/EtherPK.AppImage')
        expect(await entryState({ data }, '/b/EtherPK.AppImage')).toBe('none')
        await expect(readFile(desktopEntryPaths({ data }).icon)).rejects.toThrow()
    })
    it('leaves one a person wrote alone', async () => {
        const { entry } = desktopEntryPaths({ data })
        await mkdir(dirname(entry), { recursive: true })
        await writeFile(entry, '[Desktop Entry]\nName=Mine\n')
        expect(await entryState({ data }, '/a')).toBe('theirs')
        await removeEntry({ data }, '/a')
        expect(await readFile(entry, 'utf8')).toContain('Mine')
    })
    it('opens Markdown and etherpk links. Folders are left out, since a desktop can take any program that names them for its file manager', () => {
        const text = desktopEntry('/home/someone/Apps/EtherPK.AppImage')
        expect(text).toContain('MimeType=text/markdown;x-scheme-handler/etherpk;')
        expect(text).toContain('Exec="/home/someone/Apps/EtherPK.AppImage" %U')
    })
    it('property: a path with any character comes back from the two layers as one argument', () => {
        const unescapeValue = (text: string) => text.replace(/\\(.)/g, (_all, character: string) => ({ s: ' ', n: '\n', t: '\t', r: '\r' })[character] ?? character)
        const parse = (text: string) => {
            const value = unescapeValue(text)
            const inner = /^"((?:[^"\\`$]|\\["`$\\])*)"$/.exec(value)
            expect(inner, text).not.toBe(null)
            return inner![1].replace(/\\(.)/g, '$1').replaceAll('%%', '%')
        }
        fc.assert(fc.property(fc.stringMatching(/^[ -~é]{1,30}$/), (path) => { expect(parse(execArgument(path))).toBe(path) }), { seed: 20261125, numRuns: 500 })
    })
    it('refuses a path with a line break, which could add a key', () => expect(() => desktopEntry('/a\nExec=b')).toThrow())
})
