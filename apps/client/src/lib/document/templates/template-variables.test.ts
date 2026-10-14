import { describe, expect, it } from 'vitest'

import { renderTemplate, templateContextFor, templateVariableSpans, type TemplateContext } from './template-variables'

// 14:05:09 local time on Wednesday 14 October 2026. Local, because every variable is local time.
const now = new Date(2026, 9, 14, 14, 5, 9)
const context: TemplateContext = { day: '2026-10-14', now, title: 'Garden' }

const render = (body: string, ctx: TemplateContext = context) => renderTemplate(body, ctx)

describe('renderTemplate: the named variables', () => {
    it.each([
        ['{{date}}', '2026-10-14'],
        ['{{yesterday}}', '2026-10-13'],
        ['{{tomorrow}}', '2026-10-15'],
        ['{{time}}', '14:05'],
        ['{{datetime}}', '2026-10-14 14:05'],
        ['{{title}}', 'Garden'],
    ])('%s gives %s', (body, expected) => {
        expect(render(body)).toEqual({ text: expected, cursor: null })
    })

    it('matches a name without regard to case or the spaces inside the braces', () => {
        expect(render('{{ Date }} and {{TITLE}}').text).toBe('2026-10-14 and Garden')
    })

    it('gives plain text, so a link is written around the variable', () => {
        expect(render('- [[{{date}}]] review of [[{{title}}]]').text).toBe('- [[2026-10-14]] review of [[Garden]]')
    })

    it('reads the date from the context day, not from the clock', () => {
        const monday: TemplateContext = { day: '2026-10-19', now, title: '2026-10-19' }
        expect(render('{{date}} {{yesterday}} {{tomorrow}} {{time}}', monday).text).toBe('2026-10-19 2026-10-18 2026-10-20 14:05')
    })

    it('steps across the ends of months and years', () => {
        expect(render('{{yesterday}}', { ...context, day: '2026-03-01' }).text).toBe('2026-02-28')
        expect(render('{{tomorrow}}', { ...context, day: '2026-12-31' }).text).toBe('2027-01-01')
        expect(render('{{yesterday}}', { ...context, day: '2028-03-01' }).text).toBe('2028-02-29')
    })

    it('steps by calendar day across a daylight saving change', () => {
        // 29 March 2026 is 23 hours long in Europe; adding 24 hours of milliseconds would skip it
        // on a machine in that zone. Calendar arithmetic does not depend on the zone at all.
        expect(render('{{tomorrow}}', { ...context, day: '2026-03-28' }).text).toBe('2026-03-29')
        expect(render('{{tomorrow}}', { ...context, day: '2026-03-29' }).text).toBe('2026-03-30')
    })
})

describe('renderTemplate: custom formats', () => {
    it.each([
        ['{{date:DD/MM/YYYY}}', '14/10/2026'],
        ['{{date:DD/MM/YY}}', '14/10/26'],
        ['{{date:YYYY.MM}}', '2026.10'],
        ['{{time:HH:mm:ss}}', '14:05:09'],
        ['{{time:HH.mm}}', '14.05'],
        ['{{date:YYYY-MM-DD HH:mm}}', '2026-10-14 14:05'],
    ])('%s gives %s', (body, expected) => {
        expect(render(body).text).toBe(expected)
    })

    it('reads YYYY before YY, so a four-digit year is never two short years', () => {
        expect(render('{{date:YYYY}}').text).toBe('2026')
    })

    it('tells month (MM) from minutes (mm)', () => {
        expect(render('{{date:MM}} {{time:mm}}').text).toBe('10 05')
    })

    it('copies every character that is not a token', () => {
        expect(render('{{date:DD of MM, YYYY}}').text).toBe('14 of 10, 2026')
    })

    it('zero-pads every field', () => {
        const early: TemplateContext = { day: '2026-01-02', now: new Date(2026, 0, 2, 3, 4, 5), title: 'x' }
        expect(render('{{date:DD/MM}} {{time:HH:mm:ss}}', early).text).toBe('02/01 03:04:05')
    })

    it('takes the date fields of a format from the context day and the time fields from the clock', () => {
        const monday: TemplateContext = { day: '2026-10-19', now, title: 'x' }
        expect(render('{{date:YYYY-MM-DD HH:mm}}', monday).text).toBe('2026-10-19 14:05')
    })

    it('copies a format prefix with nothing after it as written', () => {
        expect(render('{{date:}}').text).toBe('{{date:}}')
    })
})

describe('renderTemplate: the cursor', () => {
    it('removes {{cursor}} and reports where it was', () => {
        expect(render('- Notes: {{cursor}}\n- Tasks')).toEqual({ text: '- Notes: \n- Tasks', cursor: 9 })
    })

    it('reports the offset in the rendered text, after the variables before it grew or shrank', () => {
        expect(render('{{date}} {{cursor}}')).toEqual({ text: '2026-10-14 ', cursor: 11 })
    })

    it('keeps only the first cursor and removes the rest', () => {
        expect(render('a{{cursor}}b{{cursor}}c')).toEqual({ text: 'abc', cursor: 1 })
    })
})

describe('renderTemplate: what is copied as written', () => {
    it('copies an unknown name as written', () => {
        expect(render('Hello {{name}}, {{date}}').text).toBe('Hello {{name}}, 2026-10-14')
    })

    it('copies braces with nothing between them as written', () => {
        expect(render('{{}} and {{ }}').text).toBe('{{}} and {{ }}')
    })

    it('writes a literal {{ for a backslash before the braces', () => {
        expect(render('\\{{date}} is {{date}}').text).toBe('{{date}} is 2026-10-14')
    })

    it('replaces variables inside code too', () => {
        expect(render('```\nlog {{date}}\n```\n`{{time}}`').text).toBe('```\nlog 2026-10-14\n```\n`14:05`')
    })

    it('never reads its own output again', () => {
        expect(render('{{title}}', { ...context, title: '{{date}}' }).text).toBe('{{date}}')
    })

    it('returns text with no variables unchanged', () => {
        expect(render('- water the beans\n  - [ ] buy seeds')).toEqual({ text: '- water the beans\n  - [ ] buy seeds', cursor: null })
    })
})

describe('templateVariableSpans', () => {
    it('finds each variable with whether the renderer knows it', () => {
        expect(templateVariableSpans('{{date}} {{nmae}} {{time:HH}}')).toEqual([
            { from: 0, to: 8, known: true },
            { from: 9, to: 17, known: false },
            { from: 18, to: 29, known: true },
        ])
    })

    it('leaves out an escaped variable', () => {
        expect(templateVariableSpans('\\{{date}}')).toEqual([])
    })
})

describe('templateContextFor', () => {
    it('uses a journal entry’s own day', () => {
        expect(templateContextFor('2026-10-19', now)).toEqual({ day: '2026-10-19', now, title: '2026-10-19' })
    })

    it('uses today for a page', () => {
        expect(templateContextFor('Garden', now)).toEqual({ day: '2026-10-14', now, title: 'Garden' })
    })

    it('uses today for a date-shaped name that is not a day', () => {
        expect(templateContextFor('2026-02-30', now).day).toBe('2026-10-14')
    })
})
