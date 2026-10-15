import { describe, expect, it } from 'vitest'

import { headlessClientLoginCommand, headlessClientPackage } from './headless-client-command'

describe('the Headless Client login command', () => {
    it('names the server, without a trailing slash, and carries the Agent Setup Code', () => {
        expect(headlessClientLoginCommand('https://sync.example.test/', headlessClientPackage(null), 'epk_setup_abc'))
            .toBe('npx @appsoftwareltd/etherpk-mcp login --sync-server https://sync.example.test --code epk_setup_abc')
    })

    it('names the pinned release', () => {
        expect(headlessClientLoginCommand('https://sync.example.test', headlessClientPackage('0.9.1'), 'epk_setup_abc'))
            .toBe('npx @appsoftwareltd/etherpk-mcp@0.9.1 login --sync-server https://sync.example.test --code epk_setup_abc')
    })
})
