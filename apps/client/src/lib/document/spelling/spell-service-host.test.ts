import { describe, expect, it } from 'vitest'

import { DEFAULT_DICTIONARY_URL, dictionaryBaseUrl } from './spell-service-host'

describe('dictionaryBaseUrl', () => {
    it("is EtherPK's host when the deployment says nothing", () => {
        expect(dictionaryBaseUrl(undefined, false)).toBe(DEFAULT_DICTIONARY_URL)
    })

    it("is the Client's own origin in development, where the local set is served", () => {
        expect(dictionaryBaseUrl(undefined, true)).toBe('/dev-dictionaries/v1')
    })

    it('is what the deployment sets, and nothing when it sets it empty', () => {
        expect(dictionaryBaseUrl(' https://mirror.example.com/v1 ', false)).toBe('https://mirror.example.com/v1')
        expect(dictionaryBaseUrl('', false)).toBe('')
    })
})
