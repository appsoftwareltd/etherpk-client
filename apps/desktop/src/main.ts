/**
 * EtherPK for Windows and Linux: the Client's Installed Build in a window, with the Native Bridge to
 * the person's folders. Everything that decides anything is in a module of its own, with tests. This
 * one puts them together.
 */
import { app, BrowserWindow, clipboard, dialog, ipcMain, net, protocol, safeStorage, session, shell as systemShell, type WebFrameMain } from 'electron'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { dirname, extname, join } from 'node:path'
import { DESKTOP_APP_ORIGIN, NATIVE_BRIDGE_VERSION, type ShellInfo } from '@appsoftwareltd/etherpk-native-bridge'
import { type AppConfig, readConfig } from './app/config.ts'
import { takeDrop } from './app/drops.ts'
import { readSyncServerSetting, SETTINGS_FILE, type SyncServerProblem, syncServerProblemDetail } from './app/sync-server-setting.ts'
import { Launches } from './app/launches.ts'
import { offerMenuEntry, REMOVE_MENU_ENTRY, removeMenuEntry, runsWithoutSandbox, sayNoSandbox } from './app/linux.ts'
import { setMenu } from './app/menu.ts'
import { limitPermissions, presentOrigin, SCHEME_PRIVILEGES, serveInstalledBuild } from './app/session.ts'
import { Told } from './app/told.ts'
import { AppWindows } from './app/windows.ts'
import { Issuer } from './auth/oauth.ts'
import { AppSignIn } from './auth/sign-in.ts'
import { fileStore, memoryStore, type TokenStore } from './auth/token-store.ts'
import { COPY } from './copy.ts'
import { NativeFailure } from './failure.ts'
import { Grants } from './fs/grants.ts'
import { ownArguments, startedWithAll } from './launch/arguments.ts'
import { fileLog } from './log.ts'
import { CHANNELS } from './port/channels.ts'
import { NativeShell } from './port/shell.ts'
import { type AppLife, installedAs, installerFor } from './update/installers.ts'
import { AppUpdates } from './update/updates.ts'
import { InstalledBuild } from './web/installed-build.ts'
import { isAppUrl } from './web/rules.ts'
import { parseWindowState } from './window/window-state.ts'

const CHECK_EVERY_MS = 6 * 60 * 60 * 1000
const FIRST_CHECK_AFTER_MS = 60_000
const QUESTIONS_AFTER_MS = 1_500

const packaged = app.isPackaged
const here = import.meta.dirname

// A name of its own for a development run, whose data is not a person's.
app.setName(packaged ? 'EtherPK' : 'EtherPK Dev')
if (!packaged && process.env.ETHERPK_USER_DATA) app.setPath('userData', process.env.ETHERPK_USER_DATA)
app.setAppUserModelId('com.etherpk.app')
// Read before the sandbox is asked for, which takes the switch away (src/app/linux.ts).
const withoutNamespaces = runsWithoutSandbox()
app.enableSandbox()
protocol.registerSchemesAsPrivileged([SCHEME_PRIVILEGES])

const data = app.getPath('userData')
const log = fileLog(join(data, 'logs', 'main.log'), (line) => { if (!packaged) process.stderr.write(line) })

process.on('uncaughtException', (error) => {
    log('A fault nobody expected.', error)
    dialog.showErrorBox(COPY.faultTitle, COPY.faultDetail)
})
process.on('unhandledRejection', (error) => log('A fault nobody expected.', error))

/** The arguments a person or the system gave this run, and where they are read from. */
interface Given { argv: string[]; cwd: string }
const given: Given = { argv: ownArguments(process.argv, packaged ? null : app.getAppPath()), cwd: process.cwd() }

/**
 * What later starts of the app handed over. Electron tells of them once and keeps nothing, and the
 * first start may still be starting (three files opened at once start three), so they wait here.
 */
const handedOver: Given[] = []
let takeHandedOver: ((other: Given) => void) | null = null

function handOver(_event: Electron.Event, _argv: string[], _cwd: string, sent: unknown): void {
    const other = sent as Partial<Given> | null
    if (!Array.isArray(other?.argv) || typeof other.cwd !== 'string') return
    const one = { argv: other.argv.filter((part): part is string => typeof part === 'string'), cwd: other.cwd }
    if (takeHandedOver) takeHandedOver(one)
    else handedOver.push(one)
}

/** A fault on the way to the first window, and what kind: the app's own files, or the person's data folder. */
class StartFault extends Error {
    constructor(readonly kind: 'build' | 'data', cause: unknown) {
        super(kind === 'build' ? 'The app’s own files could not be read.' : 'The app’s data folder could not be read.', { cause })
    }
}

async function starting<T>(kind: StartFault['kind'], task: () => Promise<T>): Promise<T> {
    try {
        return await task()
    } catch (error) {
        throw new StartFault(kind, error)
    }
}

/** While an update closes the windows, the app stays running with none, in case it has to open one again. */
let keepRunning = false

async function removeMenuEntryAndQuit(): Promise<void> {
    if (process.env.APPIMAGE) await removeMenuEntry(process.env.APPIMAGE)
    app.exit(0)
}

function installedBuildPath(): string {
    if (!packaged) return process.env.ETHERPK_INSTALLED_BUILD ?? join(here, '../../client/build-installed')
    return join(here, 'web')
}

/** A development run may be given another, so that a test can sign in to a server of its own. */
function configPath(): string {
    return (!packaged && process.env.ETHERPK_APP_CONFIG) || join(here, 'installed-app.config.json')
}

function textOf(file: string): string | null {
    try {
        return readFileSync(file, 'utf8')
    } catch {
        return null
    }
}

/** Written before the call returns: the last one is made as the app ends. */
function keepNow(file: string, text: string): void {
    try {
        mkdirSync(dirname(file), { recursive: true })
        writeFileSync(`${file}.crswap`, text)
        renameSync(`${file}.crswap`, file)
    } catch (error) {
        log('The window’s place could not be kept.', error)
    }
}

/** The operating system's key store, where it has one that does more than write the key beside the lock. */
function tokenStore(issuer: string): TokenStore {
    const plain = process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text'
    if (plain || !safeStorage.isEncryptionAvailable()) return memoryStore()
    return fileStore(join(data, 'sign-in.bin'), issuer, { seal: (text) => safeStorage.encryptString(text), unseal: (bytes) => safeStorage.decryptString(bytes) }, log)
}

function tell(type: 'info' | 'warning', message: string, detail: string): void {
    void dialog.showMessageBox({ type, message, detail, buttons: [COPY.ok], noLink: true })
}

function signInOf(config: AppConfig, windows: () => AppWindows): AppSignIn {
    const { signIn } = config
    return new AppSignIn({
        issuer: signIn && new Issuer(signIn, (url, init) => net.fetch(url, init)),
        store: signIn ? tokenStore(signIn.issuer) : memoryStore(),
        openBrowser: (url) => systemShell.openExternal(url),
        returned: () => windows().show(),
        notLasting: () => tell('info', COPY.signInNotKeptTitle, COPY.signInNotKeptDetail(process.platform)),
        notSaved: () => tell('warning', COPY.signInNotKeptTitle, COPY.signInNotSavedDetail),
        endedHere: () => tell('warning', COPY.signInEndedTitle, COPY.signInEndedDetail),
        log,
    })
}

async function updatesOf(config: AppConfig, life: AppLife, windows: () => AppWindows): Promise<AppUpdates> {
    const as = installedAs(process.env, process.platform, process.arch, process.execPath, packaged)
    return new AppUpdates({
        feedUrl: config.updateFeedUrl,
        keys: config.updateKeys,
        channel: config.updateChannel,
        current: app.getVersion(),
        installer: as && (await installerFor(as, process.env, life)),
        dir: join(data, 'updates'),
        fetch: (url, init) => net.fetch(url, init),
        changed: (status) => { for (const id of windows().all) windows().emit(id, 'updateStatus', status) },
        log,
    })
}

const appLife = (windows: () => AppWindows): AppLife => ({
    async closeAll() {
        keepRunning = true
        const closed = await windows().closeAll()
        if (!closed) keepRunning = false
        return closed
    },
    reopen() {
        keepRunning = false
        windows().open()
    },
    quit: () => app.quit(),
    relaunch: (executable) => app.relaunch({ execPath: executable, args: [] }),
})

/** The app's own page in the top frame of a window, or null for any other sender. */
function senderOf(frame: WebFrameMain | null, contents: Electron.WebContents): number | null {
    if (!frame || frame !== contents.mainFrame || frame.origin !== DESKTOP_APP_ORIGIN || !isAppUrl(frame.url)) return null
    return contents.id
}

/** Ask about a drop in a dialog of the main process, which no page can draw or answer. */
async function askAboutDrop(windows: AppWindows, caller: number, { message, detail }: { message: string; detail: string }): Promise<boolean> {
    const window = windows.get(caller)
    const options: Electron.MessageBoxOptions = { type: 'question', message, detail, buttons: [COPY.open, COPY.cancel], defaultId: 0, cancelId: 1, noLink: true }
    const { response } = await (window ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options))
    return response === 0
}

function connectPort(native: NativeShell, windows: AppWindows, launches: Launches): void {
    ipcMain.handle(CHANNELS.call, (event, method: unknown, args: unknown) => {
        const caller = senderOf(event.senderFrame, event.sender)
        if (caller === null) return { ok: false, name: 'SecurityError', message: 'Only the app may ask.' }
        return native.call(caller, method, args)
    })
    ipcMain.on(CHANNELS.listening, (event) => {
        const caller = senderOf(event.senderFrame, event.sender)
        if (caller !== null) windows.listening(caller)
    })
    ipcMain.on(CHANNELS.dropped, (event, paths: unknown) => {
        const caller = senderOf(event.senderFrame, event.sender)
        if (caller === null) return
        void takeDrop(paths, {
            ask: (question) => askAboutDrop(windows, caller, question),
            open: (dropped) => launches.add(dropped.map((path) => ({ kind: 'path', path }))),
            log,
        }).catch((error: unknown) => log('A drop could not be opened.', error))
    })
}

interface Dialogs { windows: AppWindows }

async function pickFolder({ windows }: Dialogs, caller: number, title?: string): Promise<string | null> {
    const window = windows.get(caller)
    const options: Electron.OpenDialogOptions = { title: title ?? COPY.chooseFolder, properties: ['openDirectory', 'createDirectory'] }
    const { canceled, filePaths } = await (window ? dialog.showOpenDialog(window, options) : dialog.showOpenDialog(options))
    return canceled ? null : (filePaths[0] ?? null)
}

async function pickSave({ windows }: Dialogs, caller: number, name: string): Promise<string | null> {
    const window = windows.get(caller)
    const extension = extname(name).slice(1)
    const options: Electron.SaveDialogOptions = {
        defaultPath: join(app.getPath('downloads'), name),
        properties: ['createDirectory', 'showOverwriteConfirmation'],
        ...(extension ? { filters: [{ name: extension.toUpperCase(), extensions: [extension] }] } : {}),
    }
    const { canceled, filePath } = await (window ? dialog.showSaveDialog(window, options) : dialog.showSaveDialog(options))
    return canceled || !filePath ? null : filePath
}

/** Text of the clipboard is for a person who is using the app, not for a page in the background. */
function readClipboard(windows: AppWindows, caller: number): Promise<string> {
    if (!windows.get(caller)?.isFocused()) throw new NativeFailure('NotAllowedError', 'The window is not in use.')
    return clipboard.readText()
}

async function start(): Promise<void> {
    const build = await starting('build', () => InstalledBuild.open(installedBuildPath()))
    const built = await starting('build', () => readConfig(configPath()))
    // A Sync Server the person set takes the place of Managed Sync, and with it the sign-in (ADR 0214).
    const syncSetting = await readSyncServerSetting({ env: process.env, file: join(data, SETTINGS_FILE), log })
    const config: AppConfig = syncSetting.server === null ? built : { ...built, signIn: null }
    const own = session.defaultSession
    serveInstalledBuild(own, build)
    presentOrigin(own)
    limitPermissions(own, log)
    setMenu(packaged)

    const stateFile = join(data, 'window.json')
    const icon = join(here, 'icon.png')
    const info: ShellInfo = {
        bridgeVersion: NATIVE_BRIDGE_VERSION,
        platform: process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux',
        appVersion: app.getVersion(),
        features: { watch: true, showInFileManager: true, print: false, signIn: config.signIn !== null, updates: false },
        syncServer: syncSetting.server,
    }
    // Each of these needs the others, all through functions called later.
    const parts = { windows: null as unknown as AppWindows, native: null as unknown as NativeShell, launches: null as unknown as Launches }
    const windowsOf = () => parts.windows
    const signIn = signInOf(config, windowsOf)
    const updates = await updatesOf(config, appLife(windowsOf), windowsOf)
    info.features.updates = updates.status().state !== 'off'
    parts.windows = new AppWindows({
        preload: join(here, 'preload.cjs'), icon: process.platform === 'linux' ? icon : undefined, info, packaged, state: parseWindowState(textOf(stateFile)),
        saveState: (state) => keepNow(stateFile, JSON.stringify(state)),
        released: (id) => { void parts.native.release(id) },
        log,
    })
    const { windows } = parts
    parts.native = new NativeShell({
        grants: await starting('data', () => Grants.open(join(data, 'grants.json'), log)),
        signIn, updates,
        host: {
            pickFolder: (caller, title) => pickFolder({ windows }, caller, title),
            pickSave: (caller, name) => pickSave({ windows }, caller, name),
            openExternal: (url) => systemShell.openExternal(url),
            showInFileManager: (path) => showInFileManager(path),
            print: (caller) => windows.get(caller)?.webContents.print({}),
            setTheme: (scheme) => windows.setScheme(scheme),
            closeAnswer: (caller, allow) => windows.answer(caller, allow),
            readClipboard: (caller) => readClipboard(windows, caller),
            takeLaunches: () => parts.launches.take(),
            emit: (caller, event, detail) => windows.emit(caller, event, detail),
            log,
        },
    })
    parts.launches = new Launches({
        shell: parts.native,
        waiting: () => {
            const window = windows.current()
            if (window) windows.emit(window.webContents.id, 'launch', {})
        },
        notFound: (name) => { void dialog.showMessageBox({ type: 'warning', message: COPY.notFoundTitle(name), detail: COPY.notFoundDetail, buttons: [COPY.ok], noLink: true }) },
        log,
    })
    connectPort(parts.native, windows, parts.launches)
    // What the app was started with is waiting before the page first asks, and then what later starts
    // handed over while this one started, in the order they came.
    await parts.launches.add(startedWithAll(given.argv, given.cwd))
    for (const other of handedOver.splice(0)) void parts.launches.add(startedWithAll(other.argv, other.cwd))
    const first = windows.open()
    takeHandedOver = (other) => {
        if (windows.current()) windows.show()
        else windows.open()
        void parts.launches.add(startedWithAll(other.argv, other.cwd))
    }
    // Questions wait until the person has the window in front of them.
    const notUsed = syncSetting.problem && { problem: syncSetting.problem, managed: built.signIn !== null }
    first.webContents.once('did-finish-load', () => setTimeout(() => afterStart(updates, icon, notUsed), QUESTIONS_AFTER_MS))
}

function showInFileManager(path: string): void {
    void stat(path).then((stats) => {
        if (stats.isDirectory()) return systemShell.openPath(path).then((failed) => { if (failed) log('The file manager could not be opened.', failed) })
        systemShell.showItemInFolder(path)
    }).catch((error: unknown) => log('The file manager could not be opened.', error))
}

/** Questions and checks that can wait until the window is there. */
function afterStart(updates: AppUpdates, icon: string, notUsed: { problem: SyncServerProblem; managed: boolean } | null): void {
    if (updates.status().state !== 'off') {
        setTimeout(() => void updates.check(), FIRST_CHECK_AFTER_MS)
        setInterval(() => void updates.check(), CHECK_EVERY_MS)
    }
    // Told at every start, since the setting is passed over at every start until it is put right.
    if (notUsed) tell('warning', COPY.syncServerNotUsedTitle, syncServerProblemDetail(notUsed.problem, notUsed.managed))
    if (process.platform !== 'linux') return
    void Told.open(join(data, 'told.json')).then(async (told) => {
        if (withoutNamespaces) await sayNoSandbox(told, log)
        if (process.env.APPIMAGE) await offerMenuEntry(process.env.APPIMAGE, icon, told, log)
    })
}

app.on('window-all-closed', () => { if (!keepRunning) app.quit() })
// Without an answer of the app's own, Electron gives a server the first certificate it finds.
app.on('select-client-certificate', (event, _contents, _url, _certificates, choose) => {
    event.preventDefault()
    choose()
})

if (given.argv.includes(REMOVE_MENU_ENTRY)) {
    void app.whenReady().then(removeMenuEntryAndQuit)
} else if (!app.requestSingleInstanceLock(given)) {
    app.quit()
} else {
    // At once, before anything is awaited: Electron tells of another start once, and keeps nothing.
    app.on('second-instance', handOver)
    app.whenReady().then(start).catch((error: unknown) => {
        log('EtherPK could not start.', error)
        const kind = error instanceof StartFault ? error.kind : null
        dialog.showErrorBox('EtherPK', kind === 'build' ? COPY.buildMissing : kind === 'data' ? COPY.dataUnreadable(data) : COPY.startFailed)
        app.exit(1)
    })
}

// A window closed by the system (a session ending) is asked like any other, through its own close event.
app.on('activate', () => { if (BrowserWindow.getAllWindows().length > 0) BrowserWindow.getAllWindows()[0].show() })
