import { describe, expect, it } from 'vitest'

import { walkDirectory } from './directory-handle-source'
import { fakeDirectory } from './testing/fake-directory'

describe('walkDirectory', () => {
    it('lists every file under the folder by its path from the folder', async () => {
        const root = fakeDirectory('Garden', {
            'pages/Beans.md': '- water the beans',
            'journals/2026_01_02.md': '- planted',
            'assets/seed.png': 'png',
            'etherpk/settings.json': '{}',
            'README.md': 'notes',
        })
        const files = await walkDirectory(root)
        expect(files.map((file) => file.path)).toEqual([
            'README.md',
            'assets/seed.png',
            'etherpk/settings.json',
            'journals/2026_01_02.md',
            'pages/Beans.md',
        ])
        expect(await files[4].data.text()).toBe('- water the beans')
    })

    it('leaves out what the junk filter leaves out, without reading inside a junk folder', async () => {
        const opened: string[] = []
        const root = fakeDirectory(
            'Garden',
            {
                'pages/Beans.md': '- beans',
                '.git/HEAD': 'ref',
                'node_modules/pkg/index.js': 'x',
                'pages/.DS_Store': 'x',
                'logseq/config.edn': '{}',
            },
            { onOpen: (path) => opened.push(path) },
        )
        const files = await walkDirectory(root)
        expect(files.map((file) => file.path)).toEqual(['pages/Beans.md'])
        expect(opened).not.toContain('.git')
        expect(opened).not.toContain('node_modules')
        expect(opened).not.toContain('logseq')
    })

    it('stops when its signal is aborted', async () => {
        const controller = new AbortController()
        controller.abort()
        await expect(walkDirectory(fakeDirectory('Garden', { 'pages/Beans.md': '-' }), controller.signal)).rejects.toThrow()
    })
})
