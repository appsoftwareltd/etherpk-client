import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The unit tests run without Svelte's compiler, so the rune is the plain value it holds.
vi.hoisted(() => {
    const state = <T>(value: T) => value
    Object.assign(globalThis, { $state: Object.assign(state, { raw: state }) })
})

import { connectNativeBridge } from '@appsoftwareltd/etherpk-native-bridge'
import { createMemoryNative, type MemoryNative } from '@appsoftwareltd/etherpk-native-bridge/memory'

import { getNotices, resetNotices } from '../activity/notices'
import { closePrompt } from './close-guard.svelte.js'
import { guardLeaving } from './leave-guard.js'

let native: MemoryNative
let stop: () => void
let unguard: () => void = () => {}
beforeEach(() => {
    native = createMemoryNative()
    stop = closePrompt.listen(connectNativeBridge(native.port))
    resetNotices()
})
afterEach(() => {
    stop()
    unguard()
    closePrompt.keepOpen()
    vi.restoreAllMocks()
})

const answers = () => native.asked.closeAnswers
const askToClose = () => native.emit('beforeClose', {})

describe('closing the window of a Native App', () => {
    it('answers once for a second press of the close button while the saves settle', async () => {
        let release: (value: null) => void = () => {}
        unguard = guardLeaving(() => new Promise((resolve) => { release = resolve }))
        askToClose()
        askToClose()
        await vi.waitFor(() => expect(release).not.toBe(undefined))
        release(null)
        await vi.waitFor(() => expect(answers()).toEqual([true]))
        await new Promise((resolve) => setTimeout(resolve, 10))
        expect(answers()).toEqual([true])
    })

    it('asks before losing an edit, and closes when the person says to close anyway', async () => {
        unguard = guardLeaving(() => 'Garden has edits that could not be saved.')
        askToClose()
        await vi.waitFor(() => expect(answers()).toEqual([false]))
        expect(closePrompt.losses).toEqual(['Garden has edits that could not be saved.'])
        await closePrompt.closeAnyway()
        expect(answers()).toEqual([false, true])
        expect(closePrompt.losses).toEqual([])
    })

    it('answers the next press after the shell could not be answered', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {})
        native.fail('shell.closeAnswer', 'OperationError')
        askToClose()
        await vi.waitFor(() => expect(console.error).toHaveBeenCalled())
        askToClose()
        await vi.waitFor(() => expect(answers()).toEqual([true]))
    })

    it('says so when it could not close after the person chose to, and keeps asking', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {})
        unguard = guardLeaving(() => 'Garden has edits that could not be saved.')
        askToClose()
        await vi.waitFor(() => expect(closePrompt.losses).toHaveLength(1))
        native.fail('shell.closeAnswer', 'OperationError')
        await closePrompt.closeAnyway()
        expect(closePrompt.losses).toEqual(['Garden has edits that could not be saved.'])
        expect(getNotices().map((one) => one.text)).toEqual(['EtherPK could not close the window. Close it again.'])
        expect(console.error).toHaveBeenCalled()
    })
})
