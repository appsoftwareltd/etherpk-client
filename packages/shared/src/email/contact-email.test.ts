import { describe, expect, it } from 'vitest'
import { buildContactEmail, escapeHtml } from './contact-email'

describe('escapeHtml', () => {
    it('escapes the five characters that change meaning in HTML text and attributes', () => {
        expect(escapeHtml(`<a href="x" title='y'>&</a>`))
            .toBe('&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;')
    })

    it('leaves ordinary text alone', () => {
        expect(escapeHtml('Sidney Jones, café 42')).toBe('Sidney Jones, café 42')
    })
})

// The contact form is anonymous, and its mail goes out from the service's own sender, so
// anything a visitor types must reach the operator's inbox as text.
describe('buildContactEmail', () => {
    const submission = {
        name: 'Sidney Jones',
        email: 'sidney@example.com',
        message: 'Hello,\nI have a question.',
    }

    it('renders a message containing markup as text, not as a link', () => {
        const email = buildContactEmail({
            ...submission,
            message: 'Click <a href="https://evil.example">x</a> <img src="https://evil.example/p.gif">',
        })
        expect(email.html).not.toContain('<a href="https://evil.example"')
        expect(email.html).not.toContain('<img')
        expect(email.html).toContain('&lt;a href=&quot;https://evil.example&quot;&gt;x&lt;/a&gt;')
    })

    it('cannot break out of the reply link through a quote in the email address', () => {
        const email = buildContactEmail({ ...submission, email: 'a"onmouseover="x@example.com' })
        expect(email.html).not.toContain('"onmouseover="')
        expect(email.html).toContain('mailto:a&quot;onmouseover=&quot;x@example.com')
    })

    it('escapes markup in the name', () => {
        const email = buildContactEmail({ ...submission, name: '<b>Admin</b>' })
        expect(email.html).toContain('&lt;b&gt;Admin&lt;/b&gt;')
        expect(email.html).not.toContain('<b>Admin</b>')
    })

    it('keeps line breaks in the message, after escaping it', () => {
        const email = buildContactEmail({ ...submission, message: 'one <br> two\nthree' })
        expect(email.html).toContain('one &lt;br&gt; two<br />three')
    })

    it('keeps the name on one line in the subject', () => {
        const email = buildContactEmail({ ...submission, name: 'Sidney\r\nBcc: someone@example.com' })
        expect(email.subject).toBe('Contact form: Sidney Bcc: someone@example.com')
        expect(email.subject).not.toMatch(/[\r\n]/)
    })

    it('sends a plain text part carrying the same fields', () => {
        const email = buildContactEmail(submission)
        expect(email.text).toBe([
            'Name: Sidney Jones',
            'Email: sidney@example.com',
            '',
            'Message:',
            'Hello,',
            'I have a question.',
        ].join('\n'))
    })
})
