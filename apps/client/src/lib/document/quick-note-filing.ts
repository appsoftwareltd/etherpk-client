/**
 * The concepts a [[Quick Note]] can be filed under: the person's [[Favourite]]s (ADR 0186).
 *
 * A document favourite is offered, in the order the person keeps them. A favourited View (a
 * PDF, the Tasks view) is not a concept a note can sit under, and neither is a journal day: the
 * move already nests every note under the day it was written.
 */
import { type Favourite, isViewFavourite } from './favourite-entry'
import { isJournalConcept } from './journal-concept'

export function fileUnderChoices(favourites: readonly Favourite[]): string[] {
    return favourites.filter((favourite): favourite is string => !isViewFavourite(favourite) && !isJournalConcept(favourite))
}
