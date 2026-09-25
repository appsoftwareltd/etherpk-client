import { describe, expect, it } from 'vitest'

import { fileLinkPath, isFileUrl } from './file-link'

describe('fileLinkPath', () => {
    it('decodes a POSIX path', () => {
        expect(fileLinkPath('file:///home/g/My%20Doc.pdf')).toBe('/home/g/My Doc.pdf')
        expect(fileLinkPath('file:///home/g/notes')).toBe('/home/g/notes')
    })

    it('turns a drive path into its Windows form, in both spellings', () => {
        expect(fileLinkPath('file:///C:/Users/g/Report%20Q3.docx')).toBe('C:\\Users\\g\\Report Q3.docx')
        expect(fileLinkPath('file://C:/Users/g/x.txt')).toBe('C:\\Users\\g\\x.txt')
        expect(fileLinkPath('file:///D:/')).toBe('D:\\')
    })

    it('turns a host into a UNC path', () => {
        expect(fileLinkPath('file://server/share/dir/x.txt')).toBe('\\\\server\\share\\dir\\x.txt')
    })

    it('treats localhost as no host', () => {
        expect(fileLinkPath('file://localhost/home/g/x')).toBe('/home/g/x')
    })

    it('leaves a bad percent escape as written rather than throwing', () => {
        expect(fileLinkPath('file:///home/g/100%25%zz')).toBe('/home/g/100%25%zz')
    })

    it('refuses a url with no path', () => {
        expect(fileLinkPath('file://')).toBeNull()
        expect(fileLinkPath('file:///')).toBeNull()
        expect(fileLinkPath('file://server')).toBeNull()
        expect(fileLinkPath('file://server/')).toBeNull()
        expect(fileLinkPath('https://example.com')).toBeNull()
    })

    it('isFileUrl is the scheme test alone, case-insensitive', () => {
        expect(isFileUrl('file:///x')).toBe(true)
        expect(isFileUrl('FILE:///x')).toBe(true)
        expect(isFileUrl('https://x')).toBe(false)
        expect(isFileUrl('profile://x')).toBe(false)
    })
})
