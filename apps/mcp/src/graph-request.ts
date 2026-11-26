import { resolve } from 'node:path'

/** The flags of `serve` and `publish` that choose a graph. */
export interface GraphFlags {
    graph?: string
    folder?: string
    'sync-server'?: string
}

/** A graph `serve` or `publish` is asked for, before anything is read: a folder, or a synced graph by id or name. */
export type GraphRequest = { kind: 'folder'; path: string } | { kind: 'synced'; wanted: string; server: string | undefined }

/**
 * The graph the flags ask for, or an error in words the person can act on. An empty or blank flag
 * counts as one not given: the Claude Code plugin passes every flag on every start, empty for each
 * option the person left unset.
 */
export function graphRequest(command: 'serve' | 'publish', flags: GraphFlags): GraphRequest {
    const folder = flags.folder?.trim() || undefined
    const wanted = flags.graph?.trim() || undefined
    const server = flags['sync-server']?.trim() || undefined
    if (folder && (wanted || server)) throw new Error(`${command} takes either --folder <path> or --graph <id or name> (with an optional --sync-server), not both.`)
    if (folder) return { kind: 'folder', path: resolve(folder) }
    if (!wanted) throw new Error(`${command} needs --graph <id or name>, or --folder <path> for a graph folder.`)
    return { kind: 'synced', wanted, server }
}
