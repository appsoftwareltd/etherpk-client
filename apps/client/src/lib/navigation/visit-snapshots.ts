/**
 * Per-**Visit** position snapshots, keyed by visit id. sessionStorage: per-tab
 * (matching the browser history the Visits live in) and survives reload. One
 * table for all graphs — visit ids are unique per tab. Capped; corrupt
 * payloads degrade to empty. History entries carry only the visit id; the
 * position lives here, written at the moment a Visit is left.
 */

import { z } from 'zod'

import type { ViewPosition } from './position'

export const VISIT_SNAPSHOTS_KEY = 'etherpk-visit-snapshots'
const MAX_ENTRIES = 100

const positionSchema = z.object({ scrollTop: z.number(), anchor: z.number(), head: z.number() })
/** Ordered [visitId, position] pairs — order is the recency cap's eviction order. */
const payloadSchema = z.array(z.tuple([z.number(), positionSchema]))

export interface VisitSnapshots {
    save(visitId: number, position: ViewPosition | null): void
    load(visitId: number): ViewPosition | null
}

export function createVisitSnapshots(
    storage: Storage | undefined = globalThis.sessionStorage,
): VisitSnapshots {
    if (!storage) throw new Error('createVisitSnapshots: no Storage available')

    function read(): [number, ViewPosition][] {
        const raw = storage!.getItem(VISIT_SNAPSHOTS_KEY)
        if (raw === null) return []
        try {
            const parsed = payloadSchema.safeParse(JSON.parse(raw))
            return parsed.success ? parsed.data : []
        } catch {
            return []
        }
    }

    return {
        save(visitId, position) {
            if (!position) return
            const entries = read().filter(([id]) => id !== visitId)
            entries.push([visitId, position])
            storage!.setItem(VISIT_SNAPSHOTS_KEY, JSON.stringify(entries.slice(-MAX_ENTRIES)))
        },
        load(visitId) {
            return read().find(([id]) => id === visitId)?.[1] ?? null
        },
    }
}
