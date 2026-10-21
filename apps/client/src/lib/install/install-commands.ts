/**
 * **Install EtherPK** in the Command Menu: one of the permanent Install entries, so a keyboard
 * user finds it where every other Command is. It writes to no document, so it stays on a locked
 * Protected Document, and it is offered only while installing is possible here.
 */

import { type CommandRegistry, type ContributionRegistry, registerCommandMenuItem } from '$lib/surface'

export const APP_INSTALL = 'app.install'

export interface InstallCommandDeps {
    /** What every Install entry runs (`startInstall`). */
    install: () => void
    /** Whether this browser can install the app and it is not installed yet. */
    installable: () => boolean
}

export function registerInstallCommands(
    commands: CommandRegistry,
    contributions: ContributionRegistry,
    deps: InstallCommandDeps,
): () => void {
    const offs = [
        commands.register(APP_INSTALL, () => deps.install()),
        registerCommandMenuItem(contributions, {
            id: APP_INSTALL,
            title: 'Install EtherPK',
            detail: 'Install as an app on this device',
            icon: 'download',
            group: 'Workspace',
            order: 210,
            keywords: ['app', 'install', 'home screen', 'dock', 'taskbar', 'offline', 'pwa'],
            when: () => deps.installable(),
            command: APP_INSTALL,
        }),
    ]
    return () => {
        for (const off of offs) off()
    }
}
