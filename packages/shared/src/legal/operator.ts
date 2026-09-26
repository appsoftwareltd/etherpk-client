/**
 * The company that runs EtherPK's managed service, as its pages must name it: in the footer of
 * every managed page, on the Terms and in the Privacy Policy. A self-hosted deployment is run by
 * its own operator and shows none of this.
 */
export const MANAGED_SERVICE_OPERATOR = {
    name: 'App Software Ltd',
    companyNumber: '07109450',
    registeredOffice: '1 Derwent Business Centre, Clarke Street, Derby, Derbyshire, England, DE1 2BU',
    vatNumber: 'GB 129 7967 57',
    // LEGAL REVIEW: the one address the Terms, the Privacy Policy and the Contact page give for
    // support, privacy requests and account deletion. Confirm this is the address to publish.
    contactEmail: 'mail@etherpk.com',
    // LEGAL REVIEW: a service commitment printed on the Contact page. Confirm it can be met.
    responseTime: 'We aim to reply within two working days.',
} as const

/** The footer line on managed pages. */
export const MANAGED_SERVICE_OPERATOR_NOTICE =
    `EtherPK is operated by ${MANAGED_SERVICE_OPERATOR.name}, a company registered in England and Wales `
    + `(company number ${MANAGED_SERVICE_OPERATOR.companyNumber}). `
    + `Registered office: ${MANAGED_SERVICE_OPERATOR.registeredOffice}. `
    + `VAT number ${MANAGED_SERVICE_OPERATOR.vatNumber}.`
