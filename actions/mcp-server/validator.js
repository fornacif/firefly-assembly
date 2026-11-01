/**
 * Request authentication for the MCP server action.
 * Requires an Adobe IMS access token in the Authorization Bearer header,
 * validated against IMS. If IMS_ALLOWED_CLIENT_IDS is set, the token must
 * also have been issued to one of those client IDs.
 */

const DEFAULT_IMS_HOST = 'https://ims-na1.adobelogin.com'

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
 * Validate request auth against Adobe IMS.
 * @param {Record<string, any>} params - action params (__ow_headers, IMS_HOST, IMS_ALLOWED_CLIENT_IDS)
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

  // IMS does not check the client_id query parameter, so enforce the allowlist on the validated claims.
  const allowed = String(params.IMS_ALLOWED_CLIENT_IDS || '').split(',').map(s => s.trim()).filter(Boolean)
  if (allowed.length && !allowed.includes(result.token.client_id)) {
    return { error: `Invalid token: client '${result.token.client_id}' is not allowed.` }
  }

  logger.info?.(`Authenticated IMS user ${result.token.user_id} via client ${result.token.client_id}`)
  return { token: result.token }
}

module.exports = {
  getHeadersNormalized,
  getTokenFromRequest,
  getUnverifiedClaims,
  getUnverifiedClientId,
  validateRequestAuth
}
