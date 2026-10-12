/**
 * `context.dialogs`: the dialogs the Client draws for an extension (`PromptDialog.svelte`).
 *
 * Each dialog names the extension that asks, so a question is never mistaken for the Client's own.
 *
 * One question at a time: a second prompt asked while one is open waits until the first is answered,
 * so two extensions can never stack dialogs over each other, and the keyboard always has one place to
 * be.
 */
import type { PromptOptions } from '@appsoftwareltd/etherpk-extension-api'
import { mount, unmount } from 'svelte'

import PromptDialog from './PromptDialog.svelte'

/** `context.dialogs` for every extension: the scoped context passes the asking extension's name. */
export interface ClientDialogs {
    prompt(options: PromptOptions, from: string): Promise<string | undefined>
}

let queue: Promise<unknown> = Promise.resolve()

function ask(options: PromptOptions, from: string): Promise<string | undefined> {
    return new Promise((resolve) => {
        const target = document.body
        let answered = false
        const dialog = mount(PromptDialog, {
            target,
            props: {
                options,
                from,
                onanswer(value: string | undefined) {
                    if (answered) return
                    answered = true
                    resolve(value)
                    // After the Modal has given the keyboard back to where it was.
                    queueMicrotask(() => void unmount(dialog))
                },
            },
        })
    })
}

export function createDialogs(): ClientDialogs {
    return {
        prompt(options, from) {
            const next = queue.then(() => ask(options, from))
            queue = next.catch(() => undefined)
            return next
        },
    }
}
