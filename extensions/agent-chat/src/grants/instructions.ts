/**
 * The instructions a turn's model is given (ADR 0147): a short fixed preamble, what the grant lets
 * it read, the Client's own description of how the documents are written (`formatGuide`, the
 * managed `AGENTS.md` section's syntax part), and the documents themselves.
 */
import type { GrantLevel } from '../chat/model'
import type { AssembledContext } from './assemble'

export interface InstructionsInput {
    grant: GrantLevel
    /** The chat's home document, or null for a chat without a document. */
    home: string | null
    context: AssembledContext
    /** The home is a Draft, not written yet, rather than a document that has gone. */
    homeUnwritten?: boolean
    /** Today as `YYYY-MM-DD`, at the moment of sending. */
    today: string
    formatGuide: string
    /** Whether the model has the tools that search and read the graph. */
    canSearchGraph: boolean
    /** The person's Agent Instruction, for every model in every chat; empty for none. */
    agentInstruction?: string
}

/** A document as the model reads it, between tags that name it, and say when it is only part of it. */
function documentBlock(name: string, text: string, truncated: boolean, excerpt: boolean): string {
    const safeName = name.replace(/"/g, "'")
    const part = excerpt ? ' part="the outline around the chat"' : ''
    return `<document name="${safeName}"${part}>\n${text}${truncated ? '\n[The rest of this document was cut because it is very long.]' : ''}\n</document>`
}

export function instructions(input: InstructionsInput): string {
    const parts: string[] = [
        [
            'You are answering questions inside EtherPK, a notes app, for the person whose notes these are.',
            `Today is ${input.today}.`,
            'You can only read: you cannot change any document, and nothing you write is kept unless the person chooses to save it into their notes.',
            'When you mention one of their documents, write its exact name as a wikilink, [[Name]], so they can open it.',
            'When something you need was not given to you, say what is missing rather than guessing.',
        ].join(' '),
    ]
    // Theirs, so it comes before the notes and is never cut with them.
    const own = input.agentInstruction?.trim() ?? ''
    if (own !== '') parts.push(`The person's own instructions, for every chat:\n\n${own}`)
    if (input.grant === 'nothing') {
        parts.push('The person has not given you any of their notes for this chat. Answer from what they write here.')
        return parts.join('\n\n')
    }
    if (input.home === null) {
        parts.push('The person started this chat outside any of their documents, so none was given to you with it.')
    } else if (input.context.homeMissing && input.homeUnwritten) {
        parts.push(`The person started this chat in a new document called "${input.home}", which has no text yet.`)
    } else if (input.context.homeMissing) {
        parts.push(`The person started this chat in a document called "${input.home}", which can no longer be read: it may have been deleted.`)
    } else {
        const scope =
            input.grant === 'block'
                ? 'They opened this chat on a bullet in it. Below is the outline around that bullet: its ancestors, and its siblings with what is under them. The rest of the document was not given to you.'
                : input.grant === 'document'
                  ? 'Its text is below.'
                  : 'Its text, and the text of the documents it links to directly, is below.'
        parts.push(`The person is asking from their document "${input.home}". ${scope}`)
    }
    if (input.context.leftOut.length > 0) {
        parts.push(`These linked documents were left out because they are too long to send whole: ${input.context.leftOut.map((doc) => `[[${doc.name}]]`).join(', ')}.${input.canSearchGraph ? ' You can read them with your tools if you need them.' : ''}`)
    }
    if (input.canSearchGraph) {
        parts.push(
            'You can also search the graph and read any other document with your tools. Read what you need rather than guessing, and keep to the documents that bear on the question. Some documents are protected and cannot be found or read at all.',
        )
    }
    if (input.formatGuide.trim() !== '') parts.push(`How the person's notes are written:\n\n${input.formatGuide.trim()}`)
    if (input.context.documents.length > 0) {
        parts.push(`The person's notes:\n\n${input.context.documents.map((doc) => documentBlock(doc.name, doc.text, doc.truncated, doc.excerpt === true)).join('\n\n')}`)
    }
    return parts.join('\n\n')
}
