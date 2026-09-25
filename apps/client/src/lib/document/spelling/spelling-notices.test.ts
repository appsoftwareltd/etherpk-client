import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getNotices, resetNotices } from '$lib/activity/notices'

import type { LanguageStatus, SpellService, SpellState } from './spell-service'
import { bindSpellingNotices } from './spelling-notices'

/** Just enough of a spell service to drive the notices. */
function fakeService() {
    let languages: LanguageStatus[] = []
    let state: SpellState = 'loading'
    const listeners = new Set<() => void>()
    const retry = vi.fn()
    const service = {
        get state() {
            return state
        },
        error: null,
        languages: () => languages,
        retry,
        subscribe(listener: () => void) {
            listeners.add(listener)
            return () => void listeners.delete(listener)
        },
    } as unknown as SpellService
    return {
        service,
        retry,
        set(next: LanguageStatus[], nextState: SpellState) {
            languages = next
            state = nextState
            for (const listener of listeners) listener()
        },
    }
}

const german = (state: LanguageStatus['state'], error?: string): LanguageStatus => ({
    tag: 'de',
    name: 'German',
    state,
    bytes: 330 * 1024,
    ...(error ? { error } : {}),
})

beforeEach(() => {
    vi.useFakeTimers()
    resetNotices()
})
afterEach(() => {
    vi.useRealTimers()
    resetNotices()
})

describe('spelling notices', () => {
    it('says nothing about a download that finishes quickly', () => {
        const fake = fakeService()
        const stop = bindSpellingNotices(fake.service)
        fake.set([german('downloading')], 'loading')
        vi.advanceTimersByTime(1000)
        fake.set([german('ready')], 'ready')
        vi.advanceTimersByTime(5000)
        expect(getNotices()).toEqual([])
        stop()
    })

    it('says what is downloading once it takes a while, and takes it down when done', () => {
        const fake = fakeService()
        const stop = bindSpellingNotices(fake.service)
        fake.set([german('downloading')], 'loading')
        vi.advanceTimersByTime(2500)
        expect(getNotices().map((n) => n.text)).toEqual(['Downloading the German dictionary (330.0 KB)…'])
        fake.set([german('ready')], 'ready')
        expect(getNotices()).toEqual([])
        stop()
    })

    it('keeps a failure on screen with a Retry that asks the service again', async () => {
        const fake = fakeService()
        const stop = bindSpellingNotices(fake.service)
        fake.set([german('failed', 'The dictionary host answered 404.')], 'error')
        const [notice] = getNotices()
        expect(notice).toMatchObject({ tone: 'error', dismissal: 'manual' })
        expect(notice.text).toContain('German')
        expect(notice.text).toContain('404')
        await notice.actions?.[0].run()
        expect(fake.retry).toHaveBeenCalledTimes(1)
        stop()
    })

    it('stays quiet while offline: the Spelling tab says so, and nothing has failed', () => {
        const fake = fakeService()
        const stop = bindSpellingNotices(fake.service)
        fake.set([german('offline', 'no network')], 'error')
        expect(getNotices()).toEqual([])
        stop()
    })
})
