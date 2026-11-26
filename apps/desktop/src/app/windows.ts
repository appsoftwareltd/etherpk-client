/** The app's windows: how one is created, what it may do, and how it closes. */
import { BrowserWindow, clipboard, dialog, type Event, Menu, screen, shell, type WebContents } from 'electron'
import type { NativeEventName, NativeEvents, ShellInfo } from '@appsoftwareltd/etherpk-native-bridge'
import { DESKTOP_APP_ORIGIN } from '@appsoftwareltd/etherpk-native-bridge'
import { COPY } from '../copy.ts'
import { CHANNELS, INFO_ARGUMENT } from '../port/channels.ts'
import { isAppUrl, openedWindow } from '../web/rules.ts'
import { CloseGuard } from '../window/close-guard.ts'
import { type Bounds, boundsToKeep, SMALLEST_SIZE, usableBounds, type WindowState } from '../window/window-state.ts'

export const START_URL = `${DESKTOP_APP_ORIGIN}/`
const BACKGROUND = { light: '#ffffff', dark: '#171717' }
/** A page that crashes twice this close together would only crash again. */
const CRASH_AGAIN_MS = 60_000
const SETTLED_AFTER_MS = 400
/** A page that opens more addresses than this at once is not a person clicking. */
const MOST_OPENED = 10
const OPENED_WITHIN_MS = 10_000

export interface WindowsParts {
    preload: string
    icon: string | undefined
    info: ShellInfo
    packaged: boolean
    state: WindowState
    saveState(state: WindowState): void
    /** The page of a window went, with whatever it had open. */
    released(id: number): void
    log(message: string, error?: unknown): void
}

interface AppWindow { window: BrowserWindow; guard: CloseGuard; listening: boolean; asked: Bounds | null; given: Bounds | null }

export class AppWindows {
    private readonly windows = new Map<number, AppWindow>()
    private lastFocused: number | null = null
    private opened: number[] = []

    constructor(private readonly parts: WindowsParts) {}

    get(contents: number): BrowserWindow | undefined {
        return this.windows.get(contents)?.window
    }

    get all(): number[] {
        return [...this.windows.keys()]
    }

    /** The window a person would call the app's. */
    current(): BrowserWindow | null {
        const last = this.lastFocused === null ? undefined : this.get(this.lastFocused)
        return last ?? [...this.windows.values()].at(-1)?.window ?? null
    }

    show(): void {
        const window = this.current()
        if (!window) return
        if (window.isMinimized()) window.restore()
        window.show()
        window.focus()
    }

    emit<E extends NativeEventName>(contents: number, event: E, detail: NativeEvents[E]): void {
        const window = this.get(contents)
        if (window && !window.isDestroyed()) window.webContents.send(CHANNELS.event, event, detail)
    }

    listening(contents: number): void {
        const one = this.windows.get(contents)
        if (one) one.listening = true
    }

    answer(contents: number, allow: boolean): void {
        this.windows.get(contents)?.guard.answer(allow)
    }

    /** Close every window the ordinary way. False when one stayed open. */
    async closeAll(): Promise<boolean> {
        for (const { guard } of [...this.windows.values()]) if (!(await guard.closed())) return false
        return true
    }

    setScheme(scheme: 'light' | 'dark'): void {
        this.parts.state.scheme = scheme
        for (const { window } of this.windows.values()) window.setBackgroundColor(BACKGROUND[scheme])
        this.parts.saveState(this.parts.state)
    }

    open(url: string = START_URL): BrowserWindow {
        const { parts } = this
        const first = this.windows.size === 0
        const bounds = usableBounds(parts.state, screen.getAllDisplays().map((display) => display.workArea))
        const window = new BrowserWindow({
            ...(first ? bounds : { width: bounds.width, height: bounds.height }),
            minWidth: SMALLEST_SIZE.width,
            minHeight: SMALLEST_SIZE.height,
            show: false,
            title: 'EtherPK',
            ...(parts.icon ? { icon: parts.icon } : {}),
            backgroundColor: BACKGROUND[parts.state.scheme ?? 'light'],
            webPreferences: {
                preload: parts.preload,
                additionalArguments: [INFO_ARGUMENT + encodeURIComponent(JSON.stringify(parts.info))],
                sandbox: true,
                contextIsolation: true,
                nodeIntegration: false,
                nodeIntegrationInSubFrames: false,
                nodeIntegrationInWorker: false,
                webSecurity: true,
                webviewTag: false,
                // The Client checks spelling itself. Chromium's checker would fetch dictionaries.
                spellcheck: false,
                // A page in the background still saves and syncs.
                backgroundThrottling: false,
                devTools: !parts.packaged,
            },
        })
        // Set rather than hidden, so that Alt, which the Client's own keys use, does not bring it up.
        window.setMenuBarVisibility(false)
        if (first && parts.state.maximized) window.maximize()
        this.add(window, url, first && 'x' in bounds ? (bounds as Bounds) : null)
        return window
    }

    private add(window: BrowserWindow, url: string, asked: Bounds | null): void {
        const contents = window.webContents
        const id = contents.id
        const guard = new CloseGuard({
            ask: () => this.emit(id, 'beforeClose', {}),
            listens: () => !contents.isDestroyed() && !contents.isCrashed() && (this.windows.get(id)?.listening ?? false),
            close: () => window.close(),
            closeAnyway: () => this.closeAnyway(window),
        })
        const one: AppWindow = { window, guard, listening: false, asked, given: null }
        this.windows.set(id, one)
        window.on('focus', () => { this.lastFocused = id })
        window.once('ready-to-show', () => {
            window.show()
            // Once the window manager has had its say, and before a person could have had theirs.
            setTimeout(() => { if (!window.isDestroyed()) one.given = window.getNormalBounds() }, SETTLED_AFTER_MS)
        })
        window.on('close', (event) => {
            if (!guard.request()) return event.preventDefault()
            this.remember(one)
        })
        window.on('closed', () => {
            this.windows.delete(id)
            if (this.lastFocused === id) this.lastFocused = null
            this.parts.released(id)
        })
        // Windows that is shutting down waits a moment for a page, so the page is told to save now. Its
        // answer closes nothing: if the session does end, Windows closes the window itself.
        window.on('query-session-end', () => guard.sessionEnding())
        this.guardContents(contents, id)
        this.recover(window, id)
        window.loadURL(url).catch((error: unknown) => this.parts.log(`The page could not be loaded: ${url}`, error))
    }

    private guardContents(contents: WebContents, id: number): void {
        contents.setWindowOpenHandler(({ url }) => {
            this.openAddress(url)
            return { action: 'deny' }
        })
        const stay = (event: Event, url: string) => {
            if (isAppUrl(url) && openedWindow(url).kind === 'app') return
            event.preventDefault()
            // A link with no target, to somewhere else. A file dropped on the page is a navigation too.
            this.openAddress(url)
        }
        contents.on('will-navigate', (event) => stay(event, event.url))
        contents.on('will-redirect', (event) => { if (event.isMainFrame) stay(event, event.url) })
        contents.on('will-attach-webview', (event) => event.preventDefault())
        // The page has had its say (the close guard), so nothing it sets now keeps the window.
        contents.on('will-prevent-unload', (event) => event.preventDefault())
        // Once another page is in the window, and never for a navigation that `stay` stopped: that page,
        // and what it watches and saves, stay as they were. 'did-navigate' is for the main frame only, and
        // not for a move within one page. A page that failed to load leaves an error page in its place,
        // and one stopped before it went anywhere (ERR_ABORTED, -3) leaves the page where it was.
        const left = () => {
            const one = this.windows.get(id)
            if (one) one.listening = false
            this.parts.released(id)
        }
        contents.on('did-navigate', left)
        contents.on('did-fail-load', (_event, code, _description, _url, isMainFrame) => { if (isMainFrame && code !== -3) left() })
        contents.on('context-menu', (_event, params) => this.contextMenu(contents, params))
    }

    private openAddress(url: string): void {
        const what = openedWindow(url)
        if (what.kind === 'refused') return this.parts.log('An address was not opened.', url.slice(0, 200))
        const now = Date.now()
        this.opened = this.opened.filter((at) => now - at < OPENED_WITHIN_MS)
        if (this.opened.length >= MOST_OPENED) return this.parts.log('Too many addresses were opened at once.')
        this.opened.push(now)
        if (what.kind === 'app') this.open(what.url)
        else void shell.openExternal(what.url).catch((error: unknown) => this.parts.log('The system could not open an address.', error))
    }

    private async closeAnyway(window: BrowserWindow): Promise<boolean> {
        const { response } = await dialog.showMessageBox(window, {
            type: 'warning', message: COPY.closeTitle, detail: COPY.closeDetail, buttons: [COPY.closeWait, COPY.closeAnyway], defaultId: 0, cancelId: 0, noLink: true,
        })
        return response === 1
    }

    private recover(window: BrowserWindow, id: number): void {
        let crashedAt = 0
        window.webContents.on('render-process-gone', (_event, { reason, exitCode }) => {
            this.parts.log(`The page's process ended: ${reason} (${exitCode}).`)
            const one = this.windows.get(id)
            if (one) one.listening = false
            this.parts.released(id)
            if (reason === 'clean-exit' || window.isDestroyed()) return
            const again = Date.now() - crashedAt < CRASH_AGAIN_MS
            crashedAt = Date.now()
            if (!again) return window.webContents.reload()
            void this.ask(window, COPY.crashTitle, COPY.crashDetail, [COPY.reload, COPY.quit]).then((choice) => {
                if (window.isDestroyed()) return
                if (choice === 0) window.webContents.reload()
                else window.destroy()
            })
        })
        let asking = false
        window.on('unresponsive', () => {
            if (asking) return
            asking = true
            void this.ask(window, COPY.hangTitle, COPY.hangDetail, [COPY.wait, COPY.reload]).then((choice) => {
                asking = false
                if (choice === 1 && !window.isDestroyed()) {
                    window.webContents.forcefullyCrashRenderer()
                }
            })
        })
    }

    private async ask(window: BrowserWindow, message: string, detail: string, buttons: string[]): Promise<number> {
        const { response } = await dialog.showMessageBox(window, { type: 'warning', message, detail, buttons, defaultId: 0, cancelId: 0, noLink: true })
        return response
    }

    private remember({ window, asked, given }: AppWindow): void {
        this.parts.state.bounds = boundsToKeep(asked, given, window.getNormalBounds())
        this.parts.state.maximized = window.isMaximized()
        this.parts.saveState(this.parts.state)
    }

    /** For a plain input and for selected text. The editor draws its own menu, and then this is not asked. */
    private contextMenu(contents: WebContents, params: Electron.ContextMenuParams): void {
        const items: Electron.MenuItemConstructorOptions[] = []
        const { editFlags } = params
        if (params.isEditable) {
            items.push(
                { label: COPY.undo, role: 'undo', enabled: editFlags.canUndo }, { label: COPY.redo, role: 'redo', enabled: editFlags.canRedo }, { type: 'separator' },
                { label: COPY.cut, role: 'cut', enabled: editFlags.canCut }, { label: COPY.copy, role: 'copy', enabled: editFlags.canCopy },
                { label: COPY.paste, role: 'paste', enabled: editFlags.canPaste }, { label: COPY.pastePlain, role: 'pasteAndMatchStyle', enabled: editFlags.canPaste },
                { type: 'separator' }, { label: COPY.selectAll, role: 'selectAll', enabled: editFlags.canSelectAll },
            )
        } else if (params.selectionText.trim() !== '') {
            items.push({ label: COPY.copy, role: 'copy' })
        }
        if (openedWindow(params.linkURL).kind === 'external') {
            items.push({ label: COPY.copyLink, click: () => clipboard.writeText(params.linkURL) })
        }
        if (!this.parts.packaged) items.push({ type: 'separator' }, { label: 'Inspect', click: () => contents.inspectElement(params.x, params.y) })
        if (items.length === 0) return
        const window = BrowserWindow.fromWebContents(contents)
        if (window) Menu.buildFromTemplate(items).popup({ window })
    }
}
