import { describe, expect, it } from 'vitest'

import { writeSiteToDirectory } from './site-writer'

/** A memory File System Access directory: the subset the site writer uses. */
interface MemFile {
    kind: 'file'
    bytes: Uint8Array
    writes: number
}
interface MemDir {
    kind: 'directory'
    entries: Map<string, MemFile | MemDir>
}

function dirHandle(dir: MemDir, name = ''): FileSystemDirectoryHandle {
    const handle = {
        kind: 'directory' as const,
        name,
        async getDirectoryHandle(child: string, options?: { create?: boolean }) {
            let entry = dir.entries.get(child)
            if (!entry) {
                if (!options?.create) throw new DOMException('not found', 'NotFoundError')
                entry = { kind: 'directory', entries: new Map() }
                dir.entries.set(child, entry)
            }
            if (entry.kind !== 'directory') throw new DOMException('mismatch', 'TypeMismatchError')
            return dirHandle(entry, child)
        },
        async getFileHandle(child: string, options?: { create?: boolean }) {
            let entry = dir.entries.get(child)
            if (!entry) {
                if (!options?.create) throw new DOMException('not found', 'NotFoundError')
                entry = { kind: 'file', bytes: new Uint8Array(), writes: 0 }
                dir.entries.set(child, entry)
            }
            if (entry.kind !== 'file') throw new DOMException('mismatch', 'TypeMismatchError')
            const file = entry
            return {
                kind: 'file',
                name: child,
                async getFile() {
                    return { text: async () => new TextDecoder().decode(file.bytes), arrayBuffer: async () => file.bytes.slice().buffer }
                },
                async createWritable() {
                    let pending: Uint8Array = new Uint8Array()
                    return {
                        async write(data: string | Uint8Array) {
                            pending = typeof data === 'string' ? new TextEncoder().encode(data) : data
                        },
                        async close() {
                            file.bytes = pending
                            file.writes++
                        },
                    }
                },
            }
        },
        async removeEntry(child: string) {
            if (!dir.entries.delete(child)) throw new DOMException('not found', 'NotFoundError')
        },
        async *entries() {
            for (const [child, entry] of dir.entries) yield [child, entry.kind === 'directory' ? dirHandle(entry, child) : { kind: 'file', name: child }]
        },
    }
    return handle as unknown as FileSystemDirectoryHandle
}

function fileText(dir: MemDir, path: string): string | null {
    const parts = path.split('/')
    let at: MemDir = dir
    for (const part of parts.slice(0, -1)) {
        const next = at.entries.get(part)
        if (!next || next.kind !== 'directory') return null
        at = next
    }
    const file = at.entries.get(parts[parts.length - 1])
    return file && file.kind === 'file' ? new TextDecoder().decode(file.bytes) : null
}

function writesOf(dir: MemDir, path: string): number {
    const parts = path.split('/')
    let at: MemDir = dir
    for (const part of parts.slice(0, -1)) at = at.entries.get(part) as MemDir
    return (at.entries.get(parts[parts.length - 1]) as MemFile).writes
}

const seeded = new Map([['README.md', 'seeded readme'], ['.github/workflows/pages.yaml', 'workflow']])
const agentsMd = (existing: string | null) => (existing ? existing.replace(/<!-- s -->[\s\S]*<!-- e -->/, '<!-- s -->new<!-- e -->') : '<!-- s -->new<!-- e -->')

describe('writeSiteToDirectory', () => {
    it('writes the bundle into nested folders, seeds once, and writes AGENTS.md', async () => {
        const root: MemDir = { kind: 'directory', entries: new Map() }
        const bundle = new Map<string, string | Uint8Array>([['index.html', '<p>hi</p>'], ['assets/a.png', new Uint8Array([1, 2])], ['theme/theme.css', 'body{}']])
        const result = await writeSiteToDirectory(dirHandle(root), bundle, { seeded, agentsMd })
        expect(result).toEqual({ written: 6, unchanged: 0, deleted: [] })
        expect(fileText(root, 'index.html')).toBe('<p>hi</p>')
        expect(fileText(root, 'theme/theme.css')).toBe('body{}')
        expect(fileText(root, '.github/workflows/pages.yaml')).toBe('workflow')
        expect(fileText(root, 'AGENTS.md')).toBe('<!-- s -->new<!-- e -->')
    })

    it('rewrites only what changed, leaves seeded and user files alone, and deletes strays in owned places only', async () => {
        const root: MemDir = { kind: 'directory', entries: new Map() }
        const handle = dirHandle(root)
        const first = new Map<string, string | Uint8Array>([['index.html', 'v1'], ['old.html', 'gone soon'], ['assets/a.png', new Uint8Array([1])], ['assets/old.png', new Uint8Array([9])], ['theme/theme.css', 'css']])
        await writeSiteToDirectory(handle, first, { seeded, agentsMd })
        // The user edits the seeded README and adds files of their own.
        await (await (await handle.getFileHandle('README.md', { create: true })).createWritable()).write('mine')
        ;(root.entries.get('README.md') as MemFile).bytes = new TextEncoder().encode('mine')
        root.entries.set('CNAME', { kind: 'file', bytes: new TextEncoder().encode('example.com'), writes: 0 })
        root.entries.set('notes.txt', { kind: 'file', bytes: new TextEncoder().encode('user notes'), writes: 0 })
        root.entries.set('AGENTS.md', { kind: 'file', bytes: new TextEncoder().encode('# Mine\n<!-- s -->old<!-- e -->\nkeep'), writes: 0 })

        const second = new Map<string, string | Uint8Array>([['index.html', 'v2'], ['assets/a.png', new Uint8Array([1])], ['theme/theme.css', 'css']])
        const result = await writeSiteToDirectory(handle, second, { seeded, agentsMd })
        expect(result.deleted.sort()).toEqual(['assets/old.png', 'old.html'])
        expect(result.unchanged).toBe(2)
        expect(fileText(root, 'index.html')).toBe('v2')
        expect(writesOf(root, 'theme/theme.css')).toBe(1)
        expect(fileText(root, 'README.md')).toBe('mine')
        expect(fileText(root, 'CNAME')).toBe('example.com')
        expect(fileText(root, 'notes.txt')).toBe('user notes')
        expect(fileText(root, 'AGENTS.md')).toBe('# Mine\n<!-- s -->new<!-- e -->\nkeep')
    })

    it('deletes the publish report an older build left in the folder', async () => {
        // Older builds wrote etherpk-publish.json into every site. The name stays an owned path
        // so that the first publish after the upgrade removes the copy.
        const root: MemDir = { kind: 'directory', entries: new Map() }
        root.entries.set('etherpk-publish.json', { kind: 'file', bytes: new TextEncoder().encode('{"excluded":[{"concept":"Secret Plans"}]}'), writes: 0 })
        const result = await writeSiteToDirectory(dirHandle(root), new Map([['index.html', 'x']]), { seeded: new Map(), agentsMd })
        expect(result.deleted).toEqual(['etherpk-publish.json'])
        expect(root.entries.has('etherpk-publish.json')).toBe(false)
    })

    it('never touches .git', async () => {
        const root: MemDir = { kind: 'directory', entries: new Map() }
        root.entries.set('.git', { kind: 'directory', entries: new Map([['HEAD', { kind: 'file', bytes: new TextEncoder().encode('ref'), writes: 0 }]]) })
        root.entries.set('stale.html', { kind: 'file', bytes: new Uint8Array(), writes: 0 })
        const result = await writeSiteToDirectory(dirHandle(root), new Map([['index.html', 'x']]), { seeded: new Map(), agentsMd })
        expect(result.deleted).toEqual(['stale.html'])
        expect(fileText(root, '.git/HEAD')).toBe('ref')
    })
})
