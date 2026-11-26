import { connectNativeBridge, type NativeBridge } from '@appsoftwareltd/etherpk-native-bridge'
import { createMemoryNative, type MemoryNative, type MemoryNativeOptions } from '@appsoftwareltd/etherpk-native-bridge/memory'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const shell = vi.hoisted(() => ({ bridge: null as unknown }))
vi.mock('./bridge.js', () => {
    const bridge = () => shell.bridge as NativeBridge | null
    return {
        nativeBridge: bridge,
        nativePlatform: () => bridge()?.info.platform ?? null,
        hasNativeFeature: (feature: 'print') => bridge()?.info.features[feature] ?? false,
    }
})

import { pageReadsClipboard, shellClipboardText } from './clipboard'
import { shellPrint } from './print'
import { updateAsks, updateWords } from './update-words'

let native: MemoryNative
function installedOn(platform: MemoryNativeOptions['platform'], features: MemoryNativeOptions['features'] = {}) {
    native = createMemoryNative({ platform, features })
    shell.bridge = connectNativeBridge(native.port)
}
beforeEach(() => {
    shell.bridge = null
})

describe('the clipboard', () => {
    it('is read by the page in a browser and on a desktop', async () => {
        expect(pageReadsClipboard()).toBe(true)
        expect(await shellClipboardText()).toBeNull()
        installedOn('linux')
        native.clipboard = 'beans'
        expect(pageReadsClipboard()).toBe(true)
        expect(await shellClipboardText()).toBeNull()
    })

    it('is read by the shell on Android', async () => {
        installedOn('android')
        native.clipboard = 'beans'
        expect(pageReadsClipboard()).toBe(false)
        expect(await shellClipboardText()).toBe('beans')
    })
})

describe('printing', () => {
    it('is the page’s own where the shell does not print', () => {
        expect(shellPrint(1000)).toBeNull()
        installedOn('linux')
        expect(shellPrint(1000)).toBeNull()
    })

    it('goes through a shell that prints, and ends when it answers', async () => {
        installedOn('android', { print: true })
        expect(await shellPrint(1000)).toBe('printed')
        expect(native.asked.printed).toBe(1)
    })

    it('ends at the limit when the shell never answers, and fails when it refuses', async () => {
        installedOn('android', { print: true })
        const stop = native.hook({ before: () => new Promise(() => {}) })
        expect(await shellPrint(10)).toBe('unknown')
        stop()
        native.fail('shell.print', 'NotSupportedError')
        await expect(shellPrint(1000)).rejects.toMatchObject({ name: 'NotSupportedError' })
    })
})

describe('what is said of an update', () => {
    it('is nothing where the shell does not update itself', () => {
        expect(updateWords({ state: 'off' })).toBeNull()
    })

    it('gives a button only when there is something to press', () => {
        expect(updateWords({ state: 'idle' })).toEqual({ text: 'No update is waiting.', action: { label: 'Check for updates', does: 'check' } })
        expect(updateWords({ state: 'checking' })!.action).toBeNull()
        expect(updateWords({ state: 'downloading', version: '1.2.0', received: 1024 * 1024, total: 2 * 1024 * 1024 })).toMatchObject({ text: expect.stringContaining('1.2.0'), action: null })
        expect(updateWords({ state: 'ready', version: '1.2.0' })!.action).toEqual({ label: 'Restart and update', does: 'install' })
    })

    it('offers the download page where the app cannot install the update itself', () => {
        expect(updateWords({ state: 'available', version: '1.2.0', install: true, required: false, page: 'https://example.com' })!.action!.does).toBe('install')
        const download = updateWords({ state: 'available', version: '1.2.0', install: false, required: false, page: 'https://example.com' })!
        expect(download.action!.does).toBe('download')
        expect(download.text).toContain('install the new version over this one')
    })

    it('says an update is important when it is, and never shows the reason a log gets', () => {
        expect(updateWords({ state: 'available', version: '1.2.0', install: true, required: true, page: '' })!.text).toContain('important')
        expect(updateWords({ state: 'failed', message: 'ENOTFOUND 127.0.0.1' })!.text).not.toContain('ENOTFOUND')
    })

    it('is worth a notice only when the person can do something', () => {
        expect(updateAsks({ state: 'ready', version: '1.2.0' })).toBe(true)
        for (const state of ['off', 'idle', 'checking'] as const) expect(updateAsks({ state })).toBe(false)
        expect(updateAsks({ state: 'failed', message: 'x' })).toBe(false)
    })
})
