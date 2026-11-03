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

// Ids of organizations (12345@AdobeOrg) in an IMS answer: orgRef of the organizations, owningEntity of the product
// contexts of a profile
function orgIdsIn (value, ids = new Set()) {
  if (Array.isArray(value)) value.forEach(item => orgIdsIn(item, ids))
  else if (value && typeof value === 'object') {
    if (value.orgRef?.ident && value.orgRef?.authSrc) ids.add(`${value.orgRef.ident}@${value.orgRef.authSrc}`)
    if (typeof value.owningEntity === 'string') ids.add(value.owningEntity)
    Object.values(value).forEach(item => orgIdsIn(item, ids))
  }
  return ids
}

/**
 * Organizations of the user of a token (ids like 12345@AdobeOrg), from IMS: its organizations, or the product contexts of
 * its profile.
 * @param {string} imsHost
 * @param {string} token
 * @returns {Promise<string[]>}
 */
async function getUserOrgs (imsHost, token) {
  const cached = orgsCache.get(token)
  if (cached && cached.expiresAt > Date.now()) return cached.orgs
  const ids = new Set()
  for (const path of ['/ims/organizations/v5', '/ims/profile/v1']) {
    const response = await fetch(`${imsHost}${path}`, { headers: { Authorization: `Bearer ${token}` } })
    if (response.ok) orgIdsIn(await response.json(), ids)
    if (ids.size) break
  }
  const orgs = [...ids]
  for (const [key, entry] of orgsCache) if (entry.expiresAt <= Date.now()) orgsCache.delete(key)
  orgsCache.set(token, { orgs, expiresAt: Date.now() + ORGS_CACHE_MS })
  return orgs
}

/**
 * Checks that the user of the request is in an organization allowed on this server (ALLOWED_ORGS), for the tool calls.
 * @param {Record<string, any>} params
 * @param {{ info?: (...args: any[]) => void, warn?: (...args: any[]) => void }} logger
 * @returns {Promise<string | null>} the reason of the refusal, or null when allowed
 */
async function checkAllowedOrg (params, logger = console) {
  const allowedOrgs = getAllowedOrgs(params)
  if (!allowedOrgs.length) return null
  const token = getTokenFromRequest(params)
  const imsHost = (params.IMS_HOST && String(params.IMS_HOST).trim()) || DEFAULT_IMS_HOST
  let orgs
  try {
    orgs = await getUserOrgs(imsHost, token)
  } catch (error) {
    logger.warn?.('IMS organizations request failed:', error.message)
    return 'Unable to read your Adobe organizations. Try again.'
  }
  if (orgs.some(org => allowedOrgs.includes(org))) return null
  logger.info?.(`IMS user ${getUnverifiedClaims(token).user_id} refused: ${orgs.length} organization(s) read, none allowed`)
  return 'Your Adobe account is not in an organization allowed on this server. Sign in with your company account.'
}

/**
 * Validate request auth against Adobe IMS.
 * @param {Record<string, any>} params - action params (__ow_headers, IMS_HOST)
 * @param {{ info?: (...args: any[]) => void, warn?: (...args: any[]) => void }} logger
 * @returns {Promise<{ error?: string, token?: object }>} error set if invalid, token holds the validated IMS claims
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

  logger.info?.(`Authenticated IMS user ${result.token.user_id} via client ${result.token.client_id}`)
  return { token: result.token }
}

module.exports = {
  checkAllowedOrg,
  getHeadersNormalized,
  getTokenFromRequest,
  getUnverifiedClaims,
  getUnverifiedClientId,
  validateRequestAuth
}
