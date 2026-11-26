import { defineConfig } from 'vitest/config'

export default defineConfig({
    test: {
        environment: 'node',
        include: ['src/**/*.test.ts'],
        includeTaskLocation: true,
        testTimeout: 20_000,
    },
})
