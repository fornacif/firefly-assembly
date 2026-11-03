/**
 * Request authentication for the MCP server action.
 * Requires an Adobe IMS access token in the Authorization Bearer header,
 * validated against IMS.
 */

const DEFAULT_IMS_HOST = 'https://ims-na1.adobelogin.com'
// Organizations of the users, by token, for the containers kept warm between requests
const ORGS_CACHE_MS = 10 * 60 * 1000
const orgsCache = new Map()

/**
 * Normalize request headers to lowercase keys.
 * @param {Record<string, string>} raw
 * @returns {Record<string, string>}
 */
function getHeadersNormalized (raw) {
  if (!raw || typeof raw !== 'object') return {}
  return Object.keys(raw).reduce((acc, k) => {
    acc[k.toLowerCase()] = raw[k]
    return acc
  }, {})
}

/**
 * Extract the Bearer token from request params (__ow_headers).
 * @param {Record<string, any>} params
 * @returns {string}
 */
function getTokenFromRequest (params) {
  const authHeader = getHeadersNormalized(params.__ow_headers).authorization
  return authHeader && /^Bearer /i.test(authHeader) ? authHeader.slice(7).trim() : ''
}

/**
 * Read the claims of a JWT without verifying it (IMS verifies it).
 * @param {string} token
 * @returns {Record<string, any>}
 */
function getUnverifiedClaims (token) {
  try {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')) || {}
  } catch (_) {
    return {}
  }
}

/**
 * Read the client_id claim from a JWT without verifying it (IMS verifies it).
 * @param {string} token
 * @returns {string}
 */
function getUnverifiedClientId (token) {
  return getUnverifiedClaims(token).client_id || ''
}

/**
 * Organizations allowed on this server (ALLOWED_ORGS, comma-separated, e.g. 12345@AdobeOrg); empty for any user.
 * @param {Record<string, any>} params
 * @returns {string[]}
 */
function getAllowedOrgs (params) {
  return String(params.ALLOWED_ORGS || '').split(/[\s,]+/).filter(Boolean)
}

/**
 * Organizations of the user of a token (ids like 12345@AdobeOrg), from IMS (scope read_organizations); null when IMS
 * does not give them.
 * @param {string} imsHost
 * @param {string} token
 * @returns {Promise<string[] | null>}
 */
async function getUserOrgs (imsHost, token) {
  const cached = orgsCache.get(token)
  if (cached && cached.expiresAt > Date.now()) return cached.orgs
  const response = await fetch(`${imsHost}/ims/organizations/v5`, { headers: { Authorization: `Bearer ${token}` } })
  if (!response.ok) return null
  const result = await response.json()
  const orgs = (Array.isArray(result) ? result : [])
    .map(org => org?.orgRef && `${org.orgRef.ident}@${org.orgRef.authSrc}`).filter(Boolean)
  for (const [key, entry] of orgsCache) if (entry.expiresAt <= Date.now()) orgsCache.delete(key)
  orgsCache.set(token, { orgs, expiresAt: Date.now() + ORGS_CACHE_MS })
  return orgs
}

/**
 * Validate request auth against Adobe IMS.
 * @param {Record<string, any>} params - action params (__ow_headers, IMS_HOST)
 * @param {{ info?: (...args: any[]) => void, warn?: (...args: any[]) => void }} logger
 * @returns {Promise<{ error?: string, forbidden?: boolean, scope?: string, token?: object }>} error set if invalid
 *   (forbidden: valid but not allowed, scope: a scope it lacks), token holds the validated IMS claims
 */
async function validateRequestAuth (params, logger = console) {
  const token = getTokenFromRequest(params)
  if (!token) {
    return { error: "Authentication required: provide an Adobe IMS access token ('Authorization: Bearer <token>')." }
  }

  const clientId = getUnverifiedClientId(token)
  if (!clientId) {
    return { error: 'Invalid token: not an Adobe IMS access token.' }
  }

  const imsHost = (params.IMS_HOST && String(params.IMS_HOST).trim()) || DEFAULT_IMS_HOST
  const url = `${imsHost}/ims/validate_token/v1?type=access_token&client_id=${encodeURIComponent(clientId)}`

  let result
  try {
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
    result = await response.json()
  } catch (error) {
    logger.warn?.('IMS token validation request failed:', error.message)
    return { error: 'Unable to validate token with Adobe IMS.' }
  }

  if (!result.valid || result.token?.type !== 'access_token') {
    return { error: `Invalid token: ${result.reason || 'rejected by Adobe IMS'}.` }
  }

  // Only the users of the allowed organizations
  const allowedOrgs = getAllowedOrgs(params)
  if (allowedOrgs.length) {
    let orgs
    try {
      orgs = await getUserOrgs(imsHost, token)
    } catch (error) {
      logger.warn?.('IMS organizations request failed:', error.message)
      return { error: 'Unable to read your Adobe organizations.' }
    }
    if (!orgs) {
      return { error: 'This server needs to read your Adobe organizations: sign in again.', forbidden: true, scope: 'read_organizations' }
    }
    if (!orgs.some(org => allowedOrgs.includes(org))) {
      logger.info?.(`IMS user ${result.token.user_id} refused: not in an allowed organization (${orgs.length} organization(s))`)
      return { error: 'Your Adobe account is not in an organization allowed on this server. Sign in with your company account.', forbidden: true }
    }
  }

  logger.info?.(`Authenticated IMS user ${result.token.user_id} via client ${result.token.client_id}`)
  return { token: result.token }
}

module.exports = {
  getAllowedOrgs,
  getHeadersNormalized,
  getTokenFromRequest,
  getUnverifiedClaims,
  getUnverifiedClientId,
  validateRequestAuth
}
