/** The files a person downloads, and the name each has in the update feed (apps/desktop/src/update/feed.ts). */
export const INSTALLERS = [
    { platform: 'windows-x64', file: 'EtherPK-windows-x64.exe', label: 'Windows', job: 'smoke-windows' },
    { platform: 'linux-x64-appimage', file: 'EtherPK-linux-x64.AppImage', label: 'Linux (AppImage)', job: 'smoke-linux' },
    { platform: 'linux-x64-deb', file: 'EtherPK-linux-x64.deb', label: 'Linux (deb)', job: 'smoke-linux' },
    { platform: 'android', file: 'EtherPK-android.apk', label: 'Android', job: 'smoke-android' },
]

export const CHECKSUMS = 'SHA256SUMS'

export function installerFor(platform) {
    const installer = INSTALLERS.find((one) => one.platform === platform)
    if (!installer) throw new Error(`"${platform}" is not a platform. The platforms are ${INSTALLERS.map((one) => one.platform).join(', ')}.`)
    return installer
}
