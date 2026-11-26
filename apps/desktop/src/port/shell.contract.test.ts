import { mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { type ContractHarness, nativePortContract } from '@appsoftwareltd/etherpk-native-bridge/contract'
import { createNodePort } from '../testing/node-port.ts'

async function harness(): Promise<ContractHarness> {
    const native = await createNodePort()
    const at = (path: string) => join(native.disk, path)
    return {
        port: native.port,
        disk: {
            async write(path, text) {
                await mkdir(dirname(at(path)), { recursive: true })
                await writeFile(at(path), text)
            },
            read: (path) => readFile(at(path), 'utf8').catch(() => null),
            makeDirectory: async (path) => { await mkdir(at(path), { recursive: true }) },
            remove: (path) => rm(at(path), { recursive: true, force: true }),
            names: async (path) => (await readdir(at(path))).sort(),
            link: (path, target) => symlink(at(target), at(path)),
        },
        answerFolder: (path) => { native.folderAnswers.push(path === null ? null : at(path)) },
        answerSave: (path) => { native.saveAnswers.push(path === null ? null : at(path)) },
        openFile: (path) => native.shell.openedFiles.add(at(path)),
        ignoresCase: process.platform !== 'linux',
        keepsNameForm: process.platform !== 'darwin',
        dispose: native.dispose,
    }
}

describe('the desktop shell on a real disk', () => nativePortContract({ describe, expect, it }, harness))
