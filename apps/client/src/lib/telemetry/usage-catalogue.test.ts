import { describe, expect, it } from 'vitest'

import { USAGE_CATALOGUE, assetType, checkUsageEvent, durationBucket, errorKind, openTimeBucket, pageCountBucket } from './usage-catalogue'

describe('checkUsageEvent', () => {
    it('accepts each declared event with declared values', () => {
        expect(checkUsageEvent({ name: 'app_opened', data: { version: '1.2.3', install: 'browser', deployment: 'self-hosted', layout: 'phone', theme: 'dark' } })).toBe(true)
        expect(checkUsageEvent({ name: 'graph_opened', data: { kind: 'folder', pages: '11-100', openTime: '<1s' } })).toBe(true)
        expect(checkUsageEvent({ name: 'command.tasks.open' })).toBe(true)
        expect(checkUsageEvent({ name: 'view.kanban.board' })).toBe(true)
        expect(checkUsageEvent({ name: 'view.asset', data: { type: 'pdf' } })).toBe(true)
        expect(checkUsageEvent({ name: 'settings.privacy' })).toBe(true)
        expect(checkUsageEvent({ name: 'app_hidden', data: { visible: '5-15m' } })).toBe(true)
        expect(checkUsageEvent({ name: 'error', data: { version: '1.2.3', kind: 'TypeError' } })).toBe(true)
    })

    it('refuses a name the catalogue does not declare', () => {
        expect(checkUsageEvent({ name: 'page_opened' })).toBe(false)
        expect(checkUsageEvent({ name: 'command.' })).toBe(false)
        expect(checkUsageEvent({ name: 'command.template.insert.Meeting Notes' })).toBe(false)
        expect(checkUsageEvent({ name: 'view.document:Garden' })).toBe(false)
        expect(checkUsageEvent({ name: `command.${'a'.repeat(60)}` })).toBe(false)
    })

    it('refuses a property or a value the catalogue does not declare', () => {
        expect(checkUsageEvent({ name: 'command.tasks.open', data: { page: 'Garden' } })).toBe(false)
        expect(checkUsageEvent({ name: 'graph_opened', data: { kind: 'Garden' } })).toBe(false)
        expect(checkUsageEvent({ name: 'app_opened', data: { version: 'Garden' } })).toBe(false)
        expect(checkUsageEvent({ name: 'error', data: { kind: 'Cannot read Garden' } })).toBe(false)
    })

    it('describes every entry for the Privacy tab', () => {
        for (const entry of USAGE_CATALOGUE) {
            expect(entry.when).not.toBe('')
            for (const property of Object.values(entry.properties)) expect(property.meaning).not.toBe('')
        }
    })
})

describe('buckets', () => {
    it('puts a value in the bucket whose bounds hold it', () => {
        expect(durationBucket(10_000)).toBe('<1m')
        expect(durationBucket(60_000)).toBe('1-5m')
        expect(durationBucket(4 * 3_600_000)).toBe('60m+')
        expect(openTimeBucket(2_500)).toBe('1-3s')
        expect(pageCountBucket(0)).toBe('0')
        expect(pageCountBucket(10)).toBe('1-10')
        expect(pageCountBucket(5_000)).toBe('1000+')
    })
})

describe('assetType', () => {
    it('names a file type from a fixed list', () => {
        expect(assetType('PDF')).toBe('pdf')
        expect(assetType('epub')).toBe('epub')
        expect(assetType('jpeg')).toBe('image')
        expect(assetType('excalidraw')).toBe('drawing')
        expect(assetType('docx')).toBe('other')
        expect(assetType('')).toBe('other')
    })
})

describe('errorKind', () => {
    it("gives an error's class, never its message", () => {
        expect(errorKind(new TypeError('Garden is undefined'))).toBe('TypeError')
        expect(errorKind(new DOMException('gone', 'AbortError'))).toBe('AbortError')
        expect(errorKind('Garden')).toBe('Unknown')
        const custom = new Error('x')
        custom.name = 'Garden notes'
        expect(errorKind(custom)).toBe('Unknown')
    })
})
