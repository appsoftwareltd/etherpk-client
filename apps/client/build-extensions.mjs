// Builds each loaded Built-in Extension (ADR 0121) that lives in this repository, before the
// Client's dev server or build starts, so the bundle the Client serves exists.
//
// A loaded extension is named under `etherpk.builtInExtensions` in this package.json. One installed
// from npm arrives built and is left alone; one that pnpm links from the repository's
// `extensions/` folder is built here with its own `build` script. Once an extension leaves the
// repository for its own (ADR 0122), it arrives from npm and this has nothing to do for it.
import { execFileSync } from 'node:child_process'
import { readFileSync, realpathSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const clientRoot = dirname(fileURLToPath(import.meta.url))
const named = JSON.parse(readFileSync(join(clientRoot, 'package.json'), 'utf8')).etherpk?.builtInExtensions ?? []

for (const name of named) {
    let directory
    try {
        directory = realpathSync(join(clientRoot, 'node_modules', ...name.split('/')))
    } catch {
        console.error(`build-extensions: ${name} is not installed. Run pnpm install.`)
        process.exit(1)
    }
    // A package from npm lives in pnpm's store, under node_modules: it is built already.
    if (directory.split(sep).includes('node_modules')) continue
    const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
    if (!manifest.scripts?.build) continue
    console.warn(`build-extensions: building ${name}`)
    execFileSync('pnpm', ['--dir', directory, 'run', 'build'], { stdio: 'inherit' })
}
