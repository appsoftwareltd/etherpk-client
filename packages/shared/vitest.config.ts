import { defineConfig } from 'vitest/config'

// The shared package had no Vitest configuration of its own, so it inherited the defaults and
// could not report coverage. It carries the security headers, CSP, redaction and sync-protocol
// contracts that all three apps depend on, which makes it the last package that should be
// invisible in a coverage report.
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
            // .svelte components are excluded by the *.ts glob: these tests run in node and
            // never mount one.
            include: ['src/**/*.ts'],
            exclude: [
                'src/**/*.test.ts',
                'src/**/*.d.ts',
                'src/**/*.svelte.ts'
            ]
        }
    }
})
