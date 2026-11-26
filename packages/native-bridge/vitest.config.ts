import { defineConfig } from 'vitest/config'

export default defineConfig({
    test: {
        environment: 'node',
        include: ['src/**/*.test.ts'],
        // Records each test's declaration line for the generated report.
        includeTaskLocation: true,
        coverage: {
            provider: 'v8',
            reportsDirectory: 'coverage',
            reporter: ['text-summary', 'html', 'json-summary'],
            include: ['src/**/*.ts'],
            exclude: ['src/**/*.test.ts'],
        },
    },
})
