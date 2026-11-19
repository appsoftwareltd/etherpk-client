import { describe, expect, it } from 'vitest'
import { FOLDER_UNAVAILABLE_REASON } from '../workspace/graph-choice-panels'
import { FOLDER_NEEDS, importDestinations } from './import-destinations'

const SIGN_IN = 'Sign in with an EtherPK account that has Sync+ to import into a synced graph.'

describe('importDestinations', () => {
    it('with both available, starts on the folder and says nothing up front', () => {
        expect(importDestinations({ folderAvailable: true, syncedAvailable: true, syncedBlockedReason: SIGN_IN })).toEqual({
            initial: 'folder',
            notice: null,
            none: null,
        })
    })

    it('with only a folder, selects it and says why a synced graph is not offered', () => {
        expect(importDestinations({ folderAvailable: true, syncedAvailable: false, syncedBlockedReason: SIGN_IN })).toEqual({
            initial: 'folder',
            notice: `The new graph will be stored in a local folder you choose. ${SIGN_IN}`,
            none: null,
        })
    })

    it('with only a synced graph, selects it and says why a folder is not offered', () => {
        expect(importDestinations({ folderAvailable: false, syncedAvailable: true, syncedBlockedReason: SIGN_IN })).toEqual({
            initial: 'synced',
            notice: `The new graph will be a synced graph. A local folder ${FOLDER_NEEDS}`,
            none: null,
        })
        // The same words as the Graphs page's Folder panel, so the two never disagree.
        expect(FOLDER_NEEDS).toBe('needs the File System Access API: Chrome or Edge on desktop, or Chrome on Android.')
        expect(`N${FOLDER_NEEDS.slice(1)}`).toBe(FOLDER_UNAVAILABLE_REASON)
    })

    it('with neither, selects nothing and gives the reason for each', () => {
        expect(importDestinations({ folderAvailable: false, syncedAvailable: false, syncedBlockedReason: SIGN_IN })).toEqual({
            initial: null,
            notice: null,
            none: { synced: SIGN_IN, folder: `A local folder ${FOLDER_NEEDS}` },
        })
    })
})
