import type { PageServerLoad } from './$types'
import * as privateEnv from '$app/env/private'
import * as publicEnv from '$app/env/public'
import { serveLegalPage } from '@appsoftwareltd/etherpk-shared/legal'
import { clientLegalLinks } from '#lib/server/legal.js'

/**
 * The Client renders no legal text of its own. A managed Client sends this to EtherPK's page on
 * Corporate; a self-hosted one to the operator's page, or answers 404.
 */
export const load: PageServerLoad = () => serveLegalPage(clientLegalLinks(privateEnv, publicEnv).termsUrl)
