/** The Client's server's one release store, set up from its environment (`config.ts`). */
import { env } from '$env/dynamic/private'

import { directorySettings } from './config'
import { createReleaseStore, type ReleaseStore } from './release-store'

let store: ReleaseStore | null = null

export function releaseStore(): ReleaseStore {
    store ??= createReleaseStore(directorySettings(env))
    return store
}
