/**
 * The account emails Corporate and the Sync Server send: verifying an address, confirming a
 * change of address, and resetting a password. Each has an HTML part and a plain-text part, says
 * what it is for, how long its link lasts and what to do if the person did not ask for it. A
 * one-line "Click here" message reads as phishing and fares worse with spam filters.
 *
 * Every link lasts an hour: Better Auth's default for verification, change and reset tokens,
 * which neither app changes.
 */

import type { VerificationReason } from '../auth/verification-resend'
import { escapeHtml } from './contact-email'

export interface AccountEmail {
    subject: string
    html: string
    text: string
}


export function verifyAddressEmail({ url, email, reason }: { url: string; email: string; reason: VerificationReason }): AccountEmail {
    if (reason === 'new-address') {
        return accountEmail({
            subject: 'Confirm your new EtherPK email address',
            heading: 'Confirm your new email address',
            paragraphs: [
                `Your EtherPK account is changing its email address to ${email}. Open the link to confirm it. The account keeps its old address until you do.`,
            ],
            action: { label: 'Confirm new address', url },
            footer: [
                'This link works for one hour.',
                'If you did not ask for this, ignore this email and nothing changes.',
            ],
        })
    }
    return accountEmail({
        subject: 'Verify your EtherPK email address',
        heading: 'Verify your email address',
        paragraphs: [
            reason === 'new-account'
                ? `You created an EtherPK account with ${email}. Verify the address to finish setting it up: until you do, nobody can share a graph with you.`
                : `Here is the new link you asked for to verify ${email} for your EtherPK account.`,
        ],
        action: { label: 'Verify email address', url },
        footer: [
            'This link works for one hour. If it has expired, sign in and send a new one from your Account page.',
            reason === 'new-account'
                ? 'If you did not create an EtherPK account, ignore this email and the address stays unverified.'
                : 'If you did not ask for this, ignore this email.',
        ],
    })
}

export function confirmAddressChangeEmail({ url, newEmail }: { url: string; newEmail: string }): AccountEmail {
    return accountEmail({
        subject: 'Confirm changing your EtherPK email address',
        heading: 'Confirm changing your email address',
        paragraphs: [
            `Someone signed in to your EtherPK account asked to change its email address to ${newEmail}.`,
            'Confirm the change and a verification link goes to the new address. The address changes when that link is opened.',
        ],
        action: { label: 'Confirm the change', url },
        footer: [
            'This link works for one hour.',
            'If you did not ask for this, ignore this email and change your password, because someone else is signed in to your account.',
        ],
    })
}

export function passwordResetEmail({ url }: { url: string }): AccountEmail {
    return accountEmail({
        subject: 'Reset your EtherPK password',
        heading: 'Reset your password',
        paragraphs: [
            'Someone asked to reset the password of the EtherPK account that uses this address.',
            'Choosing a new password signs the account out on every device and revokes its access tokens.',
        ],
        action: { label: 'Choose a new password', url },
        footer: [
            'This link works once, for one hour.',
            'If you did not ask for this, ignore this email and your password stays the same.',
        ],
    })
}

interface EmailContent {
    subject: string
    heading: string
    paragraphs: string[]
    action: { label: string; url: string }
    footer: string[]
}

function accountEmail(content: EmailContent): AccountEmail {
    return { subject: content.subject, html: html(content), text: text(content) }
}

function text({ heading, paragraphs, action, footer }: EmailContent): string {
    return [heading, '', ...paragraphs.flatMap((line) => [line, '']), `${action.label}: ${action.url}`, '', ...footer.flatMap((line) => [line, '']), 'EtherPK']
        .join('\n')
        .trimEnd() + '\n'
}

/** Inline styles and a table layout: email clients strip stylesheets and ignore most modern CSS. */
function html({ subject, heading, paragraphs, action, footer }: EmailContent): string {
    const url = escapeHtml(action.url)
    const paragraph = (line: string, colour = '#111827') =>
        `<p style="margin:0 0 16px;font-size:15px;line-height:1.5;color:${colour}">${escapeHtml(line)}</p>`
    return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:24px;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border:1px solid #e5e7eb;border-radius:8px"><tr><td style="padding:32px">
<p style="margin:0 0 24px;font-size:15px;font-weight:600;color:#111827">EtherPK</p>
<h1 style="margin:0 0 16px;font-size:20px;line-height:1.3;color:#111827">${escapeHtml(heading)}</h1>
${paragraphs.map((line) => paragraph(line)).join('\n')}
<p style="margin:24px 0"><a href="${url}" style="display:inline-block;background:#111827;color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;padding:12px 20px;border-radius:6px">${escapeHtml(action.label)}</a></p>
<p style="margin:0 0 16px;font-size:14px;line-height:1.5;color:#4b5563">If the button does not work, copy this address into your browser:<br><a href="${url}" style="color:#4b5563;word-break:break-all">${url}</a></p>
${footer.map((line) => paragraph(line, '#4b5563')).join('\n')}
</td></tr></table>
</td></tr></table>
</body>
</html>
`
}
