import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { NATIVE_METHODS } from '@appsoftwareltd/etherpk-native-bridge'
import { NativeFailure } from '../failure.ts'
import { checkedArguments, isNativeMethod } from './arguments.ts'
import { openableUrl } from './external.ts'

describe('the arguments of a call', () => {
    it('are known for every method of the Bridge, and for no other name', () => {
        for (const method of NATIVE_METHODS) expect(isNativeMethod(method)).toBe(true)
        for (const name of ['constructor', '__proto__', 'hasOwnProperty', 'fs.exec', '', null, 7, ['fs.read']]) expect(isNativeMethod(name)).toBe(false)
    })
    it('carry only the fields the method has', () => {
        expect(checkedArguments('fs.read', { folder: 'a', path: 'b', root: '/etc' })).toEqual({ folder: 'a', path: 'b' })
        expect(checkedArguments('fs.write', { folder: 'a', path: 'b', bytes: new Uint8Array(1), ifStamp: 'absent' })).toMatchObject({ ifStamp: 'absent' })
    })
    it('a field of the prototype is not a field', () => {
        expect(() => checkedArguments('fs.read', Object.create({ folder: 'a', path: 'b' }))).toThrow(NativeFailure)
    })
    it('property: any value is checked or refused, and what is checked has the right types', () => {
        fc.assert(fc.property(fc.constantFrom(...NATIVE_METHODS), fc.anything(), (method, args) => {
            let checked: Record<string, unknown>
            try {
                checked = checkedArguments(method, args) as Record<string, unknown>
            } catch (error) {
                expect(error).toBeInstanceOf(NativeFailure)
                return
            }
            for (const name of ['folder', 'path', 'file', 'save', 'url', 'watch']) if (name in checked) expect(typeof checked[name]).toBe('string')
        }), { seed: 20261125, numRuns: 1000 })
    })
})

describe('addresses for another program', () => {
    it('property: only the web, mail and the telephone', () => {
        const url = fc.oneof(fc.webUrl(), fc.string(), fc.tuple(fc.constantFrom('file', 'FILE', ' javascript', 'java\nscript', 'data', 'vbscript', 'ms-settings', 'https', 'mailto', 'tel', 'smb', 'app'), fc.constantFrom(':', '://', ':///'), fc.string()).map((parts) => parts.join('')))
        fc.assert(fc.property(url, (text) => {
            const openable = openableUrl(text)
            if (openable !== null) expect(openable).toMatch(/^(https?:\/\/|mailto:|tel:)/)
        }), { seed: 20261125, numRuns: 1000 })
    })
    it('property: a mail address carries no query, so no attachment', () => {
        fc.assert(fc.property(fc.emailAddress(), fc.string(), (address, rest) => {
            const openable = openableUrl(`mailto:${address}?attach=/etc/passwd&${rest}#${rest}`)
            if (openable !== null) expect(openable).not.toMatch(/[?#]/)
        }), { seed: 20261126, numRuns: 500 })
        expect(openableUrl('mailto:someone@example.com?attachment=C:\\notes.md')).toBe('mailto:someone@example.com')
    })
})
