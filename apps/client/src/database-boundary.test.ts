import { readFile, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const appRoot = fileURLToPath(new URL('../', import.meta.url))

describe('client database boundary', () => {
    it('has no PostgreSQL dependencies or migration commands', async () => {
        const packageJson = JSON.parse(
            await readFile(new URL('../package.json', import.meta.url), 'utf8'),
        ) as {
            scripts?: Record<string, string>
            dependencies?: Record<string, string>
            devDependencies?: Record<string, string>
        }

        expect(Object.keys(packageJson.scripts ?? {})).not.toContain('db:migrate')
        expect(packageJson.dependencies).not.toHaveProperty('postgres')
        expect(packageJson.dependencies).not.toHaveProperty('drizzle-orm')
        expect(packageJson.devDependencies).not.toHaveProperty('drizzle-kit')
    })

    it('does not package or start a migration runner', async () => {
        const dockerfile = await readFile(new URL('../Dockerfile', import.meta.url), 'utf8')

        expect(dockerfile).not.toMatch(
            /migrate\.js|db-migrations|DATABASE_(?:APPLICATION|MIGRATION)_URL|DATABASE_URL/,
        )
        await expect(stat(`${appRoot}src/migrate.ts`)).rejects.toMatchObject({ code: 'ENOENT' })
        await expect(stat(`${appRoot}db-migrations`)).rejects.toMatchObject({ code: 'ENOENT' })
    })
})
