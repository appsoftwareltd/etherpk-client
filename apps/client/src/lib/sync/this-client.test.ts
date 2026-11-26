import { afterEach, describe, expect, it, vi } from 'vitest'
import { nameThisClient, thisClient } from './this-client'

describe('what this build says it is to a Sync Server', () => {
    afterEach(() => {
        vi.unstubAllGlobals()
        nameThisClient(undefined)
    })

    it('is a browser Client of its release', () => {
        vi.stubGlobal('__BUILD_INFO__', { version: '0.60.0' })
        expect(thisClient()).toEqual({ kind: 'web', version: '0.60.0' })
    })

    it('is an installed one where a shell put its port on the page', () => {
        vi.stubGlobal('__BUILD_INFO__', { version: '0.60.0' })
        vi.stubGlobal('etherpkNative', {})
        expect(thisClient()).toEqual({ kind: 'installed', version: '0.60.0' })
    })

    it('is nothing in a build with no release of its own', () => {
        expect(thisClient()).toBeNull()
    })

    it('is what a program that is not the Client says it is', () => {
        nameThisClient({ kind: 'headless', version: '0.60.0' })
        expect(thisClient()).toEqual({ kind: 'headless', version: '0.60.0' })
    })
})
