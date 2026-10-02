import { describe, expect, it, vi } from 'vitest'

import { createViewVisibility, watchPageVisibility, watchViewSize } from './view-visibility'

describe('ViewVisibility', () => {
    it('is on screen only while its tab is in front, it has a size, and the page is visible', () => {
        const visibility = createViewVisibility()
        expect(visibility.onScreen).toBe(true)

        visibility.set('tab', false)
        expect(visibility.onScreen).toBe(false)
        visibility.set('tab', true)
        visibility.set('size', false)
        expect(visibility.onScreen).toBe(false)
        visibility.set('size', true)
        visibility.set('page', false)
        expect(visibility.onScreen).toBe(false)
        visibility.set('page', true)
        expect(visibility.onScreen).toBe(true)
    })

    it('can start off screen', () => {
        expect(createViewVisibility({ tab: false }).onScreen).toBe(false)
    })

    it('tells a listener when it goes on or off screen, and only then', () => {
        const visibility = createViewVisibility()
        const heard: boolean[] = []
        const stop = visibility.subscribe((onScreen) => heard.push(onScreen))

        visibility.set('tab', false)
        visibility.set('size', false) // still off screen: nothing to say
        visibility.set('tab', true) // still off screen: no size
        visibility.set('size', true)
        visibility.set('page', true) // unchanged
        expect(heard).toEqual([false, true])

        stop()
        visibility.set('tab', false)
        expect(heard).toEqual([false, true])
    })
})

describe('watchPageVisibility', () => {
    it('follows the browser tab being hidden and shown, until stopped', () => {
        const page = Object.assign(new EventTarget(), { visibilityState: 'hidden' as DocumentVisibilityState })
        const visibility = createViewVisibility()
        const stop = watchPageVisibility(visibility, page)
        expect(visibility.onScreen).toBe(false)

        page.visibilityState = 'visible'
        page.dispatchEvent(new Event('visibilitychange'))
        expect(visibility.onScreen).toBe(true)

        stop()
        page.visibilityState = 'hidden'
        page.dispatchEvent(new Event('visibilitychange'))
        expect(visibility.onScreen).toBe(true)
    })
})

describe('watchViewSize', () => {
    /** A ResizeObserver stand-in the test drives by hand. */
    function fakeObserver() {
        let callback: ResizeObserverCallback | undefined
        const disconnect = vi.fn()
        class FakeResizeObserver {
            constructor(cb: ResizeObserverCallback) {
                callback = cb
            }
            observe() {}
            disconnect = disconnect
        }
        const resize = (width: number, height: number) =>
            callback?.([{ contentRect: { width, height } } as ResizeObserverEntry], {} as ResizeObserver)
        return { Observer: FakeResizeObserver as unknown as typeof ResizeObserver, resize, disconnect }
    }

    it('counts a box of zero width or height as off screen, as a collapsed Sidebar is', () => {
        const fake = fakeObserver()
        const visibility = createViewVisibility()
        const stop = watchViewSize(visibility, {} as Element, fake.Observer)

        fake.resize(0, 600)
        expect(visibility.onScreen).toBe(false)
        fake.resize(280, 600)
        expect(visibility.onScreen).toBe(true)
        fake.resize(280, 0)
        expect(visibility.onScreen).toBe(false)

        stop()
        expect(fake.disconnect).toHaveBeenCalled()
    })

    it('counts the size as holding where ResizeObserver does not exist', () => {
        const visibility = createViewVisibility({ size: false })
        const stop = watchViewSize(visibility, {} as Element, undefined)
        expect(visibility.onScreen).toBe(true)
        stop()
    })

    it('can start off screen and let the first report settle it, as the desktop does', () => {
        const fake = fakeObserver()
        const visibility = createViewVisibility({ size: false })
        watchViewSize(visibility, {} as Element, fake.Observer)
        expect(visibility.onScreen).toBe(false)
        fake.resize(340, 480)
        expect(visibility.onScreen).toBe(true)
    })
})
