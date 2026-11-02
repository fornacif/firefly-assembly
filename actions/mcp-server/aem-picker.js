// AEM Asset Selector opened in a browser tab (aem-picker.html in web-src): Claude does not let MCP App views frame
// experience.adobe.com, so the views open the picker page with ui/open-link and poll for the selection.
// A picker session holds the selector config, with the IMS token of the user, under an unguessable id passed in the
// URL fragment of the page; the page reads it and posts the selection back through handlePickerRequest. A folder session
// shows the Destination Selector instead, to choose a folder: its selection is that folder, kept on the server with the
// token of the session for the upload (takeAemFolder).
const crypto = require('crypto')
const stateLib = require('@adobe/aio-lib-state')

const SESSION_TTL_SECONDS = 15 * 60
const SESSION_ID = /^[0-9a-f]{64}$/
// Fields of the selected assets kept for the views (import-aem-asset and filtering)
const ASSET_FIELDS = ['repo:repositoryId', 'repo:assetId', 'repo:path', 'repo:name', 'dc:format']

const sessionKey = id => `aem-picker-${id}`
const folderKey = id => `aem-folder-${id}`

// userId: the user the chosen folder is kept for.
async function createPickerSession (selectorConfig, { multiple, folder = false, userId = null }) {
  const id = crypto.randomBytes(32).toString('hex')
  const state = await stateLib.init()
  await state.put(sessionKey(id), { status: 'pending', multiple, folder, userId, selectorConfig }, { ttl: SESSION_TTL_SECONDS })
  return id
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

// Author repositories the token of a folder session may be sent to
const AEM_AUTHOR_HOST = /^author-p\d+-e\d+\.adobeaemcloud\.com$/

// Folder listing of /content/dam requested from the server with the token of the session, as the Destination Selector
// does: the browser hides the status of the answers without CORS headers. For diagnosis: { status, type, body }.
async function probeRepository (session, repositoryId) {
  if (!session.folder || !AEM_AUTHOR_HOST.test(String(repositoryId))) return { error: 'Not an author repository' }
  try {
    const response = await fetch(`https://${repositoryId}/adobe/repository/content/dam?path=%2Fcontent%2Fdam&limit=1`, {
      headers: { Authorization: `Bearer ${session.selectorConfig.imsToken}`, 'X-Api-Key': session.selectorConfig.apiKey },
      redirect: 'manual'
    })
    const text = await response.text()
    const result = { status: response.status, type: response.headers.get('content-type'), location: response.headers.get('location'), body: text.slice(0, 300) }
    console.log(`AEM probe ${repositoryId}: HTTP ${result.status} ${result.type || ''} ${result.body.slice(0, 120).replace(/\s+/g, ' ')}`)
    return result
  } catch (error) {
    return { error: error.message }
  }
}

function json (statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(body) }
}

// POST /aem-picker from the picker page, authenticated by the session id only:
// { sessionId, action: 'config' } returns the selector config, { action: 'select', assets } or { action: 'cancel' } ends the session (the token is dropped from it).
async function handlePickerRequest (body) {
  if (!body || typeof body !== 'object') return json(400, { error: 'Invalid request' })
  const state = await stateLib.init()
  const session = await readSession(state, body.sessionId)
  if (!session || session.status !== 'pending') return json(404, { error: 'This AEM selection has expired or is already done. Start it again from Claude.' })

  if (body.action === 'config') return json(200, { ...session.selectorConfig, multiple: session.multiple, folder: session.folder })
  if (body.action === 'probe') return json(200, await probeRepository(session, body.repositoryId))
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
