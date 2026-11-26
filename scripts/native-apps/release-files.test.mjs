// Run with `node --test scripts/native-apps/release-files.test.mjs` (part of `pnpm test`).
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { readFeed } from '../../apps/desktop/src/update/feed.ts'
import { planAttach } from './attach.mjs'
import { chooseInstallers, notesFor } from './collect.mjs'
import { feedProblems, keyProblems } from './check-feed.mjs'
import { keySetsToSatisfy, parseSigningKey } from './feed.mjs'

// Git exports GIT_DIR and its kin to a hook it runs, and the pre-push hook runs these tests. Left in
// place, every `git` below, and in the scripts the tests start, would act on this repository instead
// of the throwaway ones made here: `git init --bare` once set this repository's core.bare. Drop them,
// so each command reads the folder it is run in.
for (const name of Object.keys(process.env)) if (name.startsWith('GIT_')) delete process.env[name]

const here = import.meta.dirname
const scratch = mkdtempSync(join(tmpdir(), 'etherpk-release-files-'))
after(() => rmSync(scratch, { recursive: true, force: true }))

const folder = (name) => {
    const path = join(scratch, name)
    mkdirSync(path, { recursive: true })
    return path
}
const run = (script, args, env = {}) => spawnSync(process.execPath, [join(here, script), ...args], { encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: '', GITHUB_STEP_SUMMARY: '', ...env } })
const passed = { result: 'success' }
const failed = { result: 'failure' }
const skipped = { result: 'skipped' }

// --- What goes on a release ------------------------------------------------------------------------------

test('an installer whose smoke test did not pass is left out and named, and the others go', () => {
    const { made, missing } = chooseInstallers({ 'smoke-windows': failed, 'smoke-linux': passed, 'smoke-android': passed }, { android: true })
    assert.deepEqual(made.map((one) => one.platform), ['linux-x64-appimage', 'linux-x64-deb', 'android'])
    assert.deepEqual(missing.map((one) => one.label), ['Windows'])
})

test('with no Android key set up, the APK is neither made nor missing', () => {
    const { made, missing } = chooseInstallers({ 'smoke-windows': passed, 'smoke-linux': passed, 'smoke-android': skipped }, { android: false })
    assert.equal(made.some((one) => one.platform === 'android'), false)
    assert.deepEqual(missing, [])
})

test('a job that was skipped or is not there made nothing', () => {
    const { made, missing } = chooseInstallers({ 'smoke-linux': skipped }, { android: true })
    assert.deepEqual(made, [])
    assert.equal(missing.length, 4)
})

test('the release notes say how to check a download and what is missing', () => {
    const notes = notesFor({ made: [{ label: 'Android', file: 'EtherPK-android.apk' }], missing: [{ label: 'Windows' }] }, 'example/app')
    assert.match(notes, /sha256sum --check --ignore-missing SHA256SUMS/)
    assert.match(notes, /gh attestation verify EtherPK-android.apk --repo example\/app/)
    assert.match(notes, /no installer for Windows/)
    assert.equal(notesFor({ made: [], missing: [] }, 'example/app'), '')
})

test('collect copies what passed, with the checksums a person can check', () => {
    const from = folder('artifacts/windows')
    writeFileSync(join(from, 'EtherPK-windows-x64.exe'), 'an installer')
    const linux = folder('artifacts/linux')
    writeFileSync(join(linux, 'EtherPK-linux-x64.AppImage'), 'one')
    writeFileSync(join(linux, 'EtherPK-linux-x64.deb'), 'two')
    const out = join(scratch, 'collected')
    const needs = JSON.stringify({ 'smoke-windows': failed, 'smoke-linux': passed, 'smoke-android': skipped })
    const result = run('collect.mjs', ['--from', join(scratch, 'artifacts'), '--out', out], { NEEDS: needs, ANDROID_CERT_SHA256: '', GITHUB_REPOSITORY: 'example/app' })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(existsSync(join(out, 'EtherPK-windows-x64.exe')), false)
    assert.match(result.stdout, /::error.*Windows/)
    execFileSync('sha256sum', ['--check', '--strict', 'SHA256SUMS'], { cwd: out })
    assert.equal(readFileSync(join(out, 'SHA256SUMS'), 'utf8').trim().split('\n').length, 2)
})

test('collect fails when a file that passed is not there', () => {
    const result = run('collect.mjs', ['--from', folder('empty'), '--out', join(scratch, 'none')], { NEEDS: JSON.stringify({ 'smoke-windows': passed }), ANDROID_CERT_SHA256: '', GITHUB_REPOSITORY: 'example/app' })
    assert.notEqual(result.status, 0)
})

// --- Attaching to a release that may be there already ----------------------------------------------------

const local = [{ name: 'a.exe', digest: 'sha256:1' }, { name: 'SHA256SUMS', digest: 'sha256:2' }]

test('a release that is not there yet takes everything', () => {
    assert.deepEqual(planAttach([], local), { upload: ['a.exe', 'SHA256SUMS'], replace: [] })
})

test('a file that is there is not sent again, and the checksums are replaced when they grew', () => {
    assert.deepEqual(planAttach([{ name: 'a.exe', digest: 'sha256:1' }, { name: 'SHA256SUMS', digest: 'sha256:old' }], local), { upload: [], replace: ['SHA256SUMS'] })
    assert.deepEqual(planAttach(local, local), { upload: [], replace: [] })
})

test('a published installer is never replaced by another', () => {
    assert.throws(() => planAttach([{ name: 'a.exe', digest: 'sha256:other' }], local), /a\.exe/)
    // The same when GitHub does not say what it holds.
    assert.throws(() => planAttach([{ name: 'a.exe', digest: null }], local), /a\.exe/)
})

// --- The keys, and a feed from end to end ------------------------------------------------------------------

test('the keys are made outside any repository, readable by their owner only, and each prints no private half', () => {
    const where = join(scratch, 'keys')
    const result = run('create-update-keys.mjs', [where, '--name', 'example'])
    assert.equal(result.status, 0, result.stderr)
    for (const name of ['example-a', 'example-b']) {
        const file = join(where, `${name}.key`)
        const secret = readFileSync(file, 'utf8').trim()
        assert.equal(parseSigningKey(secret).id, name)
        assert.equal(statSync(file).mode & 0o077, 0)
        assert.equal(result.stdout.includes(secret.split(':')[1]), false)
    }
    assert.deepEqual(JSON.parse(readFileSync(join(where, 'update-keys.json'), 'utf8')).map((key) => key.id), ['example-a', 'example-b'])
    // A second run would make other keys under the same names.
    assert.notEqual(run('create-update-keys.mjs', [where, '--name', 'example']).status, 0)
})

test('the keys are not made inside a repository', () => {
    const inside = join(here, 'made-by-a-test')
    const result = run('create-update-keys.mjs', [inside])
    assert.notEqual(result.status, 0)
    assert.equal(existsSync(inside), false)
})

test('a release becomes a feed the apps take, and the next follows it', () => {
    const where = join(scratch, 'end-to-end-keys')
    run('create-update-keys.mjs', [where, '--name', 'example'])
    const trusted = join(where, 'update-keys.json')
    const env = { UPDATE_FEED_KEY: readFileSync(join(where, 'example-a.key'), 'utf8'), GITHUB_REPOSITORY: 'example/app' }
    const assets = folder('release')
    writeFileSync(join(assets, 'EtherPK-linux-x64.deb'), 'a package')
    const first = join(scratch, 'feed-1.json')
    const made = run('make-feed.mjs', ['--action', 'promote', '--version', '1.2.0', '--assets', assets, '--platforms', 'released', '--start-after', '0', '--keys', trusted, '--out', first], env)
    assert.equal(made.status, 0, made.stderr)

    const keys = JSON.parse(readFileSync(trusted, 'utf8'))
    const payload = readFeed(readFileSync(first, 'utf8'), { keys, highestSequence: 0, now: Date.now() })
    assert.deepEqual(Object.keys(payload.channels.stable), ['linux-x64-deb'])
    assert.equal(payload.channels.stable['linux-x64-deb'].sha512, createHash('sha512').update('a package').digest('hex'))

    const second = join(scratch, 'feed-2.json')
    const paused = run('make-feed.mjs', ['--action', 'pause', '--platforms', 'linux-x64-deb', '--previous', first, '--keys', trusted, '--out', second], env)
    assert.equal(paused.status, 0, paused.stderr)
    assert.equal(readFeed(readFileSync(second, 'utf8'), { keys, highestSequence: 1, now: Date.now() }).sequence, 2)

    // A platform asked for by name, with no file in the release.
    const without = run('make-feed.mjs', ['--action', 'promote', '--version', '1.3.0', '--assets', assets, '--platforms', 'android', '--previous', second, '--keys', trusted, '--out', join(scratch, 'feed-3.json')], env)
    assert.notEqual(without.status, 0)
    assert.match(without.stderr, /EtherPK-android\.apk/)
    assert.equal(existsSync(join(scratch, 'feed-3.json')), false)

    // Showing what would be signed needs no key, and signs nothing.
    const shown = run('make-feed.mjs', ['--action', 'renew', '--previous', second, '--keys', trusted, '--show'], { GITHUB_REPOSITORY: 'example/app', UPDATE_FEED_KEY: '' })
    assert.equal(shown.status, 0, shown.stderr)
    assert.equal(JSON.parse(shown.stdout).sequence, 3)
})

test('a feed is not signed when a released set of keys would refuse it', () => {
    const where = join(scratch, 'rotation-keys')
    run('create-update-keys.mjs', [where, '--name', 'old'])
    run('create-update-keys.mjs', [where.replace('rotation', 'rotation-new'), '--name', 'new'])
    const oldKeys = JSON.parse(readFileSync(join(where, 'update-keys.json'), 'utf8'))
    const newWhere = where.replace('rotation', 'rotation-new')
    const newKeys = JSON.parse(readFileSync(join(newWhere, 'update-keys.json'), 'utf8'))
    const current = join(scratch, 'rotation-current.json')
    const released = join(scratch, 'rotation-released.json')
    writeFileSync(current, JSON.stringify(newKeys))
    writeFileSync(released, JSON.stringify([{ firstVersion: '1.0.0', keys: oldKeys }, { firstVersion: '1.1.0', keys: newKeys }]))
    const assets = folder('rotation-release')
    writeFileSync(join(assets, 'EtherPK-linux-x64.deb'), 'a package')
    const args = ['--action', 'promote', '--version', '1.2.0', '--assets', assets, '--start-after', '0', '--keys', current, '--released-keys', released]
    const env = { UPDATE_FEED_KEY: readFileSync(join(newWhere, 'new-a.key'), 'utf8'), GITHUB_REPOSITORY: 'example/app' }

    const refused = run('make-feed.mjs', [...args, '--out', join(scratch, 'rotation-refused.json')], env)
    assert.notEqual(refused.status, 0)
    assert.match(refused.stderr, /old-a, old-b/)
    assert.equal(existsSync(join(scratch, 'rotation-refused.json')), false)

    const both = run('make-feed.mjs', [...args, '--out', join(scratch, 'rotation-both.json')], { ...env, UPDATE_FEED_KEY_NEXT: readFileSync(join(where, 'old-b.key'), 'utf8') })
    assert.equal(both.status, 0, both.stderr)
    const text = readFileSync(join(scratch, 'rotation-both.json'), 'utf8')
    assert.deepEqual(keyProblems(text, [newKeys, oldKeys], Date.now()), [])
    assert.match(keyProblems(text, [[{ id: 'stranger', publicKey: newKeys[0].publicKey.replace(/^./, (c) => (c === 'A' ? 'B' : 'A')) }]], Date.now())[0], /stranger/)
})

test('the keys the apps are built with are listed among the released sets', () => {
    // Released builds carry update-keys.json, so a feed has to satisfy it after it changes too. Add the set
    // to released-update-keys.json, with the first version that carries it, in the change that commits it.
    const current = JSON.parse(readFileSync(join(here, '../../apps/desktop/update-keys.json'), 'utf8'))
    const releasedSets = JSON.parse(readFileSync(join(here, 'released-update-keys.json'), 'utf8'))
    // Each entry is checked as make-feed.mjs reads it, keys or none.
    if (current.length > 0) keySetsToSatisfy(current, releasedSets)
    if (current.length === 0) return
    assert.ok(releasedSets.some(({ keys }) => JSON.stringify(keys) === JSON.stringify(current)),
        'apps/desktop/update-keys.json is not in scripts/native-apps/released-update-keys.json. Add it there, with the first version that carries it.')
})

// --- Looking at the feed that is published -----------------------------------------------------------------

const published = {
    sequence: 7, expires: '2027-06-01T00:00:00.000Z',
    channels: { stable: { android: { version: '1.2.0', url: 'https://downloads.example/a.apk', size: 10 } } },
}
const reached = async () => ({ ok: true, size: 10 })

test('a feed with time left and its files there has no problems', async () => {
    assert.deepEqual(await feedProblems(published, { now: Date.parse('2027-04-01T00:00:00.000Z'), reach: reached }), [])
})

test('a feed is a problem when it ends soon, or a file is gone or another size', async () => {
    assert.match((await feedProblems(published, { now: Date.parse('2027-05-10T00:00:00.000Z'), reach: reached }))[0], /renew/)
    const now = Date.parse('2027-04-01T00:00:00.000Z')
    assert.match((await feedProblems(published, { now, reach: async () => ({ ok: false, size: 0 }) }))[0], /a\.apk/)
    assert.match((await feedProblems(published, { now, reach: async () => ({ ok: true, size: 11 }) }))[0], /11/)
})

// --- The branch the feed is on -----------------------------------------------------------------------------

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

/** A repository to work in, and the remote its feed branch is on. */
function feedRepository(name) {
    const remote = folder(`${name}-remote`)
    const work = folder(`${name}-work`)
    git(remote, 'init', '--bare', '--quiet')
    git(work, 'init', '--quiet')
    const env = {
        ...process.env, FEED_REMOTE: remote, GITHUB_REPOSITORY: 'example/app', ACTION: 'renew', VERSION: '',
        GIT_AUTHOR_NAME: 'x', GIT_AUTHOR_EMAIL: 'x@example.com', GIT_COMMITTER_NAME: 'x', GIT_COMMITTER_EMAIL: 'x@example.com',
    }
    const script = (file, ...args) => spawnSync('bash', [join(here, file), ...args], { cwd: work, env, encoding: 'utf8' })
    const prepare = (into) => script('promote-prepare.sh', join(work, into))
    const publish = (from, text) => {
        writeFileSync(join(work, 'feed.json'), text)
        return script('promote-publish.sh', join(work, from), join(work, 'feed.json'), 'a message')
    }
    return { remote, work, prepare, publish, published: () => git(remote, 'show', 'update-feed:feed.json') }
}

test('the first feed starts the branch, and the next is the commit after it', () => {
    const { remote, work, prepare, publish, published } = feedRepository('branch')
    assert.equal(prepare('one').status, 0)
    assert.equal(existsSync(join(work, 'one/previous.json')), false)
    assert.equal(publish('one', 'first').status, 0)
    assert.equal(prepare('two').status, 0)
    assert.equal(readFileSync(join(work, 'two/previous.json'), 'utf8'), 'first')
    assert.equal(publish('two', 'second').status, 0)
    assert.equal(published(), 'second')
    assert.equal(git(remote, 'rev-list', '--count', 'update-feed'), '2')
})

test('of two changes made from one feed, the second is refused', () => {
    const { prepare, publish, published } = feedRepository('race')
    prepare('start')
    publish('start', 'first')
    prepare('one')
    prepare('two')
    assert.equal(publish('one', 'mine').status, 0)
    const late = publish('two', 'theirs')
    assert.notEqual(late.status, 0)
    assert.equal(published(), 'mine')
})

test('of two first feeds, the second is refused', () => {
    const { prepare, publish, published } = feedRepository('first-race')
    prepare('one')
    prepare('two')
    assert.equal(publish('one', 'mine').status, 0)
    assert.notEqual(publish('two', 'theirs').status, 0)
    assert.equal(published(), 'mine')
})

test('a remote that cannot be asked is not one with no feed', () => {
    const { remote, work, prepare } = feedRepository('unreachable')
    rmSync(remote, { recursive: true })
    assert.notEqual(prepare('one').status, 0)
    assert.equal(existsSync(join(work, 'one/previous.json')), false)
})

// --- The release workflow ----------------------------------------------------------------------------------
// The public workflows run only in the public repository, at a release. These rules read them as text, by
// job, so that a change that breaks one is caught here first.

const WORKFLOWS = join(here, '../../public-repos/client/.github/workflows')

/** The jobs of a workflow: each one's id and the lines under it. */
function jobsOf(file) {
    const lines = readFileSync(join(WORKFLOWS, file), 'utf8').split('\n')
    const start = lines.indexOf('jobs:')
    const jobs = new Map()
    let current = null
    for (const line of lines.slice(start + 1)) {
        const id = /^ {2}([a-z0-9-]+):\s*$/.exec(line)
        if (id) jobs.set((current = id[1]), [])
        else if (current && (line.startsWith('    ') || line.trim() === '' || line.startsWith('  #'))) jobs.get(current).push(line)
        else if (/^\S/.test(line)) current = null
    }
    return new Map([...jobs].map(([id, body]) => [id, body.join('\n')]))
}

/** The `permissions:` block of a job, as `name: level` lines. */
const permissionsOf = (body) => /^ {4}permissions:(?: \{\})?\n((?: {6}.*\n)*)/m.exec(`${body}\n`)?.[1] ?? ''
const runsPackageCode = (body) => /pnpm install|pnpm build|gradlew/.test(body)

test('no job that runs a package\'s code can write to the repository or holds a secret', () => {
    for (const file of ['build.yaml', 'promote.yaml', 'update-feed.yaml']) {
        for (const [id, body] of jobsOf(file)) {
            if (!runsPackageCode(body)) continue
            assert.doesNotMatch(permissionsOf(body), /: write/, `${file} ${id} runs a package's code with a write permission. Move what writes into a job of its own that installs nothing.`)
            assert.doesNotMatch(body, /secrets\./, `${file} ${id} runs a package's code and reads a secret.`)
        }
    }
})

test('the job that publishes the release installs nothing and checks out only the release scripts', () => {
    const jobs = jobsOf('build.yaml')
    const publishing = [...jobs].filter(([, body]) => /gh release (create|edit)|attach\.mjs/.test(body))
    assert.deepEqual(publishing.map(([id]) => id), ['release'])
    const release = jobs.get('release')
    assert.match(permissionsOf(release), /contents: write/)
    assert.doesNotMatch(release, /pnpm|npm install|npm ci/)
    assert.match(release, /sparse-checkout: scripts\/native-apps/)
    assert.match(release, /needs: \[version, bundle, installers\]/)
})

test('every artifact with a fixed name is replaced on a re-run, so "Re-run failed jobs" can finish a release', () => {
    for (const file of ['build.yaml', 'promote.yaml', 'update-feed.yaml']) {
        const text = readFileSync(join(WORKFLOWS, file), 'utf8')
        for (const step of text.split(/\n(?= +- uses: )/).filter((one) => /- uses: actions\/upload-artifact@/.test(one))) {
            const name = /\n +name: (.+)/.exec(step)?.[1]
            assert.ok(name, `${file}: an upload-artifact step has no name`)
            assert.match(step, /\n +overwrite: true/, `${file}: the artifact ${name} has no "overwrite: true", so a re-run cannot upload it again.`)
        }
    }
})

test('only a release is signed with the Android key', () => {
    assert.match(jobsOf('build.yaml').get('sign-android'), /\n {4}if: needs\.version\.outputs\.release == 'true'/)
})

test('the feed is pushed with the key kept in the update-feed environment, not the workflow token', () => {
    const sign = jobsOf('promote.yaml').get('sign')
    assert.match(sign, /environment: update-feed/)
    assert.doesNotMatch(permissionsOf(sign), /contents: write/)
    assert.match(sign, /secrets\.UPDATE_FEED_DEPLOY_KEY/)
    assert.doesNotMatch(sign, /x-access-token/)
})

// --- Which servers a published app uses -----------------------------------------------------------------

const MANAGED = {
    INSTALLED_ACCOUNT_ISSUER: 'https://account.example.test',
    INSTALLED_MANAGED_SYNC_URL: 'https://sync.example.test',
    INSTALLED_WEB_CLIENT_URL: 'https://app.example.test',
}
const NONE = { INSTALLED_ACCOUNT_ISSUER: '', INSTALLED_MANAGED_SYNC_URL: '', INSTALLED_WEB_CLIENT_URL: '', INSTALLED_STANDALONE: '' }
const settings = (env) => run('installed-settings.mjs', [], { ...NONE, ...env })

test('the apps are built with the managed servers, and a build with none of them is refused by name', () => {
    assert.equal(settings(MANAGED).status, 0)
    const none = settings({})
    assert.equal(none.status, 1)
    assert.match(none.stderr, /INSTALLED_ACCOUNT_ISSUER, INSTALLED_MANAGED_SYNC_URL and INSTALLED_WEB_CLIENT_URL/)
    assert.match(none.stderr, /INSTALLED_STANDALONE/)
    const one = settings({ ...MANAGED, INSTALLED_WEB_CLIENT_URL: '' })
    assert.equal(one.status, 1)
    assert.match(one.stderr, /INSTALLED_WEB_CLIENT_URL/)
    assert.doesNotMatch(one.stderr, /INSTALLED_ACCOUNT_ISSUER/)
})

test('a standalone build is chosen with INSTALLED_STANDALONE, and then carries no managed server', () => {
    assert.equal(settings({ INSTALLED_STANDALONE: 'true' }).status, 0)
    const both = settings({ ...MANAGED, INSTALLED_STANDALONE: 'true' })
    assert.equal(both.status, 1)
    assert.match(both.stderr, /INSTALLED_STANDALONE/)
    assert.match(both.stderr, /INSTALLED_ACCOUNT_ISSUER/)
    const odd = settings({ INSTALLED_STANDALONE: 'yes' })
    assert.equal(odd.status, 1)
    assert.match(odd.stderr, /"true"/)
})

test('the Installed Build is checked for its servers before it is built', () => {
    const job = jobsOf('build.yaml').get('installed-build')
    assert.match(job, /INSTALLED_STANDALONE: \$\{\{ vars\.INSTALLED_STANDALONE \}\}/)
    const check = job.indexOf('node scripts/native-apps/installed-settings.mjs')
    assert.ok(check > 0, 'the installed-build job does not run installed-settings.mjs')
    assert.ok(check < job.indexOf('pnpm build:installed'), 'installed-settings.mjs runs after the build it checks')
})
