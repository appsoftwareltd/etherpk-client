import { describe, expect, it } from 'vitest'

import { DEFAULT_DIRECTORY_URL, DEFAULT_REGISTRY_URL, directorySettings } from './config'

describe("the Client server's Extension Directory settings", () => {
    it("uses EtherPK's directory and npm's registry when nothing is set", () => {
        expect(directorySettings({})).toMatchObject({ directoryUrl: DEFAULT_DIRECTORY_URL, registryUrl: DEFAULT_REGISTRY_URL })
    })

    it('takes package addresses only from a list the operator chose', () => {
        expect(directorySettings({}).allowTarball).toBe(false)
        expect(directorySettings({ EXTENSION_DIRECTORY_URL: 'https://directory.example/directory.json' }).allowTarball).toBe(true)
    })

    it('keeps releases in a folder of this user’s own in the temporary folder when none is set, and in the one set otherwise', () => {
        const unset = directorySettings({})
        expect(unset.privateCache).toBe(true)
        expect(unset.cacheDir).toMatch(/etherpk-extensions-[\w-]+$/)
        expect(directorySettings({ EXTENSION_CACHE_DIR: '/var/cache/garden' }).privateCache).toBe(false)
    })

    it('turns the directory off with an empty address', () => {
        expect(directorySettings({ EXTENSION_DIRECTORY_URL: '' }).directoryUrl).toBeNull()
        expect(directorySettings({ EXTENSION_DIRECTORY_URL: '  ' }).directoryUrl).toBeNull()
    })

    it('takes another directory, registry and cache folder', () => {
        expect(directorySettings({ EXTENSION_DIRECTORY_URL: ' https://directory.example/directory.json ', EXTENSION_REGISTRY_URL: 'https://registry.example', EXTENSION_CACHE_DIR: '/var/cache/garden' })).toEqual({
            directoryUrl: 'https://directory.example/directory.json',
            registryUrl: 'https://registry.example',
            cacheDir: '/var/cache/garden',
            privateCache: false,
            allowTarball: true,
        })
    })
})
