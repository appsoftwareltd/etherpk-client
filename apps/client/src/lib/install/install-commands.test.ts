import { describe, expect, it, vi } from 'vitest'

import { createCommandRegistry, createContributionRegistry, listCommandMenuItems } from '$lib/surface'

import { APP_INSTALL, registerInstallCommands } from './install-commands'

const anywhere = { inTable: false, tableInsertable: false, bodyWritable: false }

describe('registerInstallCommands', () => {
    it('offers Install EtherPK in the Command Menu while it can be installed, even on a locked document', async () => {
        const commands = createCommandRegistry()
        const contributions = createContributionRegistry()
        const install = vi.fn()
        let installable = true
        const teardown = registerInstallCommands(commands, contributions, { install, installable: () => installable })

        expect(listCommandMenuItems(contributions, anywhere).map((item) => item.id)).toContain(APP_INSTALL)
        await commands.execute(APP_INSTALL)
        expect(install).toHaveBeenCalledTimes(1)

        installable = false
        expect(listCommandMenuItems(contributions, anywhere).map((item) => item.id)).not.toContain(APP_INSTALL)
        teardown()
    })
})
