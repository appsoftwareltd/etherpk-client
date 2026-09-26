import type { PageServerLoad } from './$types'
import { env as privateEnv } from '$env/dynamic/private'
import { env as publicEnv } from '$env/dynamic/public'
import { serveLegalPage } from '@appsoftwareltd/etherpk-shared/legal'
import { clientLegalLinks } from '$lib/server/legal'

/**
 * The Client renders no legal text of its own. A managed Client sends this to EtherPK's page on
 * Corporate; a self-hosted one to the operator's page, or answers 404.
 */
export const load: PageServerLoad = () => serveLegalPage(clientLegalLinks(privateEnv, publicEnv).termsUrl)
