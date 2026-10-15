import type { Attachment } from 'svelte/attachments'

/** Escape anywhere inside the element runs `handler`, as it closes a menu or cancels a form. */
export function onEscape(handler: () => void): Attachment<HTMLElement> {
    return (element) => {
        const listener = (event: KeyboardEvent) => {
            if (event.key !== 'Escape' || event.defaultPrevented) return
            event.preventDefault()
            handler()
        }
        element.addEventListener('keydown', listener)
        return () => element.removeEventListener('keydown', listener)
    }
}
