import { describe, expect, it } from 'vitest'
import { devServerHttps } from './dev-server-https'

/** A file reader over an in-memory folder, recording which paths were read. */
function fakeFiles(files: Record<string, string>) {
    const read: string[] = []
    const readFile = (path: string) => {
        read.push(path)
        if (!(path in files)) throw new Error(`ENOENT: no such file or directory, open '${path}'`)
        return Buffer.from(files[path])
    }
    return { read, readFile }
}

describe('devServerHttps', () => {
    it('changes nothing when no setting is given', () => {
        const { read, readFile } = fakeFiles({})
        expect(devServerHttps({}, readFile)).toEqual({})
        expect(read).toEqual([])
    })

    it('treats a blank setting as unset', () => {
        const { readFile } = fakeFiles({})
        expect(devServerHttps({ DEV_SERVER_HTTPS_CERT: ' ', DEV_SERVER_HTTPS_KEY: '', DEV_SERVER_ALLOWED_HOSTS: '' }, readFile)).toEqual({})
    })

    it('serves HTTPS with the certificate and key read from the named files', () => {
        const { readFile } = fakeFiles({ '/certs/dev.crt': 'CERT', '/certs/dev.key': 'KEY' })
        const options = devServerHttps({ DEV_SERVER_HTTPS_CERT: '/certs/dev.crt', DEV_SERVER_HTTPS_KEY: '/certs/dev.key' }, readFile)
        expect(options.https?.cert.toString()).toBe('CERT')
        expect(options.https?.key.toString()).toBe('KEY')
        expect(options.allowedHosts).toBeUndefined()
    })

    it('refuses a certificate without its key, and a key without its certificate', () => {
        const { readFile } = fakeFiles({ '/certs/dev.crt': 'CERT', '/certs/dev.key': 'KEY' })
        expect(() => devServerHttps({ DEV_SERVER_HTTPS_CERT: '/certs/dev.crt' }, readFile)).toThrow(/DEV_SERVER_HTTPS_KEY/)
        expect(() => devServerHttps({ DEV_SERVER_HTTPS_KEY: '/certs/dev.key' }, readFile)).toThrow(/DEV_SERVER_HTTPS_CERT/)
    })

    it('fails at startup, naming the setting, when a file cannot be read', () => {
        const { readFile } = fakeFiles({ '/certs/dev.key': 'KEY' })
        expect(() => devServerHttps({ DEV_SERVER_HTTPS_CERT: '/certs/missing.crt', DEV_SERVER_HTTPS_KEY: '/certs/dev.key' }, readFile)).toThrow(
            /DEV_SERVER_HTTPS_CERT.*\/certs\/missing\.crt/,
        )
    })

    it('allows the listed host names, trimmed, with empty entries dropped', () => {
        const { readFile } = fakeFiles({})
        expect(devServerHttps({ DEV_SERVER_ALLOWED_HOSTS: ' laptop.example.com, ,.example.net ' }, readFile)).toEqual({
            allowedHosts: ['laptop.example.com', '.example.net'],
        })
    })
})
