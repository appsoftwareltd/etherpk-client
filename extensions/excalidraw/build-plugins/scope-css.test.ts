import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, sep } from 'node:path'

import postcss, { type Rule } from 'postcss'
import { describe, expect, it } from 'vitest'

import { ownedSelector, scopeExcalidrawCss, scopeSelector } from './scope-css'

describe('scopeSelector', () => {
    it('leaves a rule that already styles an excalidraw element', () => {
        expect(scopeSelector('.excalidraw .App-menu')).toEqual(['.excalidraw .App-menu'])
        expect(scopeSelector('body.excalidraw-cursor-resize *')).toEqual(['body.excalidraw-cursor-resize *'])
    })

    it('puts .excalidraw before any other element', () => {
        expect(scopeSelector('.zoom-actions')).toEqual(['.excalidraw .zoom-actions'])
        expect(scopeSelector(':root[dir=rtl] .zoom-out-button')).toEqual([':root[dir=rtl] .excalidraw .zoom-out-button'])
    })

    it("turns :root into the elements Excalidraw draws into", () => {
        expect(scopeSelector(':root')).toEqual(['.excalidraw', '.excalidraw-tooltip'])
    })
})

describe("Excalidraw's stylesheet, scoped", () => {
    // The stylesheet the Client's build loads with Excalidraw, from both of its builds.
    const entry = createRequire(import.meta.url).resolve('@excalidraw/excalidraw')
    const dist = join(entry.slice(0, entry.lastIndexOf(`${sep}dist${sep}`)), 'dist')

    for (const build of ['prod', 'dev']) {
        it(`styles nothing outside Excalidraw's own elements (${build})`, async () => {
            const css = readFileSync(join(dist, build, 'index.css'), 'utf8')
            const scoped = await postcss([scopeExcalidrawCss()]).process(css, { from: undefined })
            const unowned: string[] = []
            let rules = 0
            scoped.root.walkRules((rule: Rule) => {
                if (rule.parent?.type === 'atrule' && /keyframes$/i.test((rule.parent as { name: string }).name)) return
                if (rule.parent?.type === 'rule') return
                rules++
                for (const selector of rule.selectors) if (!ownedSelector(selector) && !/^\.excalidraw(-tooltip)?$/.test(selector)) unowned.push(selector)
            })
            expect(rules).toBeGreaterThan(100)
            expect(unowned).toEqual([])
        })
    }
})
