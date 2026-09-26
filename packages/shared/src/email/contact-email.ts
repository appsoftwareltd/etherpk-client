/**
 * The mail a contact form submission becomes, built once for Corporate and the Sync Server.
 *
 * The form is anonymous and the mail is sent from the service's own address, so it passes SPF
 * and DKIM as the service. Everything the visitor typed is therefore escaped before it goes into
 * the HTML part: unescaped, a visitor could send the operator links, disguised link text or
 * tracking images that look like the service's own mail.
 */

export interface ContactSubmission {
    name: string
    email: string
    message: string
}

export interface ContactEmail {
    subject: string
    text: string
    html: string
}

const HTML_ESCAPES: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
}

/** Escape a string for HTML text content and for a quoted attribute value. */
export function escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, (character) => HTML_ESCAPES[character])
}

/**
 * Collapse line breaks and other control characters to single spaces. A header value with a
 * CR or LF in it could start a new header if any transport ever wrote it verbatim.
 */
function singleLine(value: string): string {
    // eslint-disable-next-line no-control-regex -- matching control characters is the point
    return value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim()
}

export function buildContactEmail({ name, email, message }: ContactSubmission): ContactEmail {
    const displayName = singleLine(name)
    return {
        subject: `Contact form: ${displayName}`,
        text: [
            `Name: ${displayName}`,
            `Email: ${singleLine(email)}`,
            '',
            'Message:',
            message,
        ].join('\n'),
        html: [
            `<p><strong>Name:</strong> ${escapeHtml(displayName)}</p>`,
            `<p><strong>Email:</strong> <a href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a></p>`,
            '<hr />',
            // Escape first, then add the line breaks, so a visitor's own <br> stays text.
            `<p>${escapeHtml(message).replace(/\r?\n/g, '<br />')}</p>`,
        ].join('\n'),
    }
}
