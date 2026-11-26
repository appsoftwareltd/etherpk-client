/**
 * How the desktop app is packaged. `pnpm package:linux` and `pnpm package:windows` run it, each on a
 * build that is already there (`pnpm build`, and the Client's Installed Build).
 *
 * electron-builder's own updater is not used, so nothing is published and no update metadata is made.
 * The app reads EtherPK's signed feed (src/update/feed.ts).
 */
const windows = process.argv.includes('--win')

/** @type {import('electron-builder').Configuration} */
module.exports = {
    appId: 'com.etherpk.app',
    productName: 'EtherPK',
    copyright: 'Copyright © App Software Ltd',
    // The workspace's name has a scope, which no installer's package name may have.
    extraMetadata: { name: 'etherpk', desktopName: 'etherpk.desktop', homepage: 'https://etherpk.com', description: 'Notes, journals and tasks' },
    directories: { output: 'release', buildResources: 'resources' },
    files: [
        '!**/*',
        'package.json',
        // The bundles, and in dist/web the Client. Inside the archive, which the app checks itself against on Windows.
        'dist/**',
    ],
    asar: true,
    npmRebuild: false,
    publish: null,
    // The Client's interface is in English, so Chromium's is too.
    electronLanguages: ['en-US', 'en-GB'],
    electronFuses: {
        runAsNode: false,
        enableNodeOptionsEnvironmentVariable: false,
        enableNodeCliInspectArguments: false,
        // The app keeps no cookies. On Linux the key would be asked of the keyring at each start, for nothing.
        enableCookieEncryption: windows,
        // Checked by Electron on Windows and macOS. On Linux the fuse does nothing.
        enableEmbeddedAsarIntegrityValidation: windows,
        onlyLoadAppFromAsar: true,
        loadBrowserProcessSpecificV8Snapshot: false,
        grantFileProtocolExtraPrivileges: false,
    },
    // The AppImage runtime that needs no FUSE library on the system, and whose starter leaves Chromium's
    // sandbox on wherever the system allows one.
    toolsets: { appimage: '1.0.3' },
    icon: '../client/static/icon-512.png',
    linux: {
        target: [{ target: 'AppImage', arch: 'x64' }, { target: 'deb', arch: 'x64' }],
        executableName: 'etherpk',
        category: 'Office',
        synopsis: 'Notes, journals and tasks',
        description: 'Notes, journals and tasks, in a folder of your own or encrypted and synced.',
        maintainer: 'App Software Ltd',
        vendor: 'App Software Ltd',
        mimeTypes: ['text/markdown', 'x-scheme-handler/etherpk'],
        desktop: { entry: { Name: 'EtherPK', StartupWMClass: 'EtherPK', StartupNotify: 'true' } },
    },
    appImage: { artifactName: 'EtherPK-linux-x64.${ext}' },
    deb: { artifactName: 'EtherPK-linux-x64.${ext}', packageName: 'etherpk' },
    win: { target: [{ target: 'nsis', arch: 'x64' }], artifactName: 'EtherPK-windows-x64.${ext}' },
    nsis: {
        // For this account only, in one step: Windows asks for no administrator, on an update either.
        oneClick: true,
        perMachine: false,
        allowElevation: false,
        packElevateHelper: false,
        include: 'resources/installer.nsh',
        differentialPackage: false,
        // Uninstalling leaves the person's folders alone, and what the app keeps as well.
        deleteAppDataOnUninstall: false,
        shortcutName: 'EtherPK',
    },
}
