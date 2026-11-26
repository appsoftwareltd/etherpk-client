/**
 * Adding an AppImage to the applications menu. An AppImage installs nothing, so it has no menu entry,
 * no icon, and no file or link opens with it until one is written for this person, in their own folder.
 */
import { mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { replaceFile } from '../fs/atomic-write.ts'

export const ENTRY_NAME = 'etherpk.desktop'
export const ICON_NAME = 'etherpk'
/** Says the entry is the app's own to change and remove. One a person wrote has no such line. */
const OURS = 'X-EtherPK-AppImage=true'

export interface DesktopEntryPlaces { data: string }

/**
 * One argument of `Exec`, in the two layers the Desktop Entry Specification has: the quoting of the
 * argument, then the escaping of a string value. A `%` would be a field code.
 */
export function execArgument(path: string): string {
    const quoted = `"${path.replace(/["`$\\]/g, (character) => `\\${character}`)}"`
    return quoted.replaceAll('%', '%%').replaceAll('\\', '\\\\')
}

export function desktopEntry(appImage: string): string {
    // A line break cannot be written in a value, and no file manager makes such a path.
    if (/[\r\n]/.test(appImage)) throw new Error('The path of the AppImage holds a line break.')
    return [
        '[Desktop Entry]',
        'Type=Application',
        'Name=EtherPK',
        'Comment=Notes, journals and tasks',
        `Exec=${execArgument(appImage)} %U`,
        `TryExec=${appImage.replaceAll('\\', '\\\\')}`,
        `Icon=${ICON_NAME}`,
        'Terminal=false',
        'Categories=Office;',
        'StartupWMClass=EtherPK',
        'StartupNotify=true',
        'MimeType=text/markdown;x-scheme-handler/etherpk;',
        OURS,
        '',
    ].join('\n')
}

export function desktopEntryPaths({ data }: DesktopEntryPlaces): { entry: string; icon: string } {
    return { entry: join(data, 'applications', ENTRY_NAME), icon: join(data, 'icons', 'hicolor', '512x512', 'apps', `${ICON_NAME}.png`) }
}

/** Whether there is an entry, whether it is the app's own, and whether it starts this AppImage. */
export async function entryState(places: DesktopEntryPlaces, appImage: string): Promise<'none' | 'current' | 'old' | 'theirs'> {
    const text = await readFile(desktopEntryPaths(places).entry, 'utf8').catch(() => null)
    if (text === null) return 'none'
    if (!text.split('\n').includes(OURS)) return 'theirs'
    return text === desktopEntry(appImage) ? 'current' : 'old'
}

export async function writeEntry(places: DesktopEntryPlaces, appImage: string, icon: Uint8Array): Promise<void> {
    const paths = desktopEntryPaths(places)
    await mkdir(join(paths.entry, '..'), { recursive: true })
    await mkdir(join(paths.icon, '..'), { recursive: true })
    await replaceFile(paths.icon, icon)
    await replaceFile(paths.entry, Buffer.from(desktopEntry(appImage)))
}

export async function removeEntry(places: DesktopEntryPlaces, appImage: string): Promise<void> {
    const state = await entryState(places, appImage)
    if (state === 'none' || state === 'theirs') return
    const paths = desktopEntryPaths(places)
    await rm(paths.entry, { force: true })
    await rm(paths.icon, { force: true })
}
