/**
 * `context.dialogs`: the dialogs the Client draws for an extension (`PromptDialog.svelte`,
 * `ChooseDialog.svelte`), and the calendar it opens beside an extension's element
 * (`../document/calendar/date-picker-popover.ts`).
 *
 * Each dialog names the extension that asks, so a question is never mistaken for the Client's own.
 *
 * One question at a time: a second prompt asked while one is open waits until the first is answered,
 * so two extensions can never stack dialogs over each other, and the keyboard always has one place to
 * be. The calendar is not in that queue: it opens beside the element it was asked from, at once,
 * and only one is open at a time.
 */
import type { ChooseOptions, PickDateOptions, PromptOptions } from '@appsoftwareltd/etherpk-extension-api'
import { type Component, mount, unmount } from 'svelte'

import { pickDateBeside } from '#lib/document/calendar/date-picker-popover.js'

import ChooseDialog from './ChooseDialog.svelte'
import PromptDialog from './PromptDialog.svelte'

/** `context.dialogs` for every extension: the scoped context passes the asking extension's name. */
export interface ClientDialogs {
    prompt(options: PromptOptions, from: string): Promise<string | undefined>
    choose(options: ChooseOptions, from: string): Promise<string | undefined>
    pickDate(options: PickDateOptions): Promise<string | undefined>
}

/** What each dialog component takes: the extension's options, its name, and where the answer goes. */
type DialogProps<O> = { options: O; from: string; onanswer: (value: string | undefined) => void }

let queue: Promise<unknown> = Promise.resolve()

function ask<O>(component: Component<DialogProps<O>>, options: O, from: string): Promise<string | undefined> {
    return new Promise((resolve) => {
        const target = document.body
        let answered = false
        const dialog = mount(component, {
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

/** Ask once every question asked before has been answered. */
function inTurn<O>(component: Component<DialogProps<O>>, options: O, from: string): Promise<string | undefined> {
    const next = queue.then(() => ask(component, options, from))
    queue = next.catch(() => undefined)
    return next
}

export function createDialogs(): ClientDialogs {
    return {
        prompt: (options, from) => inTurn(PromptDialog, options, from),
        choose: (options, from) => inTurn(ChooseDialog, options, from),
        pickDate: (options) => pickDateBeside(options),
    }
}
