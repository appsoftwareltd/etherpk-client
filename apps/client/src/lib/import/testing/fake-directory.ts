/**
 * An in-memory folder shaped like a `FileSystemDirectoryHandle`, as far as
 * {@link walkDirectory} reads one. For tests: node has no File System Access API.
 */
import type { WalkableDirectory, WalkableEntry } from '../directory-handle-source'

/** A folder named `name` holding `files`, keyed by their path inside it (`pages/Beans.md`). */
export function fakeDirectory(
    name: string,
    files: Record<string, string>,
    options: { onOpen?: (path: string) => void } = {},
): WalkableDirectory {
    return directoryAt('', name, files, options.onOpen)
}

function directoryAt(
    prefix: string,
    name: string,
    files: Record<string, string>,
    onOpen?: (path: string) => void,
): WalkableDirectory {
    return {
        kind: 'directory',
        name,
        async *values(): AsyncIterable<WalkableEntry> {
            if (prefix) onOpen?.(prefix.slice(0, -1))
            const children = new Set<string>()
            for (const path of Object.keys(files)) {
                if (!path.startsWith(prefix)) continue
                const rest = path.slice(prefix.length)
                const slash = rest.indexOf('/')
                const child = slash === -1 ? rest : rest.slice(0, slash)
                if (children.has(child)) continue
                children.add(child)
                if (slash === -1) {
                    const text = files[path]
                    yield { kind: 'file', name: child, getFile: async () => new Blob([text]) }
                } else {
                    yield directoryAt(`${prefix}${child}/`, child, files, onOpen)
                }
            }
        },
    }
}
