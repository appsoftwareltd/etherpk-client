/** The messages between a window and the main process. There are no others. */
export const CHANNELS = {
    call: 'etherpk:call',
    event: 'etherpk:event',
    listening: 'etherpk:listening',
    dropped: 'etherpk:dropped',
} as const

/** How a window is told what shell it is in, before any script of the page runs. */
export const INFO_ARGUMENT = '--etherpk-shell='
