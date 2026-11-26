/**
 * Bundles the desktop app into dist/: the main process, the preload and what the build was made with.
 *
 * The account site is the one the Client's Installed Build was made with (its installed-settings.json,
 * from INSTALLED_ACCOUNT_ISSUER). Without one the app has no sign-in. The other settings come from the
 * environment, and each is optional:
 *   INSTALLED_UPDATE_FEED_URL    the signed update feed. Without it, or with no key in update-keys.json,
 *                                the app does not check for updates.
 *   INSTALLED_UPDATE_CHANNEL     the channel of the feed to follow ("stable").
 *
 * `--web` adds the Client's Installed Build, which a package carries. A development run reads it where it is.
 */
import { build } from 'esbuild'
import { access, copyFile, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const here = import.meta.dirname
const dist = join(here, 'dist')
await rm(dist, { recursive: true, force: true })
await mkdir(dist, { recursive: true })

const common = {
    bundle: true, platform: 'node', target: 'node24', external: ['electron'], logLevel: 'warning', legalComments: 'none',
    // Comments say why, for a reader of the source. The app carries the code.
    minifySyntax: true, minifyWhitespace: true, sourcemap: false,
}
await build({ ...common, format: 'cjs', entryPoints: [join(here, 'src/main.ts')], outfile: join(dist, 'main.cjs'), define: { 'import.meta.dirname': '__dirname' } })
// The preload runs in a sandbox, where nothing but Electron can be required.
await build({ ...common, format: 'cjs', entryPoints: [join(here, 'src/preload.ts')], outfile: join(dist, 'preload.cjs') })

const setting = (name) => process.env[name]?.trim() || null
const web = process.env.ETHERPK_INSTALLED_BUILD ?? join(here, '../client/build-installed')
const config = {
    // The account site the Client was built with, so the page and the shell name one (installed-build.ts).
    issuer: await builtIssuer(web),
    updateFeedUrl: setting('INSTALLED_UPDATE_FEED_URL'),
    updateChannel: setting('INSTALLED_UPDATE_CHANNEL') ?? 'stable',
    updateKeys: JSON.parse(await readFile(join(here, 'update-keys.json'), 'utf8')),
}
await writeFile(join(dist, 'installed-app.config.json'), `${JSON.stringify(config, null, 2)}\n`)
if (process.argv.includes('--web')) {
    // A copy, so that what is packaged is one build whole, whatever happens to the original meanwhile.
    await cp(web, join(dist, 'web'), { recursive: true, filter: (path) => !/\.(map|br|gz)$/.test(path) })
    for (const file of ['index.html', 'csp.txt']) await access(join(dist, 'web', file))
}
await copyFile(join(here, '../client/static/icon-512.png'), join(dist, 'icon.png'))
console.warn(`desktop: built into ${dist} (sign-in ${config.issuer ? 'on' : 'off'}, updates ${config.updateFeedUrl && config.updateKeys.length ? 'on' : 'off'})`)

/** The account site in the Installed Build's settings. A build that has none is too old for this app. */
async function builtIssuer(folder) {
    const file = join(folder, 'installed-settings.json')
    const text = await readFile(file, 'utf8').catch(() => {
        throw new Error(`${file} is missing. Build the Client's Installed Build first: pnpm --filter @appsoftwareltd/etherpk-client build:installed`)
    })
    return JSON.parse(text).accountIssuer ?? null
}
