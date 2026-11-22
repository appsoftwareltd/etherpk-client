import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { isAppPagePath } from '../offline/app-shell'

import { fileOfLaunch, pathInFolder } from './launched-file'

const handle = (kind: 'file' | 'directory', name: string) => ({ kind, name }) as unknown as FileSystemHandle

describe('a launch from the device’s file manager', () => {
    it('carries its first file, and a launch from the icon or a link carries none', () => {
        const file = handle('file', 'watering.md')
        expect(fileOfLaunch({ files: [handle('directory', 'guide'), file, handle('file', 'soil.md')] })).toBe(file)
        expect(fileOfLaunch({ files: [] })).toBeNull()
        expect(fileOfLaunch({})).toBeNull()
    })

    it('finds the file inside a chosen folder, or says the folder does not hold it', async () => {
        const file = handle('file', 'watering.md') as FileSystemFileHandle
        const holding = { resolve: async () => ['guide', 'watering.md'] } as unknown as FileSystemDirectoryHandle
        const other = { resolve: async () => null } as unknown as FileSystemDirectoryHandle
        expect(await pathInFolder(holding, file)).toBe('guide/watering.md')
        expect(await pathInFolder(other, file)).toBeNull()
    })
})

describe('the manifest’s file handler', () => {
    it('sends a markdown file to a page the app serves, offline too', () => {
        const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('../../../static/site.webmanifest', import.meta.url)), 'utf8')) as {
            file_handlers: Array<{ action: string; accept: Record<string, string[]> }>
        }
        expect(manifest.file_handlers).toHaveLength(1)
        expect(isAppPagePath(manifest.file_handlers[0].action)).toBe(true)
        expect(manifest.file_handlers[0].accept).toEqual({ 'text/markdown': ['.md', '.markdown'] })
    })
})
