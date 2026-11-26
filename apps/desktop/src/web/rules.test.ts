import { describe, expect, it } from 'vitest'
import { isAllowed, isAppUrl, openedWindow } from './rules.ts'

describe('addresses', () => {
    it('the app’s own are exactly its origin', () => {
        for (const url of ['app://etherpk/', 'app://etherpk/graphs?a#b']) expect(isAppUrl(url)).toBe(true)
        for (const url of ['app://etherpk.evil/', 'app://evil/etherpk', 'app://a@etherpk/', 'https://etherpk/', 'about:blank', 'app:etherpk', 'x']) expect([url, isAppUrl(url)]).toEqual([url, false])
    })
    it('open a window, the system’s program, or nothing', () => {
        expect(openedWindow('app://etherpk/graphs')).toEqual({ kind: 'app', url: 'app://etherpk/graphs' })
        expect(openedWindow('https://example.com/a')).toEqual({ kind: 'external', url: 'https://example.com/a' })
        expect(openedWindow('mailto:a@example.com')).toEqual({ kind: 'external', url: 'mailto:a@example.com' })
        for (const url of ['about:blank', 'javascript:alert(1)', 'file:///etc/hosts', 'data:text/html,x', 'blob:app://etherpk/1', 'app://elsewhere/', 'app://etherpk/__etherpk-preview/1/', 'smb://host/', 'ms-settings:', '']) expect([url, openedWindow(url)]).toEqual([url, { kind: 'refused' }])
    })
})

describe('permissions', () => {
    it('are the app page’s few', () => {
        const ask = (permission: string, origin = 'app://etherpk/', isMainFrame = true) => isAllowed({ permission, origin, isMainFrame })
        for (const permission of ['clipboard-read', 'clipboard-sanitized-write', 'fullscreen', 'persistent-storage']) expect(ask(permission)).toBe(true)
        for (const permission of ['media', 'geolocation', 'notifications', 'midi', 'hid', 'usb', 'serial', 'openExternal', 'pointerLock', 'display-capture', 'storage-access', 'unknown']) expect([permission, ask(permission)]).toEqual([permission, false])
        expect(ask('clipboard-read', 'app://etherpk', false)).toBe(false)
        expect(ask('clipboard-read', 'https://www.youtube-nocookie.com', false)).toBe(false)
        expect(ask('fullscreen', 'https://www.youtube-nocookie.com/', false)).toBe(true)
        expect(ask('fullscreen', 'https://elsewhere.example', false)).toBe(false)
        expect(ask('clipboard-read', 'null')).toBe(false)
    })
})
