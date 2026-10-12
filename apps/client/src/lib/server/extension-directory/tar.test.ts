import { describe, expect, it } from 'vitest'

import { readPackageTarball } from './tar'
import { paxEntry as pax, tarEntry as entry, tarball } from './testing'

const limits = { unpackedBytes: 1_000_000, files: 100 }
const text = (data: Uint8Array) => new TextDecoder().decode(data)

describe("reading an npm package's tarball", () => {
    it("gives each file under the package's folder, the folder removed, its bytes kept", () => {
        const files = readPackageTarball(tarball(entry('package/package.json', '{"name":"garden"}'), entry('package/dist/', '', '5'), entry('package/dist/main.js', 'export {}')), limits)
        expect(files.map((file) => [file.path, text(file.data)])).toEqual([
            ['package.json', '{"name":"garden"}'],
            ['dist/main.js', 'export {}'],
        ])
    })

    it('reads a long path written as a POSIX extended header', () => {
        const long = `package/dist/${'chunks/'.repeat(20)}beans.js`
        const files = readPackageTarball(tarball(pax(long), entry('package/short-name', 'x')), limits)
        expect(files[0].path).toBe(long.slice('package/'.length))
    })

    it.each([
        ['a symbolic link', tarball(entry('package/link', '', '2'))],
        ['a hard link', tarball(entry('package/link', '', '1'))],
        ['a path that climbs out', tarball(entry('package/../outside.js', 'x'))],
        ['an absolute path', tarball(entry('/etc/garden', 'x'))],
        ['a file outside the folder', tarball(entry('package/a.js', 'x'), entry('other/b.js', 'x'))],
        ['a file beside the folder', tarball(entry('loose.js', 'x'))],
        ['a body that is not gzipped', new Uint8Array([1, 2, 3])],
    ])('refuses %s', (_case, body) => {
        expect(() => readPackageTarball(body, limits)).toThrow()
    })

    it('refuses a size that is not a number of bytes', () => {
        for (const size of ['-0000000001', '00000000x10']) {
            const [head, data] = entry('package/a.js', 'x')
            head.set(new TextEncoder().encode(`${size}\0`), 124)
            expect(() => readPackageTarball(tarball([head, data]), limits), size).toThrow(/size/)
        }
    })

    it('refuses a package larger unpacked, or with more files, than the limits', () => {
        const big = tarball(entry('package/big.bin', new Uint8Array(2000)))
        expect(() => readPackageTarball(big, { unpackedBytes: 1000, files: 10 })).toThrow(/larger unpacked/)
        const many = tarball(...Array.from({ length: 4 }, (_, i) => entry(`package/${i}.js`, 'x')))
        expect(() => readPackageTarball(many, { unpackedBytes: 1000, files: 3 })).toThrow(/more than 3 files/)
    })
})
