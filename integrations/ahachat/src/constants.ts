/** Operator-set origin of the AhaChat API, e.g. `https://app.ahachat.com`. Never user input. */
export const AHACHAT_API_BASE_URL_ENV = "AHACHAT_API_BASE_URL"

/** One deadline for a whole call: connect, headers and reading the body. */
export const AHACHAT_HTTP_TIMEOUT_MS = 20_000

/**
 * A broadcast token is printable ASCII without spaces. Anything else (a line
 * break, a control character) could never be valid and must not reach an
 * HTTP header, whose rejection message would echo the token.
 */
export const AHACHAT_TOKEN_PATTERN = /^[\x21-\x7E]{1,512}$/

export const AHACHAT_CONTACT_EXPORT_PATH = "api/contact-export"

/** The most contacts AhaChat returns in one page. */
export const AHACHAT_MAX_CONTACTS_PAGE_SIZE = 500

export const AHACHAT_DEFAULT_CONTACTS_PAGE_SIZE = 200

/** Largest response body read; a bigger one is refused before parsing. */
export const AHACHAT_MAX_RESPONSE_BYTES = 10 * 1024 * 1024

/** Most tags / custom fields a page or one contact may list. */
export const AHACHAT_MAX_LIST_ITEMS = 5000

/** Same limit as tag and custom-field names in the workspace. */
export const AHACHAT_MAX_NAME_LENGTH = 255

/** Longest free-text value kept from a contact (ref, address parts, locale…). */
export const AHACHAT_MAX_TEXT_LENGTH = 4096
