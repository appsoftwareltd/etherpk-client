/** Putting a checked release in the place of the running app, on each platform. */
import { type ChildProcess, spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, chmod, copyFile, open, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { PlatformKey } from './feed.ts'
import { type Installer, InstallerNotStarted } from './updates.ts'

/** The app's windows and its end, which an installer needs. */
export interface AppLife {
    /** Close every window the ordinary way, and keep the app running with none. False when one stayed open. */
    closeAll(): Promise<boolean>
    /** Open a window again, after `closeAll`, when the install could not go on. */
    reopen(): void
    quit(): void
    relaunch(executable: string): void
}

export type Spawner = (command: string, args: string[], options: { detached: boolean; stdio: 'ignore' }) => ChildProcess

/** Resolves once the program is running, and rejects when the system would not start it. */
function started(child: ChildProcess): Promise<void> {
    return new Promise((resolve, reject) => {
        child.once('spawn', () => resolve())
        child.once('error', reject)
    })
}

/** How this copy of the app was installed, or null when it cannot tell: a development run, an unpacked folder. */
export function installedAs(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, arch: string, executable: string, packaged: boolean): PlatformKey | null {
    if (!packaged || arch !== 'x64') return null
    if (platform === 'win32') return 'windows-x64'
    if (platform !== 'linux') return null
    if (env.APPIMAGE) return 'linux-x64-appimage'
    return executable.startsWith('/opt/EtherPK/') ? 'linux-x64-deb' : null
}

/** Write a copy of `source` beside `target` and put it in its place in one rename. */
export async function replaceExecutable(source: string, target: string): Promise<void> {
    const temporary = join(dirname(target), `.${Date.now()}-etherpk-update`)
    try {
        await copyFile(source, temporary, constants.COPYFILE_EXCL)
        await chmod(temporary, 0o755)
        const handle = await open(temporary, 'r')
        await handle.sync().finally(() => handle.close())
        await rename(temporary, target)
    } catch (error) {
        await rm(temporary, { force: true })
        throw error
    }
}

export async function installerFor(platform: PlatformKey, env: NodeJS.ProcessEnv, life: AppLife, spawner: Spawner = spawn): Promise<Installer> {
    if (platform === 'linux-x64-appimage') {
        const target = env.APPIMAGE!
        // An AppImage in a folder only an administrator writes to cannot replace itself.
        const installs = await access(dirname(target), constants.W_OK).then(() => true, () => false)
        return {
            platform, installs,
            async install(path) {
                // Replaced first, while there is still a window to say so if it fails. The file that is
                // running stays as it is until the app ends.
                await replaceExecutable(path, target)
                if (!(await life.closeAll())) return false
                life.relaunch(target)
                life.quit()
                return true
            },
        }
    }
    if (platform === 'windows-x64') {
        return {
            platform, installs: true,
            async install(path) {
                if (!(await life.closeAll())) return false
                // /S: no questions. --force-run: start the app again when done. The installer is for this
                // account only, so Windows asks for no administrator. It waits for this app to end.
                try {
                    const child = spawner(path, ['/S', '--updated', '--force-run'], { detached: true, stdio: 'ignore' })
                    await started(child)
                    child.unref()
                } catch (error) {
                    // Security software, or a file gone from the folder: the app stays, and says so.
                    life.reopen()
                    throw new InstallerNotStarted('The installer did not start.', { cause: error })
                }
                life.quit()
                return true
            },
        }
    }
    return { platform, installs: false, install: async () => false }
}
