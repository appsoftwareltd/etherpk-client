/** What a person has been told, or asked, and is not told again. */
import { mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { replaceFile } from '../fs/atomic-write.ts'

export class Told {
    private constructor(private readonly file: string, private readonly what: Set<string>) {}

    static async open(file: string): Promise<Told> {
        try {
            const kept = JSON.parse(await readFile(file, 'utf8')) as unknown
            return new Told(file, new Set(Array.isArray(kept) ? kept.filter((one) => typeof one === 'string') : []))
        } catch {
            return new Told(file, new Set())
        }
    }

    /** True the first time. Kept before it is answered, so a run that ends in the middle does not ask again. */
    async once(what: string): Promise<boolean> {
        if (this.what.has(what)) return false
        this.what.add(what)
        await mkdir(dirname(this.file), { recursive: true })
        await replaceFile(this.file, Buffer.from(JSON.stringify([...this.what])))
        return true
    }
}
