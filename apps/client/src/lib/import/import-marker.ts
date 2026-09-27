/**
 * A mark in this browser that an [[Import]] is under way, so the Knowledge graphs page can say
 * which one a closed or reloaded tab cut off, and offer to remove what it left: a synced graph
 * partly uploaded, or a folder partly written.
 *
 * The marks live in localStorage, which survives the tab. Whether one is still running is asked
 * of the open tabs over a BroadcastChannel rather than read from a timer heartbeat: a hidden
 * tab's timers are throttled to once a minute, so a heartbeat cannot tell a running background
 * import from one whose tab has just been reloaded, and a channel message still reaches it.
 */

export interface ImportMarker {
    id: string
    name: string
    destination: 'server' | 'filesystem'
    /** The synced graph the import created, once it has. */
    graphId?: string
    /** The folder a folder import writes into. */
    folderName?: string
    startedAt: number
}

export interface StartedImport {
    /** Record the synced graph the import has just created. */
    setGraphId(graphId: string): void
    /** The import settled (done, failed or cancelled): nothing is left to clear up. */
    clear(): void
}

interface MarkerStorage {
    getItem(key: string): string | null
    setItem(key: string, value: string): void
    removeItem(key: string): void
}

type ChannelMessage = { type: 'ask'; id: string } | { type: 'running'; id: string }

const STORAGE_KEY = 'etherpk:imports-in-progress'

export function createImportMarkers(deps: {
    storage: MarkerStorage
    channelName?: string
    /** How long a running import's tab has to answer. Generous: a busy import tab is slow. */
    answerWithinMs?: number
}) {
    const channelName = deps.channelName ?? 'etherpk-imports'
    const answerWithinMs = deps.answerWithinMs ?? 800
    // Imports running in this page, which it answers for.
    const runningHere = new Set<string>()
    const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(channelName)
    const heardRunning = new Set<string>()
    if (channel) {
        channel.onmessage = (event: MessageEvent<ChannelMessage>) => {
            const message = event.data
            if (message.type === 'ask' && runningHere.has(message.id)) channel.postMessage({ type: 'running', id: message.id })
            if (message.type === 'running') heardRunning.add(message.id)
        }
    }

    function read(): ImportMarker[] {
        try {
            const parsed = JSON.parse(deps.storage.getItem(STORAGE_KEY) ?? '[]') as unknown
            return Array.isArray(parsed) ? (parsed as ImportMarker[]) : []
        } catch {
            return []
        }
    }

    function write(markers: ImportMarker[]): void {
        try {
            if (markers.length === 0) deps.storage.removeItem(STORAGE_KEY)
            else deps.storage.setItem(STORAGE_KEY, JSON.stringify(markers))
        } catch {
            // Storage refused (private mode, quota): the import goes on unmarked.
        }
    }

    function update(id: string, change: (marker: ImportMarker) => ImportMarker | null): void {
        write(read().flatMap((marker) => {
            if (marker.id !== id) return [marker]
            const next = change(marker)
            return next ? [next] : []
        }))
    }

    return {
        start(marker: Omit<ImportMarker, 'id' | 'startedAt'>): StartedImport {
            const id = crypto.randomUUID()
            runningHere.add(id)
            write([...read(), { ...marker, id, startedAt: Date.now() }])
            return {
                setGraphId: (graphId) => update(id, (current) => ({ ...current, graphId })),
                clear: () => {
                    runningHere.delete(id)
                    update(id, () => null)
                },
            }
        },

        /** The marked imports no open tab is running: each was cut off partway. */
        async findInterrupted(): Promise<ImportMarker[]> {
            const candidates = read().filter((marker) => !runningHere.has(marker.id))
            if (candidates.length === 0) return []
            if (channel) {
                for (const marker of candidates) {
                    heardRunning.delete(marker.id)
                    channel.postMessage({ type: 'ask', id: marker.id } satisfies ChannelMessage)
                }
                await new Promise((resolve) => setTimeout(resolve, answerWithinMs))
            }
            return candidates.filter((marker) => !heardRunning.has(marker.id))
        },

        /** The person has dealt with an interrupted import: stop mentioning it. */
        forget(id: string): void {
            update(id, () => null)
        },

        close(): void {
            channel?.close()
        },
    }
}

let browserMarkers: ReturnType<typeof createImportMarkers> | null = null

/** This page's import markers, over localStorage. */
export function importMarkers(): ReturnType<typeof createImportMarkers> {
    browserMarkers ??= createImportMarkers({ storage: localStorage })
    return browserMarkers
}
