import { describe, expect, it } from 'vitest'
import {
    appCachesToDelete,
    appCacheName,
    extensionFileStatus,
    isAppPagePath,
    isImmutableAppFile,
    isWorkerScript,
    referencedAppFiles,
    SHELL_PATH,
    shellMatchesBuild,
} from './app-shell'

describe('isAppPagePath', () => {
    it('names the pages a person opens to work, which a cold start offline must reach', () => {
        for (const path of ['/', '/graphs', '/share', '/g/0d4c', '/g/0d4c/d/Garden', '/g/0d4c/d/Garden/Beans', '/g/0d4c/a/7f3e', '/g/0d4c/t/dark']) {
            expect(isAppPagePath(path), path).toBe(true)
        }
    })

    it('leaves out the public pages, the shell itself, sign-in, the server routes and the dev harnesses', () => {
        for (const path of ['/home', '/privacy', '/terms', '/marketing', SHELL_PATH, '/auth/login', '/api/csp-report', '/extensions/maps/1.0.0/main.js', '/dev/editor', '/demo', '/graphsx', '/g']) {
            expect(isAppPagePath(path), path).toBe(false)
        }
    })
})

describe('isImmutableAppFile and isWorkerScript', () => {
    it('treats every hashed build file as one that never changes, the ones workers load included', () => {
        expect(isImmutableAppFile('/_app/immutable/chunks/DnDT9Xmr.js')).toBe(true)
        expect(isImmutableAppFile('/_app/immutable/workers/assets/sqlite3-BVKGSWc-.wasm')).toBe(true)
        expect(isImmutableAppFile('/_app/version.json')).toBe(false)
        expect(isImmutableAppFile('/favicon.ico')).toBe(false)
    })

    it("knows a worker's script, whose text names the files the worker loads", () => {
        expect(isWorkerScript('/_app/immutable/workers/index-worker-CAjej_f3.js')).toBe(true)
        expect(isWorkerScript('/_app/immutable/workers/assets/sqlite3-opfs-async-proxy-D_xnb1D8.js')).toBe(false)
        expect(isWorkerScript('/_app/immutable/chunks/DnDT9Xmr.js')).toBe(false)
        const script = 'e?c(`sqlite3.wasm`):new URL(`/_app/immutable/workers/assets/sqlite3-BVKGSWc-.wasm`,``+self.location.href)'
        expect(referencedAppFiles(script)).toEqual(['/_app/immutable/workers/assets/sqlite3-BVKGSWc-.wasm'])
    })
})

describe('appCachesToDelete', () => {
    it("keeps this version's cache and the one made just before it, so a tab still running that version keeps its files", () => {
        const keys = ['etherpk-app-1', 'etherpk-extension-files', 'etherpk-app-2', 'etherpk-app-3', 'other-cache']
        expect(appCachesToDelete(keys, appCacheName('4'))).toEqual(['etherpk-app-1', 'etherpk-app-2'])
        expect(appCachesToDelete([...keys, 'etherpk-app-4'], appCacheName('4'))).toEqual(['etherpk-app-1', 'etherpk-app-2'])
    })

    it('deletes nothing when there is no older version', () => {
        expect(appCachesToDelete(['etherpk-app-4'], appCacheName('4'))).toEqual([])
        expect(appCachesToDelete([], appCacheName('4'))).toEqual([])
    })
})

describe('referencedAppFiles and shellMatchesBuild', () => {
    const page = `<!doctype html><html><head>
        <link href="/_app/immutable/assets/0.Ab1.css" rel="stylesheet">
        <link rel="modulepreload" href="/_app/immutable/entry/start.Cd2.js">
        </head><body><script nonce="n">import("/_app/immutable/entry/app.Ef3.js")</script></body></html>`

    it('finds every app file a page loads', () => {
        expect(referencedAppFiles(page).sort()).toEqual(['/_app/immutable/assets/0.Ab1.css', '/_app/immutable/entry/app.Ef3.js', '/_app/immutable/entry/start.Cd2.js'])
    })

    it('accepts a shell only when this version holds every file it loads', () => {
        const build = new Set(['/_app/immutable/assets/0.Ab1.css', '/_app/immutable/entry/start.Cd2.js', '/_app/immutable/entry/app.Ef3.js'])
        expect(shellMatchesBuild(page, build)).toBe(true)
        // A page from a newer deployment names files this version never cached.
        build.delete('/_app/immutable/entry/app.Ef3.js')
        expect(shellMatchesBuild(page, build)).toBe(false)
        // A page that loads no app files at all is not a shell.
        expect(shellMatchesBuild('<html><body>Bad gateway</body></html>', build)).toBe(false)
    })
})

describe('extensionFileStatus', () => {
    it('keeps a file the server sent, forgets one it withdrew, and leaves the rest alone', () => {
        expect(extensionFileStatus(200)).toBe('keep')
        expect(extensionFileStatus(410)).toBe('forget')
        expect(extensionFileStatus(404)).toBe('forget')
        expect(extensionFileStatus(304)).toBe('leave')
        expect(extensionFileStatus(500)).toBe('leave')
    })
})
