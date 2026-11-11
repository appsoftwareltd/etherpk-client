import { describe, expect, it } from 'vitest'
import { isPickerCancel } from './picker-cancel'

describe('telling a closed system picker from a picker that failed', () => {
    it('reads the AbortError a browser rejects with on close as a cancel', () => {
        // What Chromium rejects with when the person closes the folder picker.
        const closed = new DOMException(
            "Failed to execute 'showDirectoryPicker' on 'Window': The user aborted a request.",
            'AbortError',
        )
        expect(isPickerCancel(closed)).toBe(true)
    })

    it('goes by the name, so an AbortError from another realm still counts', () => {
        const foreign = Object.assign(new Error('The user aborted a request.'), { name: 'AbortError' })
        expect(isPickerCancel(foreign)).toBe(true)
    })

    it('leaves every other rejection a failure to report', () => {
        expect(isPickerCancel(new DOMException('Must be handling a user gesture', 'SecurityError'))).toBe(false)
        expect(isPickerCancel(new DOMException('The request is not allowed', 'NotAllowedError'))).toBe(false)
        expect(isPickerCancel(new Error('disk on fire'))).toBe(false)
    })

    it('does not mistake a thrown non-error for a cancel', () => {
        expect(isPickerCancel(undefined)).toBe(false)
        expect(isPickerCancel(null)).toBe(false)
        expect(isPickerCancel('AbortError')).toBe(false)
    })
})
