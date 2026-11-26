// Checks which servers the Native Apps are about to be built with, before the Installed Build is made
// (ADR 0214). A published app opens with the managed Sync Server and its sign-in, and their addresses
// come from the repository's variables, never from the code. A variable left unset would otherwise
// make a standalone app with no word said, so the build stops here instead. A fork that means to
// build standalone apps says so with INSTALLED_STANDALONE=true, and then sets none of the three.
//
//   node scripts/native-apps/installed-settings.mjs
import { pathToFileURL } from 'node:url'

export const MANAGED_SETTINGS = ['INSTALLED_ACCOUNT_ISSUER', 'INSTALLED_MANAGED_SYNC_URL', 'INSTALLED_WEB_CLIENT_URL']
export const STANDALONE_SWITCH = 'INSTALLED_STANDALONE'

/** "A, B and C". */
function names(list) {
    return list.length === 1 ? list[0] : `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`
}

/** Why the apps may not be built with these settings, or null when they may. */
export function settingsProblem(env) {
    const set = MANAGED_SETTINGS.filter((name) => (env[name] ?? '') !== '')
    const unset = MANAGED_SETTINGS.filter((name) => !set.includes(name))
    const standalone = env[STANDALONE_SWITCH] ?? ''
    if (standalone !== '' && standalone !== 'true') {
        return `${STANDALONE_SWITCH} is "${standalone}". Set it to "true" to build standalone apps, or remove it to build them with the managed servers.`
    }
    if (standalone === 'true') {
        return set.length === 0
            ? null
            : `${STANDALONE_SWITCH} is "true", so the apps are built standalone, but ${names(set)} ${set.length === 1 ? 'is' : 'are'} set too. Remove ${set.length === 1 ? 'it' : 'them'}, or remove ${STANDALONE_SWITCH}.`
    }
    if (unset.length === 0) return null
    return `${names(unset)} ${unset.length === 1 ? 'is' : 'are'} not set, so the apps would open with no Sync Server and no sign-in. Set ${unset.length === 1 ? 'it' : 'them'} as repository variables, or set ${STANDALONE_SWITCH} to "true" to build standalone apps on purpose.`
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
    const problem = settingsProblem(process.env)
    if (problem !== null) {
        console.error(problem)
        process.exit(1)
    }
    console.log(process.env[STANDALONE_SWITCH] === 'true' ? 'Building standalone apps.' : 'Building the apps with the managed servers.')
}
