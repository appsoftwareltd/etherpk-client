import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { NOTICE_AUTO_DISMISS_MS } from '$lib/notice-dismissal'

import { closeNotice, dismissNotice, getNotices, resetNotices, retractNotice, showNotice, subscribeNotices } from './notices'

beforeEach(() => {
    vi.useFakeTimers()
    resetNotices()
})
afterEach(() => vi.useRealTimers())

describe('showNotice', () => {
    it('publishes the notice and lets it go by itself after the shared delay', () => {
        const seen: string[][] = []
        const unsubscribe = subscribeNotices((list) => seen.push(list.map((n) => n.text)))
        showNotice({ id: 'status', text: 'Deleted "Alpha".', tone: 'info' })
        expect(getNotices()).toEqual([{ id: 'status', text: 'Deleted "Alpha".', tone: 'info', dismissal: 'auto' }])

        vi.advanceTimersByTime(NOTICE_AUTO_DISMISS_MS - 1)
        expect(getNotices()).toHaveLength(1)
        vi.advanceTimersByTime(1)
        expect(getNotices()).toEqual([])
        expect(seen).toEqual([[], ['Deleted "Alpha".'], []])
        unsubscribe()
    })

    it('replaces a notice with the same id in place, restarting its clock', () => {
        showNotice({ id: 'status', text: 'first', tone: 'info' })
        vi.advanceTimersByTime(NOTICE_AUTO_DISMISS_MS - 1)
        showNotice({ id: 'status', text: 'second', tone: 'info' })
        expect(getNotices().map((n) => n.text)).toEqual(['second'])
        vi.advanceTimersByTime(NOTICE_AUTO_DISMISS_MS - 1)
        expect(getNotices().map((n) => n.text)).toEqual(['second'])
        vi.advanceTimersByTime(1)
        expect(getNotices()).toEqual([])
    })

    it('keeps an error on screen until it is closed: a failure asks to be read', () => {
        showNotice({ id: 'status', text: 'Could not delete: locked', tone: 'error' })
        expect(getNotices()[0].dismissal).toBe('manual')
        vi.advanceTimersByTime(NOTICE_AUTO_DISMISS_MS * 2)
        expect(getNotices()).toHaveLength(1)
        dismissNotice('status')
        expect(getNotices()).toEqual([])
    })

    it('stacks notices with different ids', () => {
        showNotice({ id: 'a', text: 'A', tone: 'info' })
        showNotice({ id: 'b', text: 'B', tone: 'info' })
        expect(getNotices().map((n) => n.id)).toEqual(['a', 'b'])
    })
})

describe('a standing notice', () => {
    it('stays until closed when the caller says so, whatever its tone', () => {
        showNotice({ id: 'index', text: 'Another tab holds the index.', tone: 'info', dismissal: 'manual' })
        vi.advanceTimersByTime(NOTICE_AUTO_DISMISS_MS * 2)
        expect(getNotices()).toHaveLength(1)
    })

    it('hears about the user closing it, but not about its owner taking it down', () => {
        const ondismiss = vi.fn()
        showNotice({ id: 'index', text: 'x', tone: 'info', dismissal: 'manual', ondismiss })
        dismissNotice('index')
        expect(ondismiss).not.toHaveBeenCalled()

        showNotice({ id: 'index', text: 'x', tone: 'info', dismissal: 'manual', ondismiss })
        closeNotice('index')
        expect(ondismiss).toHaveBeenCalledTimes(1)
        expect(getNotices()).toEqual([])
    })

    it('is replaced in place, keeping its position among the others', () => {
        showNotice({ id: 'a', text: 'A', tone: 'info' })
        showNotice({ id: 'save', text: 'Could not save', tone: 'error', actions: [{ label: 'Retry', run: () => {} }] })
        showNotice({ id: 'b', text: 'B', tone: 'info' })
        showNotice({ id: 'save', text: 'Could not save', tone: 'error', actions: [{ label: 'Retrying…', run: () => {}, disabled: true }] })
        expect(getNotices().map((n) => n.id)).toEqual(['a', 'save', 'b'])
        expect(getNotices()[1].actions?.[0].disabled).toBe(true)
    })
})

describe('retractNotice', () => {
    it('takes a notice down only while it still says what the caller put up', () => {
        showNotice({ id: 'status', text: 'Checking…', tone: 'info' })
        showNotice({ id: 'status', text: 'Deleted "Alpha".', tone: 'info' })
        retractNotice('status', 'Checking…')
        expect(getNotices().map((n) => n.text)).toEqual(['Deleted "Alpha".'])
        retractNotice('status', 'Deleted "Alpha".')
        expect(getNotices()).toEqual([])
    })
})
