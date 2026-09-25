import { describe, expect, it } from 'vitest'

import { parseThemeManifest } from './manifest'
import { createThemeRenderer } from './render'

const manifest = parseThemeManifest(JSON.stringify({ name: 't', contract: 1 })).manifest!
const files = new Map([
    ['layouts/page.html', '<title>{{page.title}}</title>{{> header}}<main>{{{page.content}}}</main>{{> footer}}'],
    ['layouts/home.html', '<h1>{{site.title}}</h1>{{#site.nav}}<a href="{{href}}">{{label}}</a>{{/site.nav}}'],
    ['partials/header.html', '<header>{{site.title}}</header>'],
    ['partials/footer.html', '<footer>theme footer {{site.year}}</footer>'],
])

describe('createThemeRenderer', () => {
    it('renders a layout with the theme partials, escaping values and passing HTML through triple stashes', () => {
        const r = createThemeRenderer({ manifest, files }, new Map())
        const html = r.render('page', { site: { title: 'A & B', year: 2026 }, page: { title: '<t>', content: '<p>x</p>' } })
        expect(html).toBe('<title>&lt;t&gt;</title><header>A &amp; B</header><main><p>x</p></main><footer>theme footer 2026</footer>')
    })

    it('an include replaces the partial of the same name and sees the same view', () => {
        const r = createThemeRenderer({ manifest, files }, new Map([['footer', '<footer>© {{site.year}} mine</footer>']]))
        expect(r.render('page', { site: { title: 'S', year: 2026 }, page: { title: 'p', content: '' } })).toContain('<footer>© 2026 mine</footer>')
        expect(r.render('page', { site: { title: 'S', year: 2026 }, page: { title: 'p', content: '' } })).not.toContain('theme footer')
    })

    it('falls back to the page layout for a missing one, and renders sections over arrays', () => {
        const r = createThemeRenderer({ manifest, files }, new Map())
        expect(r.render('home', { site: { title: 'S', nav: [{ href: 'a.html', label: 'A' }] } })).toBe('<h1>S</h1><a href="a.html">A</a>')
        expect(r.render('archive', { site: { title: 'S', year: 1 }, page: { title: 'x', content: '' } })).toContain('<main></main>')
    })

    it('renders a partial on its own and an unknown partial as nothing', () => {
        const r = createThemeRenderer({ manifest, files }, new Map())
        expect(r.renderPartial('header', { site: { title: 'H' } })).toBe('<header>H</header>')
        expect(r.renderPartial('nope', {})).toBe('')
    })
})
