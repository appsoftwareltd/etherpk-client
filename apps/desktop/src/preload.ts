/**
 * The port, put on the app's own page and nowhere else. It runs apart from the page's scripts and hands
 * over three functions. What a call may do is decided in the main process, which checks who asks.
 */
import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { DESKTOP_APP_ORIGIN, NATIVE_PORT_NAME } from '@appsoftwareltd/etherpk-native-bridge'
import type { NativeEventName, NativePort, NativeReply, ShellInfo } from '@appsoftwareltd/etherpk-native-bridge'
import { CHANNELS, INFO_ARGUMENT } from './port/channels.ts'

/** A sandboxed page at the app's address has the origin "null" and is not the app. */
function isTheApp(): boolean {
    return window.origin === DESKTOP_APP_ORIGIN && window === window.top
}

function shellInfo(): ShellInfo {
    const argument = process.argv.find((one) => one.startsWith(INFO_ARGUMENT))
    return JSON.parse(decodeURIComponent(argument!.slice(INFO_ARGUMENT.length))) as ShellInfo
}

function port(): NativePort {
    const listeners = new Set<(event: NativeEventName, detail: unknown) => void>()
    ipcRenderer.on(CHANNELS.event, (_event, name: NativeEventName, detail: unknown) => {
        for (const listener of listeners) listener(name, detail)
    })
    return {
        info: shellInfo(),
        call: (method, args) => ipcRenderer.invoke(CHANNELS.call, method, args) as Promise<NativeReply>,
        on(listener) {
            // From now on the window asks the page before it closes.
            if (listeners.size === 0) ipcRenderer.send(CHANNELS.listening)
            listeners.add(listener)
            return () => { listeners.delete(listener) }
        },
    }
}

/**
 * Files and folders dropped on the page, which the page itself did not take. Only a drop the person
 * made: a script can send a drop event of its own, but not a trusted one, and a File a script built has
 * no path.
 */
function handOverDrops(): void {
    window.addEventListener('drop', (event) => {
        const files = [...(event.dataTransfer?.files ?? [])]
        if (!event.isTrusted || event.defaultPrevented || files.length === 0) return
        event.preventDefault()
        const paths = files.map((file) => webUtils.getPathForFile(file)).filter((path) => path !== '')
        if (paths.length > 0) ipcRenderer.send(CHANNELS.dropped, paths)
    })
}

if (isTheApp()) {
    contextBridge.exposeInMainWorld(NATIVE_PORT_NAME, port())
    handOverDrops()
}
