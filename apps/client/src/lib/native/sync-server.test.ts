import { describe, expect, it, vi } from 'vitest'
import type { ShellInfo } from '@appsoftwareltd/etherpk-native-bridge'
import { shellSyncServerOf } from './sync-server'

const info = (syncServer?: unknown): ShellInfo => ({
    bridgeVersion: 1,
    platform: 'linux',
    appVersion: '0.0.0',
    features: { watch: true, showInFileManager: true, print: false, signIn: false, updates: false },
    ...(syncServer === undefined ? {} : { syncServer: syncServer as string }),
})

describe('the Sync Server the shell hands the page', () => {
    it('is none in a browser, and where the shell names none', () => {
        expect(shellSyncServerOf(null)).toBe(null)
        expect(shellSyncServerOf(info())).toBe(null)
        expect(shellSyncServerOf(info(null))).toBe(null)
    })

    it('is the origin the shell names', () => {
        expect(shellSyncServerOf(info('https://own.example.test'))).toBe('https://own.example.test')
    })

    it('is refused, and logged, when it is not an origin the page may reach', () => {
        const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
        for (const value of ['https://own.example.test/sync', 'http://own.example.test', 42]) expect(shellSyncServerOf(info(value))).toBe(null)
        expect(logged).toHaveBeenCalledTimes(3)
        logged.mockRestore()
    })
})
