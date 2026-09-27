/**
 * The header's menus close the way a menu is expected to: Escape closes one and puts focus back
 * on its trigger, and a press outside it, focus moving out of it, or following one of its links
 * closes it too. Opening one closes any other, so the account menu and the Graphs menu are never
 * open together.
 *
 * The account menus are `<details>` elements, which the browser opens and closes on its own but
 * never dismisses; `dismissibleMenu` is attached to each (`{@attach dismissibleMenu}`). A menu
 * built another way (the header's Graphs menu) takes part through `announceMenuOpened` and
 * `onOtherMenuOpened`.
 */

/** Dispatched on `window` when a header menu opens; the detail is the menu that opened. */
const MENU_OPENED_EVENT = 'etherpk:menu-opened'

/** Tell the other header menus that `menu` has opened, so they close. */
export function announceMenuOpened(menu: object): void {
    window.dispatchEvent(new CustomEvent(MENU_OPENED_EVENT, { detail: menu }))
}

/** Run `close` whenever a header menu other than `menu` opens. Returns the unsubscribe. */
export function onOtherMenuOpened(menu: object, close: () => void): () => void {
    const listener = (event: Event) => {
        if ((event as CustomEvent<unknown>).detail !== menu) close()
    }
    window.addEventListener(MENU_OPENED_EVENT, listener)
    return () => window.removeEventListener(MENU_OPENED_EVENT, listener)
}

/** Attach to a `<details>` menu: it closes on Escape, an outside press, focus leaving and a followed link. */
export function dismissibleMenu(details: HTMLDetailsElement): () => void {
    const summary = details.querySelector('summary')

    function close(returnFocus: boolean): void {
        if (!details.open) return
        details.open = false
        if (returnFocus) summary?.focus()
    }

    const onToggle = () => {
        if (details.open) announceMenuOpened(details)
    }
    const onKeydown = (event: KeyboardEvent) => {
        if (event.key !== 'Escape' || !details.open) return
        // The menu takes the key: a dialog or panel behind it must not close as well.
        event.preventDefault()
        event.stopPropagation()
        close(true)
    }
    const onPointerdown = (event: PointerEvent) => {
        if (event.target instanceof Node && !details.contains(event.target)) close(false)
    }
    const onFocusout = (event: FocusEvent) => {
        // Focus leaving for somewhere else on the page; a null target is the window losing focus,
        // which leaves the menu as it was.
        if (event.relatedTarget instanceof Node && !details.contains(event.relatedTarget)) close(false)
    }
    const onClick = (event: MouseEvent) => {
        // A followed link navigates, often within the app, where the header and this menu stay.
        if (event.target instanceof Element && event.target.closest('a[href]')) close(false)
    }

    details.addEventListener('toggle', onToggle)
    details.addEventListener('keydown', onKeydown)
    details.addEventListener('focusout', onFocusout)
    details.addEventListener('click', onClick)
    document.addEventListener('pointerdown', onPointerdown)
    const stopListening = onOtherMenuOpened(details, () => close(false))

    return () => {
        details.removeEventListener('toggle', onToggle)
        details.removeEventListener('keydown', onKeydown)
        details.removeEventListener('focusout', onFocusout)
        details.removeEventListener('click', onClick)
        document.removeEventListener('pointerdown', onPointerdown)
        stopListening()
    }
}
