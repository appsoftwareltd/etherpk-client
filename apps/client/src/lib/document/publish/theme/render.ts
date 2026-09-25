/**
 * Rendering a page through a [[Theme]]: Mustache over the view, with the theme's partials and
 * the publication's [[Include]]s. An include is a partial by name that wins over the theme's
 * own, which is the whole override mechanism; a theme's `{{> footer}}` therefore never has to
 * know whether a page in the graph filled it.
 */

import Mustache from 'mustache'

import type { ThemeFiles } from './manifest'

export interface ThemeRenderer {
    /** Render `layout` (a layouts/ name) over `view`; includes override partials by name. */
    render(layout: 'page' | 'home' | 'journal' | 'archive' | '404', view: object): string
    /** Render one partial by name (the theme's, or an include) over a view; empty when absent. */
    renderPartial(name: string, view: object): string
}

/** Mustache's default escaping, exposed for callers that build fragments outside a template. */
export function escapeHtml(text: string): string {
    return Mustache.escape(text)
}

export function createThemeRenderer(theme: ThemeFiles, includes: ReadonlyMap<string, string>): ThemeRenderer {
    const partial = (name: string): string | undefined => {
        const override = includes.get(name)
        if (override !== undefined) return override
        return theme.files.get(`partials/${name}.html`)
    }
    const partials = (name: string): string => partial(name) ?? ''

    function layoutTemplate(layout: string): string {
        return theme.files.get(`layouts/${layout}.html`) ?? theme.files.get('layouts/page.html') ?? ''
    }

    return {
        render(layout, view) {
            return Mustache.render(layoutTemplate(layout), view, partials)
        },
        renderPartial(name, view) {
            const template = partial(name)
            return template === undefined ? '' : Mustache.render(template, view, partials)
        },
    }
}
