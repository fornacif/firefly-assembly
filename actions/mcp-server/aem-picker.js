// AEM Asset Selector opened in a browser tab (aem-picker.html in web-src): Claude does not let MCP App views frame
// experience.adobe.com, so the views open the picker page with ui/open-link and poll for the selection.
// A picker session holds the selector config, with the IMS token of the user, under an unguessable id passed in the
// URL fragment of the page; the page reads it and posts the selection back through handlePickerRequest. A folder session
// shows the Destination Selector instead, to choose a folder: its selection is that folder. AEM author only accepts the
// tokens of the clients allowed in the environment, so a folder session signs the user in on the page with the client
// AEM_CLIENT_ID (OAuth with PKCE, the code exchanged here); its token stays on the server for the upload (takeAemFolder).
const crypto = require('crypto')
const stateLib = require('@adobe/aio-lib-state')

const SESSION_TTL_SECONDS = 15 * 60
const SESSION_ID = /^[0-9a-f]{64}$/
// Fields of the selected assets kept for the views (import-aem-asset and filtering)
const ASSET_FIELDS = ['repo:repositoryId', 'repo:assetId', 'repo:path', 'repo:name', 'dc:format']

const sessionKey = id => `aem-picker-${id}`
const folderKey = id => `aem-folder-${id}`

// login: { imsHost, clientId, scope, redirectUri } to sign the user in on the page (folder sessions); userId: the user
// the chosen folder is kept for.
async function createPickerSession (selectorConfig, { multiple, folder = false, login = null, userId = null }) {
  const id = crypto.randomBytes(32).toString('hex')
  const state = await stateLib.init()
  await state.put(sessionKey(id), { status: 'pending', multiple, folder, login, userId, selectorConfig }, { ttl: SESSION_TTL_SECONDS })
  return id
}

// Token of the user for the client of the login, from the authorization code given to the page
async function exchangeCode (login, { code, codeVerifier }) {
  const response = await fetch(`${login.imsHost}/ims/token/v3`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', client_id: login.clientId, code: String(code), code_verifier: String(codeVerifier) })
  })
  const result = await response.json().catch(() => ({}))
  if (!response.ok || !result.access_token) {
    console.log(`AEM sign-in failed: HTTP ${response.status} ${result.error || ''} ${result.error_description || ''}`.trim())
    throw new Error('The Adobe sign-in for AEM failed. Start again from Claude.')
  }
  return result.access_token
}

async function readSession (state, id) {
  if (!SESSION_ID.test(String(id))) return null
  return (await state.get(sessionKey(id)))?.value || null
}

// Folder chosen in a folder session for a user, with the token to upload there: { repositoryId, path, token },
// or null. It is given once.
async function takeAemFolder (id, userId) {
  if (!SESSION_ID.test(String(id))) return null
  const state = await stateLib.init()
  const folder = (await state.get(folderKey(id)))?.value
  if (!folder || folder.userId !== userId) return null
  await state.delete(folderKey(id))
  return folder
}

// Selection of a session: { status: 'pending' | 'selected' | 'cancelled' | 'expired', assets }. A final result is
// returned once, then the session is deleted.
async function getPickerResult (id) {
  const state = await stateLib.init()
  const session = await readSession(state, id)
  if (!session) return { status: 'expired', assets: [] }
  if (session.status !== 'pending') await state.delete(sessionKey(id))
  return { status: session.status, assets: session.assets || [] }
}

function json (statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(body) }
}

// POST /aem-picker from the picker page, authenticated by the session id only:
// { sessionId, action: 'config' } returns the selector config, or { login } when the user must sign in first;
// { action: 'token', code, codeVerifier } signs the user in and returns the selector config;
// { action: 'select', assets } or { action: 'cancel' } ends the session (the token is dropped from it).
async function handlePickerRequest (body) {
  if (!body || typeof body !== 'object') return json(400, { error: 'Invalid request' })
  const state = await stateLib.init()
  const session = await readSession(state, body.sessionId)
  if (!session || session.status !== 'pending') return json(404, { error: 'This AEM selection has expired or is already done. Start it again from Claude.' })

  const config = () => json(200, { ...session.selectorConfig, multiple: session.multiple, folder: session.folder })
  if (body.action === 'config') {
    if (session.login && !session.selectorConfig.imsToken) {
      const { clientId, scope, redirectUri, imsHost } = session.login
      return json(200, { login: { authorizeUrl: `${imsHost}/ims/authorize/v2`, clientId, scope, redirectUri } })
    }
    return config()
  }
  if (body.action === 'token') {
    if (!session.login) return json(400, { error: 'Unknown action' })
    try {
      const token = await exchangeCode(session.login, body)
      session.selectorConfig = { ...session.selectorConfig, imsToken: token, apiKey: session.login.clientId }
    } catch (error) {
      return json(502, { error: error.message })
    }
    await state.put(sessionKey(body.sessionId), session, { ttl: SESSION_TTL_SECONDS })
    return config()
  }
  if (body.action !== 'select' && body.action !== 'cancel') return json(400, { error: 'Unknown action' })

  const assets = body.action === 'select' && Array.isArray(body.assets)
    ? body.assets.slice(0, session.multiple && !session.folder ? 100 : 1)
      .map(asset => Object.fromEntries(ASSET_FIELDS.map(field => [field, String(asset?.[field] ?? '')])))
    : []
  // The fields of the folders given by the Destination Selector, for diagnosis
  if (session.folder && body.fields) console.log(`AEM folder selected, fields: ${String(body.fields).slice(0, 300)}`)
  if (session.folder && assets.length && session.selectorConfig.imsToken) {
    const { 'repo:repositoryId': repositoryId, 'repo:path': path } = assets[0]
    await state.put(folderKey(body.sessionId), { userId: session.userId, repositoryId, path, token: session.selectorConfig.imsToken }, { ttl: SESSION_TTL_SECONDS })
  }
  await state.put(sessionKey(body.sessionId), { status: body.action === 'select' ? 'selected' : 'cancelled', assets }, { ttl: SESSION_TTL_SECONDS })
  return json(200, { status: 'ok' })
}

module.exports = { createPickerSession, getPickerResult, handlePickerRequest, takeAemFolder }
