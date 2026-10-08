import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { proofOf, readJsonLine, writeJsonLine } from './host-protocol'

import {
    claimHost,
    ensureRuntimeDir,
    hostEndpoint,
    hostLive,
    hostRecordPath,
    listHostRecords,
    readHostRecord,
    releaseHost,
    runtimeDir,
    type HostRecord,
} from './host-endpoint'

const dirs: string[] = []
afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function scratch(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'etherpk-host-endpoint-'))
    dirs.push(dir)
    return dir
}

function record(pid: number, overrides: Partial<HostRecord> = {}): HostRecord {
    return {
        pid,
        version: '0.10.0',
        endpoint: `/run/test/${pid}.sock`,
        target: { kind: 'folder', path: '/home/me/Notes' },
        startedAt: new Date().toISOString(),
        secret: 'cd'.repeat(32),
        ...overrides,
    }
}

/** A server at `endpoint` that answers a status request, with the proof of `secret` or without one. */
async function answering(endpoint: string, secret: string | null): Promise<Server> {
    const server = createServer(async (socket) => {
        socket.on('error', () => {})
        const request = (await readJsonLine(socket).catch(() => null)) as { nonce?: string } | null
        const status = { pid: process.pid, version: '0.10.0', target: { kind: 'folder', path: '/home/me/Notes' }, startedAt: '', graph: { state: 'open', name: 'Notes' }, sessions: 0, stopping: false } as const
        writeJsonLine(socket, { etherpk: 'status', status, ...(secret && request?.nonce ? { proof: proofOf(secret, request.nonce) } : {}) })
        socket.end()
    })
    await new Promise<void>((resolve) => server.listen(endpoint, resolve))
    return server
}

describe('where a host listens', () => {
    it('is a short socket in the user\'s runtime directory, named for the graph\'s cache directory', () => {
        const endpoint = hostEndpoint('/home/me/.cache/etherpk/mcp/local/Notes-abc', { XDG_RUNTIME_DIR: '/run/user/1000' }, 'linux')
        expect(endpoint).toMatch(/^\/run\/user\/1000\/etherpk-mcp\/[0-9a-f]{16}\.sock$/)
        // A socket path must fit in about 100 bytes on macOS.
        expect(endpoint.length).toBeLessThan(100)
        expect(hostEndpoint('/home/me/.cache/etherpk/mcp/local/Other-def', { XDG_RUNTIME_DIR: '/run/user/1000' }, 'linux')).not.toBe(endpoint)
    })

    it('falls back to a directory of the user\'s own under the system temporary directory', () => {
        expect(runtimeDir({}, 1000)).toBe(join(tmpdir(), 'etherpk-mcp-1000'))
        // A relative XDG_RUNTIME_DIR is not one the spec allows.
        expect(runtimeDir({ XDG_RUNTIME_DIR: 'relative' }, 1000)).toBe(join(tmpdir(), 'etherpk-mcp-1000'))
    })

    // Pipe names are one namespace for the whole computer: a name nobody can guess cannot be taken first.
    it('is a named pipe with a new random name on Windows', () => {
        const cacheDir = 'C:\\Users\\me\\.cache\\etherpk\\mcp\\local\\Notes'
        const endpoint = hostEndpoint(cacheDir, {}, 'win32')
        expect(endpoint).toMatch(/^\\\\\.\\pipe\\etherpk-mcp-[0-9a-f]{32}$/)
        expect(hostEndpoint(cacheDir, {}, 'win32')).not.toBe(endpoint)
    })
})

describe.runIf(process.platform !== 'win32')('the runtime directory', () => {
    it('is made owner-only, and tightened when it is not', async () => {
        const dir = join(await scratch(), 'etherpk-mcp')
        await mkdir(dir, { mode: 0o755 })
        await ensureRuntimeDir(dir)
        expect((await stat(dir)).mode & 0o777).toBe(0o700)
    })

    it('refuses a symbolic link, which someone else could point anywhere', async () => {
        const root = await scratch()
        await mkdir(join(root, 'real'))
        await symlink(join(root, 'real'), join(root, 'etherpk-mcp'))
        await expect(ensureRuntimeDir(join(root, 'etherpk-mcp'))).rejects.toThrow(/not a directory of its own/)
    })

    it('refuses a directory another user owns', async () => {
        const dir = join(await scratch(), 'etherpk-mcp')
        await mkdir(dir, { mode: 0o700 })
        await expect(ensureRuntimeDir(dir, (process.getuid?.() ?? 0) + 1)).rejects.toThrow(/belongs to another user/)
    })
})

describe('the claim on a cache directory', () => {
    it('goes to the first host, and the next is told who holds it', async () => {
        const cacheDir = join(await scratch(), 'graph')
        const alive = () => true

        expect(await claimHost(cacheDir, record(101), alive)).toEqual({ claimed: true })
        const second = await claimHost(cacheDir, record(102), alive)
        expect(second).toEqual({ claimed: false, owner: expect.objectContaining({ pid: 101 }) })
        expect((await stat(hostRecordPath(cacheDir))).mode & 0o777).toBe(0o600)
    })

    it('replaces the record of a host that died without removing it', async () => {
        const cacheDir = join(await scratch(), 'graph')
        await claimHost(cacheDir, record(101), () => true)

        const claim = await claimHost(cacheDir, record(102), (owner) => owner.pid !== 101)

        expect(claim).toEqual({ claimed: true })
        expect(await readHostRecord(cacheDir)).toMatchObject({ pid: 102 })
    })

    it('goes to exactly one of several hosts that find the same dead record at once', async () => {
        const cacheDir = join(await scratch(), 'graph')
        await claimHost(cacheDir, record(100), () => true)
        const alive = (owner: HostRecord) => owner.pid !== 100

        const claims = await Promise.all([201, 202, 203, 204].map((pid) => claimHost(cacheDir, record(pid), alive)))

        expect(claims.filter((claim) => claim.claimed)).toHaveLength(1)
        const owner = await readHostRecord(cacheDir)
        for (const claim of claims) if (!claim.claimed) expect(claim.owner.pid).toBe(owner?.pid)
    })

    it('is released only by the host that holds it', async () => {
        const cacheDir = join(await scratch(), 'graph')
        await claimHost(cacheDir, record(101), () => true)

        await releaseHost(cacheDir, 999)
        expect(await readHostRecord(cacheDir)).toMatchObject({ pid: 101 })
        await releaseHost(cacheDir, 101)
        expect(await readHostRecord(cacheDir)).toBeNull()
    })

    it('reads an unreadable record as none, so a new host can replace it', async () => {
        const cacheDir = join(await scratch(), 'graph')
        await mkdir(cacheDir, { recursive: true })
        await writeFile(hostRecordPath(cacheDir), 'not json')
        expect(await readHostRecord(cacheDir)).toBeNull()
        expect(await claimHost(cacheDir, record(102), () => true)).toEqual({ claimed: true })
        expect(JSON.parse(await readFile(hostRecordPath(cacheDir), 'utf8'))).toMatchObject({ pid: 102 })
    })
})

describe('whether a recorded host is still serving', () => {
    const longAgo = new Date(Date.now() - 60 * 60_000).toISOString()

    it('is no when its process has gone', async () => {
        expect(await hostLive(record(2 ** 22 + 17, { startedAt: longAgo }))).toBe(false)
    })

    // After a restart, the recorded process id can belong to another program.
    it.runIf(process.platform !== 'win32')('is no when its process runs but nothing answers where it listens', async () => {
        const endpoint = join(await scratch(), 'gone.sock')
        expect(await hostLive(record(process.pid, { endpoint, startedAt: longAgo }))).toBe(false)
    })

    it('is yes for a host that started moments ago and may not be listening yet', async () => {
        expect(await hostLive(record(process.pid, { endpoint: join(await scratch(), 'soon.sock') }))).toBe(true)
    })

    it.runIf(process.platform !== 'win32')('is yes when its process runs and it answers with the proof of its secret', async () => {
        const endpoint = join(await scratch(), 'live.sock')
        const server = await answering(endpoint, 'cd'.repeat(32))
        try {
            expect(await hostLive(record(process.pid, { endpoint, startedAt: longAgo }))).toBe(true)
        } finally {
            await new Promise((resolve) => server.close(resolve))
        }
    })

    it.runIf(process.platform !== 'win32')('is no when something answers there without the proof', async () => {
        const endpoint = join(await scratch(), 'other.sock')
        const server = await answering(endpoint, null)
        try {
            expect(await hostLive(record(process.pid, { endpoint, startedAt: longAgo }))).toBe(false)
        } finally {
            await new Promise((resolve) => server.close(resolve))
        }
    })
})

describe('the hosts on this computer', () => {
    it('are found by their records under the cache root, synced graphs and folders alike', async () => {
        const root = await scratch()
        await claimHost(join(root, 'sync.example.com', 'graph-1'), record(101, { target: { kind: 'synced', server: 'https://sync.example.com', graphId: 'graph-1' } }), () => true)
        await claimHost(join(root, 'local', 'Notes-abc'), record(102), () => true)
        await mkdir(join(root, 'sync.example.com', 'graph-2'), { recursive: true })

        const found = await listHostRecords({ ETHERPK_MCP_CACHE_DIR: root })

        expect(found.map((entry) => entry.record.pid).sort()).toEqual([101, 102])
        expect(found.find((entry) => entry.record.pid === 101)?.cacheDir).toBe(join(root, 'sync.example.com', 'graph-1'))
    })
})
