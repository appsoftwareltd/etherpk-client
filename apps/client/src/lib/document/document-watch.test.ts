import { describe, expect, it } from 'vitest'

import { createDocumentWatch } from './document-watch'
import type { DocumentStore } from './types'

/** A store that records each watch and its release. */
function recordingStore() {
    const log: string[] = []
    const store = {
        open: () => {
            throw new Error('not read')
        },
        watchDocuments: (names: readonly string[]) => {
            log.push(`watch ${names.join(',')}`)
            return () => log.push(`release ${names.join(',')}`)
        },
    } as unknown as DocumentStore
    return { store, log }
}

describe('watching the documents a view shows', () => {
    it('watches each name once, sorted, and the new set before the old one is let go', () => {
        const { store, log } = recordingStore()
        const watch = createDocumentWatch(() => store)
        watch.watch(['Kitchen', 'Garden', 'garden'])
        watch.watch(['Garden', 'Kitchen'])
        watch.watch(['Garden'])
        watch.dispose()
        expect(log).toEqual(['watch Garden,Kitchen', 'watch Garden', 'release Garden,Kitchen', 'release Garden'])
    })

    it('stops at the limit, and asks nothing of a store that cannot watch', () => {
        const { store, log } = recordingStore()
        createDocumentWatch(() => store, 2).watch(['C', 'B', 'A'])
        expect(log).toEqual(['watch A,B'])
        expect(() => createDocumentWatch(() => ({ open: () => ({}) }) as unknown as DocumentStore).watch(['A'])).not.toThrow()
    })
})
