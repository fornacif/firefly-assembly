// AEM Asset Selector opened in a browser tab (aem-picker.html in web-src): Claude does not let MCP App views frame
// experience.adobe.com, so the views open the picker page with ui/open-link and poll for the selection.
// A picker session holds the selector config, with the IMS token of the user, under an unguessable id passed in the
// URL fragment of the page; the page reads it and posts the selection back through handlePickerRequest. A folder session
// shows the Destination Selector instead, to choose a folder: its selection is that folder. AEM author only accepts the
// tokens of the clients allowed in the environment, so the Destination Selector signs the user in with the client
// AEM_CLIENT_ID; the page sends its token with the folder, kept on the server for the upload (takeAemFolder).
const crypto = require('crypto')
const stateLib = require('@adobe/aio-lib-state')

const SESSION_TTL_SECONDS = 15 * 60
const SESSION_ID = /^[0-9a-f]{64}$/
// Fields of the selected assets kept for the views (import-aem-asset and filtering)
const ASSET_FIELDS = ['repo:repositoryId', 'repo:assetId', 'repo:path', 'repo:name', 'dc:format']

const sessionKey = id => `aem-picker-${id}`
const folderKey = id => `aem-folder-${id}`

// login: { clientId, scope, redirectUri } of the sign-in of the Destination Selector (folder sessions); userId: the user
// the chosen folder is kept for.
async function createPickerSession (selectorConfig, { multiple, folder = false, login = null, userId = null }) {
  const id = crypto.randomBytes(32).toString('hex')
  const state = await stateLib.init()
  await state.put(sessionKey(id), { status: 'pending', multiple, folder, login, userId, selectorConfig }, { ttl: SESSION_TTL_SECONDS })
  return id
}

// Client of an IMS token (not verified: AEM verifies it)
function clientOf (token) {
  try {
    return JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8')).client_id
  } catch (_) {
    return null
  }
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
// { sessionId, action: 'config' } returns the selector config; { action: 'select', assets } (with imsToken, the token of the
// sign-in, for a folder) or { action: 'cancel' } ends the session (the token is dropped from it).
async function handlePickerRequest (body) {
  if (!body || typeof body !== 'object') return json(400, { error: 'Invalid request' })
  const state = await stateLib.init()
  const session = await readSession(state, body.sessionId)
  if (!session || session.status !== 'pending') return json(404, { error: 'This AEM selection has expired or is already done. Start it again from Claude.' })

  if (body.action === 'config') {
    return json(200, { ...session.selectorConfig, multiple: session.multiple, folder: session.folder, login: session.login })
  }
  if (body.action !== 'select' && body.action !== 'cancel') return json(400, { error: 'Unknown action' })

  const assets = body.action === 'select' && Array.isArray(body.assets)
    ? body.assets.slice(0, session.multiple && !session.folder ? 100 : 1)
      .map(asset => Object.fromEntries(ASSET_FIELDS.map(field => [field, String(asset?.[field] ?? '')])))
    : []
  // The fields of the folders given by the Destination Selector, for diagnosis
  if (session.folder && body.fields) console.log(`AEM folder selected, fields: ${String(body.fields).slice(0, 300)}`)
  if (session.folder && assets.length) {
    // Only a token of the client of the sign-in is kept, never sent elsewhere than to the allowed AEM repositories
    if (!session.login || clientOf(body.imsToken) !== session.login.clientId) return json(400, { error: 'The Adobe sign-in for AEM is missing. Start again from Claude.' })
    const { 'repo:repositoryId': repositoryId, 'repo:path': path } = assets[0]
    await state.put(folderKey(body.sessionId), { userId: session.userId, repositoryId, path, token: String(body.imsToken) }, { ttl: SESSION_TTL_SECONDS })
  }
  await state.put(sessionKey(body.sessionId), { status: body.action === 'select' ? 'selected' : 'cancelled', assets }, { ttl: SESSION_TTL_SECONDS })
  return json(200, { status: 'ok' })
}

module.exports = { createPickerSession, getPickerResult, handlePickerRequest, takeAemFolder }
