import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const here = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
    resolve: {
        alias: {
            $lib: resolve(here, '../client/src/lib'),
        },
    },
    test: {
        environment: 'node',
        include: ['src/**/*.test.ts'],
        includeTaskLocation: true,
        testTimeout: 20_000,
    },
})
