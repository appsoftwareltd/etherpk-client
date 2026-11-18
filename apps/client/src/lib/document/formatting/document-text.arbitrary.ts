/**
 * Random document texts for the Formatting Scan's property tests (`checks.test.ts`,
 * `approve.property.test.ts`), built from the pieces the checks read so they hit their cases often.
 */

import fc from 'fast-check'

/** Text built from the pieces the checks read, so random documents hit their cases often. */
export const documentText = fc
    .array(
        fc.constantFrom(
            '- ',
            '-',
            '* ',
            '+ ',
            '1. ',
            '> ',
            '# ',
            '---',
            '```',
            '````',
            '```js',
            'a',
            'b ',
            ' ',
            '  ',
            '\t',
            '\u{a0}',
            '\u{3000}',
            '\n',
            '\r\n',
            '\r',
            '[ ] ',
        ),
        { maxLength: 60 },
    )
    .map((parts) => parts.join(''))
