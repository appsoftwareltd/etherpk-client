/**
 * Every word the shell itself shows: dialogs, menus and messages. The Client words everything else.
 * The rules are under "Copy" in the style guide.
 */
export const COPY = {
    closeTitle: 'EtherPK has not finished saving',
    closeDetail: 'Changes from the last few seconds may not be saved if you close EtherPK now.',
    closeWait: 'Keep EtherPK open',
    closeAnyway: 'Close without saving',

    crashTitle: 'EtherPK stopped working',
    crashDetail: 'Saved notes are not affected. Reload EtherPK to continue.',
    reload: 'Reload',
    quit: 'Quit',

    hangTitle: 'EtherPK is not responding',
    hangDetail: 'You can wait, or reload EtherPK. Changes from the last few seconds may not be saved if you reload.',
    wait: 'Wait',

    faultTitle: 'EtherPK ran into a problem',
    faultDetail: 'Restart EtherPK if something does not work. The details are in EtherPK’s log.',

    buildMissing: 'EtherPK is not installed correctly. Install EtherPK again. Your notes are not affected.',
    dataUnreadable: (folder: string) => `EtherPK could not read its own files in ${folder}. Check that you can open that folder, then start EtherPK again. Your notes are not affected.`,
    startFailed: 'EtherPK could not start. Start EtherPK again, and install EtherPK again if it still does not start. Your notes are not affected, and the details are in EtherPK’s log.',

    notFoundTitle: (name: string) => `EtherPK could not open “${name}”`,
    notFoundDetail: 'The file or folder is not there, or you do not have permission to open it.',

    signInNotKeptTitle: 'You are signed in until you quit EtherPK',
    signInNotKeptDetail: (platform: NodeJS.Platform) => platform === 'linux'
        ? 'EtherPK found no keyring on this device to keep your sign-in in, so you will need to sign in again the next time you start EtherPK. To stay signed in, set up a keyring such as GNOME Keyring or KWallet.'
        : 'EtherPK could not use the system’s protected storage to keep your sign-in, so you will need to sign in again the next time you start EtherPK.',
    signInNotSavedDetail: 'EtherPK could not save your sign-in on this device, so you will need to sign in again the next time you start EtherPK. The details are in EtherPK’s log.',
    signInEndedTitle: 'Sign in to EtherPK again',
    signInEndedDetail: 'EtherPK lost its connection while it renewed your sign-in, so it signed you out on this device. Your other devices are still signed in, and your notes are not affected.',

    dropTitle: (count: number, name: string) => (count === 1 ? `Open “${name}” in EtherPK?` : `Open ${count} items in EtherPK?`),
    dropDetail: (paths: readonly string[], folders: number) => {
        const what = paths.length === 1 ? (folders === 1 ? 'this folder and everything inside' : 'this file') : 'these files and folders'
        return `EtherPK will be able to read and change ${what}:\n\n${paths.join('\n')}`
    },
    dropMore: (count: number) => `and ${count} more`,
    open: 'Open',
    cancel: 'Cancel',

    noSandboxTitle: 'EtherPK is running with part of its sandbox off',
    noSandboxDetail: 'The sandbox limits what a web page or an extension can reach if it breaks out of EtherPK. This system does not let an AppImage use all of the sandbox. On Ubuntu and Debian, install the .deb package of EtherPK to use the whole sandbox.',

    syncServerNotUsedTitle: 'EtherPK did not use the Sync Server you set',
    syncServerStartedManaged: 'EtherPK started with Managed Sync instead.',
    syncServerStartedWithout: 'EtherPK started without that Sync Server.',
    syncServerVariableWrong: (variable: string, value: string, instead: string) =>
        `${variable} is set to "${value}", which is not a Sync Server address. ${instead} Set ${variable} to the server's address, such as https://sync.example.com, or remove the variable.`,
    syncServerFileValueWrong: (key: string, file: string, value: string, instead: string) =>
        `${key} in ${file} is "${value}", which is not a Sync Server address. ${instead} Change ${key} to the server's address, such as https://sync.example.com, or remove the line.`,
    syncServerFileNotJson: (file: string, instead: string) =>
        `EtherPK could not read ${file}, because the file is not valid JSON. ${instead} Correct the JSON, or delete the file.`,
    syncServerFileUnreadable: (file: string, instead: string) =>
        `EtherPK could not open ${file}. ${instead} Check the file's permissions, or delete the file.`,

    menuEntryTitle: 'Add EtherPK to your applications menu?',
    menuEntryDetail: 'EtherPK will also be listed under “Open with” for Markdown files, and will open etherpk: links. To remove the entry later, run the AppImage with --remove-menu-entry.',
    menuEntryAdd: 'Add to menu',
    notNow: 'Not now',

    ok: 'OK',
    chooseFolder: 'Choose a folder',
    cut: 'Cut',
    copy: 'Copy',
    paste: 'Paste',
    pastePlain: 'Paste as plain text',
    selectAll: 'Select all',
    undo: 'Undo',
    redo: 'Redo',
    copyLink: 'Copy link',
    view: 'View',
    edit: 'Edit',
    zoomIn: 'Zoom in',
    zoomOut: 'Zoom out',
    zoomReset: 'Reset zoom',
    fullScreen: 'Full screen',
} as const
