import { describe, expect, it } from 'vitest'

import { isProtectedEpub, withoutReachingOut } from './ebook-drm'

const encryption = (algorithm: string) =>
    `<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:enc="http://www.w3.org/2001/04/xmlenc#"><enc:EncryptedData><enc:EncryptionMethod Algorithm="${algorithm}"/></enc:EncryptedData></encryption>`

describe('telling a protected EPUB', () => {
    it('reads an EBook with no encryption file', () => {
        expect(isProtectedEpub({ encryption: null, hasRightsFile: false })).toBe(false)
    })

    it('reads an EBook whose only encryption is font obfuscation', () => {
        expect(isProtectedEpub({ encryption: encryption('http://www.idpf.org/2008/embedding'), hasRightsFile: false })).toBe(false)
        expect(isProtectedEpub({ encryption: encryption('http://ns.adobe.com/pdf/enc#RC'), hasRightsFile: false })).toBe(false)
    })

    it('refuses an EBook with its text encrypted', () => {
        expect(isProtectedEpub({ encryption: encryption('http://www.w3.org/2001/04/xmlenc#aes256-cbc'), hasRightsFile: false })).toBe(true)
    })

    it('refuses an EBook with a rights file', () => {
        expect(isProtectedEpub({ encryption: null, hasRightsFile: true })).toBe(true)
    })
})

describe('a section that tries to send its frame elsewhere', () => {
    it('loses its refresh and nothing else', () => {
        const head = '<head><meta charset="utf-8"/><meta http-equiv="refresh" content="0;url=https://example.com"/><META HTTP-EQUIV=Refresh CONTENT="1"></head>'
        expect(withoutReachingOut(head)).toBe('<head><meta charset="utf-8"/></head>')
    })

    it('loses a hint to connect ahead of time, and keeps its stylesheet', () => {
        const head = '<link rel="preconnect" href="https://example.com"/><link href="https://example.com" rel=dns-prefetch /><link rel="stylesheet" href="style.css"/>'
        expect(withoutReachingOut(head)).toBe('<link rel="stylesheet" href="style.css"/>')
    })
})
