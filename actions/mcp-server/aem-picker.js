// AEM Asset Selector opened in a browser tab (aem-picker.html in web-src): Claude does not let MCP App views frame
// experience.adobe.com, so the views open the picker page with ui/open-link and poll for the selection.
// A picker session holds the selector config, with the IMS token of the user, under an unguessable id passed in the
// URL fragment of the page; the page reads it and posts the selection back through handlePickerRequest.
const crypto = require('crypto')
const stateLib = require('@adobe/aio-lib-state')

const SESSION_TTL_SECONDS = 15 * 60
const SESSION_ID = /^[0-9a-f]{64}$/
// Fields of the selected assets kept for the views (import-aem-asset and filtering)
const ASSET_FIELDS = ['repo:repositoryId', 'repo:assetId', 'repo:path', 'repo:name', 'dc:format']

const sessionKey = id => `aem-picker-${id}`

async function createPickerSession (selectorConfig, { multiple }) {
  const id = crypto.randomBytes(32).toString('hex')
  const state = await stateLib.init()
  await state.put(sessionKey(id), { status: 'pending', multiple, selectorConfig }, { ttl: SESSION_TTL_SECONDS })
  return id
}

async function readSession (state, id) {
  if (!SESSION_ID.test(String(id))) return null
  return (await state.get(sessionKey(id)))?.value || null
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
// { sessionId, action: 'config' } returns the selector config, { action: 'select', assets } or { action: 'cancel' }
// ends the session (the token is dropped from it).
async function handlePickerRequest (body) {
  if (!body || typeof body !== 'object') return json(400, { error: 'Invalid request' })
  const state = await stateLib.init()
  const session = await readSession(state, body.sessionId)
  if (!session || session.status !== 'pending') return json(404, { error: 'This AEM selection has expired or is already done. Start it again from Claude.' })

  if (body.action === 'config') return json(200, { ...session.selectorConfig, multiple: session.multiple })
  if (body.action !== 'select' && body.action !== 'cancel') return json(400, { error: 'Unknown action' })

  const assets = body.action === 'select' && Array.isArray(body.assets)
    ? body.assets.slice(0, session.multiple ? 100 : 1)
      .map(asset => Object.fromEntries(ASSET_FIELDS.map(field => [field, String(asset?.[field] ?? '')])))
    : []
  await state.put(sessionKey(body.sessionId), { status: body.action === 'select' ? 'selected' : 'cancelled', assets }, { ttl: SESSION_TTL_SECONDS })
  return json(200, { status: 'ok' })
}

module.exports = { createPickerSession, getPickerResult, handlePickerRequest }
