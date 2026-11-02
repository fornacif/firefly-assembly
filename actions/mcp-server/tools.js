const crypto = require('crypto')
const { Readable } = require('stream')
const { z } = require('zod')
const filesLib = require('@adobe/aio-lib-files')
const { checkTexts, guessLanguage, warmUp: warmUpOcr } = require('./ocr.js')
const { getStartViewHtml, getUploadViewHtml, getVariantImagesViewHtml, getLayersViewHtml, getTextsViewHtml, getVariantViewHtml } = require('./views.js')
const stateLib = require('@adobe/aio-lib-state')
const { getTokenFromRequest, getUnverifiedClaims, getUnverifiedClientId } = require('./validator.js')
const { createPickerSession, getPickerResult, takeAemFolder } = require('./aem-picker.js')
const { zipFiles } = require('./zip.js')
const spectrumAsset = require('./spectrum-asset.js')

const IMS_TOKEN_URL = 'https://ims-na1.adobelogin.com/ims/token/v3'
const PHOTOSHOP_API = 'https://photoshop-api.adobe.io/v2'
const POLL_FIRST_DELAY_MS = 500
const POLL_MAX_DELAY_MS = 2000
const POLL_TIMEOUT_MS = 240000
const URL_EXPIRY_SECONDS = 24 * 3600
const STORAGE_ORIGIN = 'https://firefly.azureedge.net'
const EDITABLE_LAYER_TYPES = ['text_layer', 'smart_object_layer']
const MAX_VARIANTS = 10
const WIDGET_RESULT_TTL_SECONDS = 24 * 3600
// Short reference shown at the end of the user's message: "r" and 6 base-36 characters (2 billion values per user)
const WIDGET_RESULT_REF = /^r[0-9a-z]{6}$/
const REF_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'
const AEM_PICKER_PAGE = 'aem-picker.html'

const RESOURCE_MIME_TYPE = 'text/html;profile=mcp-app'
const VIEWS = {
  start: { uri: 'ui://start-variants/app.html', name: 'Create Variants App', description: 'Variant count and PSD template upload', html: getStartViewHtml },
  upload: { uri: 'ui://upload-file/app.html', name: 'Upload File App', description: 'File upload widget', html: getUploadViewHtml },
  variantImages: { uri: 'ui://variant-images/app.html', name: 'Variant Images App', description: 'Image grid per variant and smart object layer', html: getVariantImagesViewHtml },
  layers: { uri: 'ui://psd-layers/app.html', name: 'PSD Layers App', description: 'Editable layers picker', html: getLayersViewHtml },
  texts: { uri: 'ui://variant-texts/app.html', name: 'Variant Texts App', description: 'Editable table of the texts per variant', html: getTextsViewHtml },
  variant: { uri: 'ui://psd-variant/app.html', name: 'PSD Variant App', description: 'Variant preview and download', html: getVariantViewHtml }
}

const WORKFLOW = `Variant creation workflow. When the user asks to create variants (or versions, adaptations, localizations...) of a banner, ad, visual, social post or any PSD template, ALWAYS follow these steps in order, one at a time, without skipping any:
1. Start: call start-variant-creation (pass variantCount if the user already gave it). The user sets the number of variants and uploads the PSD template (from their computer or AEM Assets) in the widget, then says to continue. The widget gives you the template name and URL in your context (or through get-widget-result, see below): use that URL. Never ask for the file or its URL in chat.
2. Layer selection: immediately call get-psd-manifest with the template URL. The user picks the layers to vary in the widget. Then wait.
3. Texts: right after the layer selection, if text layers were selected, get the texts of each variant: the user provides them, or you write them from a brief (subject, tone, language). The user's requests always come first (length, number of words or lines, wording): follow them exactly, even if the text may not fit, and never shorten or change a text the user asked for to make it fit. Otherwise, write each text about as long as the original text of its layer (given by get-psd-manifest): the same number of lines and about the same number of characters per line (within 10%), so that it fits the layout. Write the line breaks yourself (\\n), where the original text has them: a point text layer does not wrap its lines by itself (a text without any line break is spread over the lines of the original text, by length). Give each variant a short label (e.g. its title), then call review-variant-texts with the texts and the original text of each layer. Then wait.
4. Images: if smart object layers were selected, call upload-variant-images ONCE with the variant labels and the selected smart object layers (id, name and frame width and height from get-psd-manifest), so the user drops (or picks from AEM Assets) one image per variant and layer in a grid and adjusts how each one is cropped to its frame. When the user confirms, the widget gives you the URL, size and crop of each image the same way. Never ask for image URLs in chat. Then wait.
5. Generation: as soon as the images are confirmed (or the texts, without smart object layers), call create-variant ONCE with all variants, passing for each image the crop chosen in the grid; do not recap the variants or ask for another approval. The widget shows the generated files with download buttons.
6. Review: create-variant measures the texts of the generated files (past the edges of the canvas, overlapping other elements more than in the template, or, read by an OCR, words broken across two lines by a text box too narrow for them, or not found in the visual: cut by a text box that is too small, hidden or hard to read) and the widget marks each problem on the visual, with a proposed fix (a smaller font size). Each variant has a field of changes, pre-filled with its proposed fixes, that the user edits, then sends to you: nothing is generated again before. Do not list the problems in chat: briefly say that the widget shows them and takes the changes. When the user asks for changes (in the widget or in chat), make exactly the changes asked, nothing else: change a font size only when asked; to change the words of a text, rewrite it as asked (e.g. twice as many words, at most two lines) and keep its font size, even if it may not fit; then call create-variant again with the variants to change only, with the same file names and the same edits except the changes (a font size of N% is fontScale N/100): the new widget shows only these variants, the others stay in the earlier widgets. The widget checks whether the texts fit: do not adjust them beforehand. If a text the user asked for does not fit, you may then suggest a fix (a smaller font size or a shorter text), without applying it.
Changes after generation: to re-crop or swap images, call upload-variant-images again with images pre-filled from the previous confirmation (never ask to upload again the images you already have, unless their URLs expired); to change texts, call create-variant again with the variants to change only (same file names).
Widgets send their result (template URL, layers, texts, images) in your context and end the user's message with a reference in parentheses like "(r7k2p9)": if you do not have that result in your context, call get-widget-result with this ref before going on; never ask the user to redo a step because a result seems missing.
The URLs from the widgets are temporary presigned URLs: use them in tool calls, but never show them to the user. Reply in the user's language.`

const NEXT_STEPS_AFTER_SELECTION = 'Wait for the user to pick layers in the widget. Then: (1) if text layers were selected, get the ' +
  'texts of each variant (from the user, or written from a brief: subject, tone, language), each with the same number of lines and ' +
  'about the same number of characters (within 10%) as the original text of its layer, give each variant a short label, then ' +
  'call review-variant-texts with the texts and the original texts; (2) if smart object layers were selected, call upload-variant-images ONCE with all variant labels and ' +
  'the selected smart object layers (id, name, and frame width and height): it shows a single grid, one image per variant and layer, ' +
  'where the user adjusts each crop. Never call upload-file per image and never ask for image URLs; (3) then call create-variant ONCE ' +
  'with all variants, passing each image crop as given by the grid, without a recap or another approval.'

// Server-to-server token for Firefly Services, reused across warm invocations.
let cachedToken = null
let tokenRequest = null

// Server-to-server token of Firefly Services, kept until a minute before it expires. Parallel calls share one request.
async function getFireflyServicesToken (params) {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60000) return cachedToken.value
  tokenRequest = tokenRequest || requestFireflyServicesToken(params).finally(() => { tokenRequest = null })
  return tokenRequest
}

async function requestFireflyServicesToken (params) {
  if (!params.FIREFLY_SERVICES_API_CLIENT_ID || !params.FIREFLY_SERVICES_API_CLIENT_SECRET) {
    throw new Error('Firefly Services credentials are not configured on this server.')
  }
  const response = await fetchWithRetry(IMS_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: params.FIREFLY_SERVICES_API_CLIENT_ID,
      client_secret: params.FIREFLY_SERVICES_API_CLIENT_SECRET,
      scope: params.FIREFLY_SERVICES_API_SCOPES
    })
  })
  const result = await readJson(response)
  if (!result.access_token) throw new Error(`IMS token request failed: ${result.error_description || result.error || response.status}`)

  cachedToken = { value: result.access_token, expiresAt: Date.now() + result.expires_in * 1000 }
  return cachedToken.value
}

// Time limit of one HTTP request (answer and body)
const REQUEST_TIMEOUT_MS = 30000
const RATE_LIMIT_RETRIES = 6
// Retries of server errors and network failures, which are usually transient
const TRANSIENT_RETRIES = 2
const TRANSIENT_STATUSES = [500, 502, 503, 504]
const RETRY_BASE_DELAY_MS = 1000
const RETRY_MAX_DELAY_MS = 30000

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

// Exponential backoff, randomized so that parallel jobs do not retry all at once
const backoff = attempt => Math.min(RETRY_BASE_DELAY_MS * 2 ** attempt * (0.5 + Math.random()), RETRY_MAX_DELAY_MS)

// fetch with a time limit, that waits and retries when Firefly Services answers 429 (rate limit), for the Retry-After delay
// when given, and on server errors and network failures.
async function fetchWithRetry (url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  for (let attempt = 0; ; attempt++) {
    let response
    try {
      response = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) })
    } catch (error) {
      const reason = error.name === 'TimeoutError' ? `no answer within ${timeoutMs / 1000}s` : error.cause?.message || error.message
      if (attempt >= TRANSIENT_RETRIES) throw new Error(`Request to ${new URL(url).host} failed: ${reason}`)
      await wait(backoff(attempt))
      continue
    }
    const retry = response.status === 429
      ? attempt < RATE_LIMIT_RETRIES
      : TRANSIENT_STATUSES.includes(response.status) && attempt < TRANSIENT_RETRIES
    if (!retry) return response
    const retryAfterMs = Number(response.headers.get('retry-after')) * 1000
    // Frees the connection
    await response.body?.cancel().catch(() => {})
    await wait(retryAfterMs > 0 ? Math.min(retryAfterMs, RETRY_MAX_DELAY_MS) : backoff(attempt))
  }
}

// Body of a JSON answer; an error page (e.g. HTML from a gateway) is returned as { message } with its start.
async function readJson (response) {
  const text = await response.text()
  try {
    return text ? JSON.parse(text) : {}
  } catch (_) {
    return { message: text.slice(0, 300) }
  }
}

// Headers of the Firefly Services APIs (Photoshop, auto-crop), with the server-to-server token.
async function fireflyHeaders (params) {
  return {
    Authorization: `Bearer ${await getFireflyServicesToken(params)}`,
    'x-api-key': params.FIREFLY_SERVICES_API_CLIENT_ID,
    'Content-Type': 'application/json'
  }
}

// Calls a Firefly Services API; on 401 (token revoked or expired early), once again with a new token.
async function callFirefly (params, label, url, options = {}, renewed = false) {
  const response = await fetchWithRetry(url, { ...options, headers: await fireflyHeaders(params) })
  if (response.status === 401 && !renewed) {
    cachedToken = null
    await response.body?.cancel().catch(() => {})
    return callFirefly(params, label, url, options, true)
  }
  const body = await readJson(response)
  if (!response.ok) throw new Error(`${label} ${response.status}: ${JSON.stringify(body)}`)
  return body
}

function callPhotoshop (params, path, options) {
  return callFirefly(params, 'Photoshop API', `${PHOTOSHOP_API}${path}`, options)
}

// Runs tasks with at most max of them at once, the others waiting in order.
function createLimiter (max) {
  let active = 0
  const queue = []
  const next = () => {
    if (active >= max || !queue.length) return
    active++
    const { task, resolve, reject } = queue.shift()
    Promise.resolve().then(task).then(resolve, reject).finally(() => { active--; next() })
  }
  return task => new Promise((resolve, reject) => { queue.push({ task, resolve, reject }); next() })
}

// Asynchronous Firefly Services jobs running at once in this container (a generation of 10 variants runs up to 10 renders, plus
// their crops and text measures): keeps the polling within the rate limits, without delaying the renders of a full generation.
const MAX_CONCURRENT_JOBS = 10
const limitJob = createLimiter(MAX_CONCURRENT_JOBS)

// Polls check() until it returns a value (undefined: not finished), more often at first, as most jobs take a few seconds.
async function pollJob (check, label, timeoutMs = POLL_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs
  for (let delay = POLL_FIRST_DELAY_MS; Date.now() < deadline; delay = Math.min(delay * 1.5, POLL_MAX_DELAY_MS)) {
    await wait(delay)
    const result = await check()
    if (result !== undefined) return result
  }
  throw new Error(`${label} did not finish within ${Math.round(timeoutMs / 1000)}s`)
}

// A job of the Photoshop API may stall (still pending minutes later, when it usually takes seconds): a job not finished after
// this long is submitted again, and the first result kept
const JOB_RESUBMIT_AFTER_MS = 60000

// Submits an asynchronous Photoshop job and polls it until it finishes, within POLL_TIMEOUT_MS; returns the job result. A job
// longer than JOB_RESUBMIT_AFTER_MS is submitted once more (the same outputs: either job writes them).
function runPhotoshopJob (params, path, body) {
  const run = limit => limitJob(async () => {
    const { jobId } = await callPhotoshop(params, path, { method: 'POST', body: JSON.stringify(body) })
    if (!jobId) throw new Error(`Photoshop API ${path}: no job id in the answer`)
    return pollJob(async () => {
      const status = await callPhotoshop(params, `/status/${jobId}`)
      if (status.status === 'succeeded') return status.result
      if (status.status === 'failed') throw new Error(`Photoshop job failed: ${JSON.stringify(status.errorDetails)}`)
    }, `Photoshop job ${jobId}`, limit)
  })
  const first = run(POLL_TIMEOUT_MS)
  let settled = false
  first.then(() => { settled = true }, () => { settled = true })
  const second = wait(JOB_RESUBMIT_AFTER_MS).then(() => {
    if (settled) return first
    console.warn(`Photoshop ${path} not finished after ${JOB_RESUBMIT_AFTER_MS / 1000}s: submitted again`)
    return run(POLL_TIMEOUT_MS - JOB_RESUBMIT_AFTER_MS)
  })
  // The first job to succeed; the error of the first one when both fail
  return Promise.any([first, second]).catch(() => first)
}

async function generateManifest (params, url) {
  const result = await runPhotoshopJob(params, '/generate-manifest', {
    image: { source: { url } },
    outputs: [{ destination: { embedded: 'json' }, mediaType: 'application/json' }]
  })
  const manifest = result?.outputs?.[0]?.destination?.content ?? result
  if (!manifest?.document?.bounds) throw new Error('The Photoshop API returned no document in the manifest of the file.')
  return manifest
}

// Results kept by a warm container for an hour, by key: the workflow reads the same template at each step, and the same image
// for the crop of each slot that uses it. A promise is kept while running, so that parallel and repeated calls share it; a
// failed one is not kept.
const CACHE_TTL_MS = 3600000

function createCache (size) {
  const entries = new Map()
  return (key, compute) => {
    const hit = entries.get(key)
    if (hit && hit.expiresAt > Date.now()) return hit.value
    const value = compute()
    entries.delete(key)
    entries.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS })
    value.catch(() => { if (entries.get(key)?.value === value) entries.delete(key) })
    if (entries.size > size) entries.delete(entries.keys().next().value)
    return value
  }
}

const manifestCache = createCache(50)
const previewCache = createCache(20)
const cropCache = createCache(100)

// Manifest of a template or image, from the cache.
function getManifest (params, url) {
  return manifestCache(url, () => generateManifest(params, url))
}

// Adobe I/O Runtime ends a web request after about 60 seconds, whatever the action timeout: tools that can take longer
// answer within this time, with what they could not finish marked as such. Jobs still running go on in the container, and
// their results are cached for the next call.
const RESPONSE_BUDGET_MS = 50000

// Settles like the promise, or with fallback() if it is not settled by the deadline (fallback may throw).
function beforeDeadline (promise, deadline, fallback) {
  let timer
  const late = new Promise((resolve, reject) => {
    timer = setTimeout(() => { try { resolve(fallback()) } catch (error) { reject(error) } }, Math.max(0, deadline - Date.now()))
  })
  return Promise.race([promise, late]).finally(() => clearTimeout(timer))
}

// Fallback of beforeDeadline for a result that cannot be left out.
const tooLate = what => () => {
  throw new Error(`${what} did not finish within the time limit of a request. Generate it again alone, or with fewer variants at once (finished steps are reused).`)
}

function isUnlocked (layer) {
  return (layer.protection || []).every(flag => flag === 'none')
}

// Area of a layer in the document, as { left, top, width, height }: from its bounds ({ left, top, right, bottom } or
// { left, top, width, height }), or the frame of a smart object; null when unknown or empty.
function layerArea (layer) {
  const b = layer.bounds || layer.referenceFrame
  if (!b || b.left == null || b.top == null) return null
  const width = b.width ?? b.right - b.left
  const height = b.height ?? b.bottom - b.top
  return width > 0 && height > 0 ? { left: b.left, top: b.top, width, height } : null
}

// Text and smart object layers that are not locked, including those nested in groups and artboards.
function getEditableLayers (layers = []) {
  return layers.flatMap(layer => {
    const nested = getEditableLayers(layer.children || layer.layers)
    if (!EDITABLE_LAYER_TYPES.includes(layer.type) || !isUnlocked(layer)) return nested
    const editable = { id: layer.id, name: layer.name, type: layer.type }
    if (layer.type === 'text_layer') editable.text = layer.text?.content ?? ''
    if (layer.type === 'smart_object_layer' && layer.referenceFrame) editable.frame = boundsSize(layer.referenceFrame)
    const area = layerArea(layer)
    if (area) editable.area = area
    return [editable, ...nested]
  })
}

// Flattened JPEG of a PSD, on which the layer picker of the views shows the editable layers.
function renderPreview (params, url) {
  return previewCache(url, async () => {
    const { uploadUrl, readUrl } = await createStorageUrls('previews', 'preview.jpg')
    await runPhotoshopJob(params, '/create-composite', {
      image: { source: { url } },
      outputs: [{ destination: { url: uploadUrl }, mediaType: 'image/jpeg', quality: 'high' }]
    })
    return readUrl
  })
}

function newStoragePath (folder, fileName) {
  const safeName = fileName.replace(/[^\w.-]/g, '_')
  // Unique path: files with the same name can be created in the same millisecond (e.g. parallel crops)
  return `${folder}/${Date.now()}-${crypto.randomUUID().slice(0, 8)}-${safeName}`
}

// Clients of App Builder storage and state, initialized once per container (a failed init is tried again on the next call).
let filesClient = null
let stateClient = null
const initFiles = () => (filesClient = filesClient || filesLib.init().catch(error => { filesClient = null; throw error }))
const initState = () => (stateClient = stateClient || stateLib.init().catch(error => { stateClient = null; throw error }))

async function createStorageUrls (folder, fileName) {
  const files = await initFiles()
  const path = newStoragePath(folder, fileName)
  const options = { expiryInSeconds: URL_EXPIRY_SECONDS }
  const [uploadUrl, readUrl] = await Promise.all([
    files.generatePresignURL(path, { ...options, permissions: 'w' }),
    files.generatePresignURL(path, { ...options, permissions: 'r' })
  ])
  return { uploadUrl, readUrl }
}

const AEM_HOST = /^(author|delivery)-(p\d+-e\d+)\.adobeaemcloud\.com$/
const AEM_ASSET_ID = /^urn:aaid:aem:[0-9a-f-]{36}$/i

function toAemHost (repositoryId) {
  return String(repositoryId || '').trim().replace(/^https?:\/\//, '').replace(/\/$/, '')
}

// Program and environment of a repository (e.g. p12345-e67890), shared by its author and delivery tiers.
function aemEnvironment (host) {
  return AEM_HOST.exec(host)?.[2] || null
}

const aemHost = (tier, environment) => `${tier}-${environment}.adobeaemcloud.com`

// API key sent to AEM with the token of the user: AEM_API_KEY, or the client of the token
const aemApiKey = (params, token) => params.AEM_API_KEY || getUnverifiedClientId(token)

// Scopes asked for AEM in the sign-in with AEM_CLIENT_ID (AEM_IMS_SCOPES)
const AEM_IMS_SCOPES = 'AdobeID,openid,aem.folders,aem.assets.author'

// Sign-in of the user for AEM author with AEM_CLIENT_ID, a client allowed in the AEM environments; null when not set.
function getAemLogin (params) {
  const clientId = String(params.AEM_CLIENT_ID || '').trim()
  if (!clientId) return null
  return {
    imsHost: (params.IMS_HOST && String(params.IMS_HOST).trim()) || 'https://ims-na1.adobelogin.com',
    clientId,
    scope: String(params.AEM_IMS_SCOPES || AEM_IMS_SCOPES).trim(),
    redirectUri: `${getStaticOrigin(params)}/${AEM_PICKER_PAGE}`
  }
}

// AEM Assets repositories browsed with the Asset Selector; null when AEM_REPOSITORY_ID is not set.
// AEM_REPOSITORY_ID: one repository (shown directly in the selector), several comma-separated, or '*' for any AEM as a
// Cloud Service repository of the user (both chosen in the selector). AEM_IMS_ORG: empty to let the user pick the
// organization. AEM_TIER: 'delivery' (default, approved assets of Dynamic Media with OpenAPI) or 'author' (all assets).
function getAemConfig (params) {
  const repositories = String(params.AEM_REPOSITORY_ID || '').split(',').map(toAemHost).filter(Boolean)
  if (!repositories.length) return null
  const tier = params.AEM_TIER === 'author' ? 'author' : 'delivery'
  const pinned = repositories.length === 1 && aemEnvironment(repositories[0])
  return {
    tier,
    environments: repositories.includes('*') ? '*' : repositories.map(aemEnvironment).filter(Boolean),
    pinnedRepository: pinned ? aemHost(tier, pinned) : null,
    imsOrg: String(params.AEM_IMS_ORG || '').trim() || null
  }
}

function requireAemConfig (params) {
  const aem = getAemConfig(params)
  if (!aem) throw new Error('AEM is not configured on this server (AEM_REPOSITORY_ID).')
  return aem
}

function getAemEnvironment (aem, repositoryId) {
  const environment = aemEnvironment(toAemHost(repositoryId || aem.pinnedRepository))
  if (!environment || !(aem.environments === '*' || aem.environments.includes(environment))) {
    throw new Error(`AEM repository not allowed on this server: ${repositoryId || '(none)'}`)
  }
  return environment
}

// URL of the original binary of an asset: by asset id on the delivery tier, by path on the author tier. Only hosts
// of allowed AEM repositories are built, so the user's token is never sent to another host.
function getAemDownloadUrl (aem, { repositoryId, assetId, path, fileName }) {
  const environment = getAemEnvironment(aem, repositoryId)
  if (assetId) {
    if (!AEM_ASSET_ID.test(assetId)) throw new Error(`Invalid AEM asset id: ${assetId}`)
    return new URL(`https://delivery-${environment}.adobeaemcloud.com/adobe/assets/${assetId}/original/as/${encodeURIComponent(fileName)}`)
  }
  const origin = `https://author-${environment}.adobeaemcloud.com`
  const url = new URL(path || '', origin)
  if (url.origin !== origin || !url.pathname.startsWith('/content/dam/')) throw new Error(`Not an asset of the AEM repository: ${path}`)
  return url
}

// Copies the original binary of an AEM asset to App Builder storage, so that the Photoshop API can read it; returns
// its temporary read URL. Approved assets are public on the delivery tier: the IMS token of the user is only sent
// when the binary requires authentication.
async function importAemAsset (params, aem, asset) {
  const url = getAemDownloadUrl(aem, asset)
  // The time limit covers the download of the binary
  let response = await fetchWithRetry(url, {}, RESPONSE_BUDGET_MS)
  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel().catch(() => {})
    const token = getTokenFromRequest(params)
    response = await fetchWithRetry(url, { headers: { Authorization: `Bearer ${token}`, 'X-Api-Key': aemApiKey(params, token) } }, RESPONSE_BUDGET_MS)
  }
  const fileName = asset.fileName
  if (!response.ok) throw new Error(`AEM download of ${fileName} failed (HTTP ${response.status})`)

  const files = await initFiles()
  const path = newStoragePath('aem', fileName)
  await files.write(path, Readable.fromWeb(response.body))
  return { fileName, url: await files.generatePresignURL(path, { expiryInSeconds: URL_EXPIRY_SECONDS, permissions: 'r' }) }
}

// Folder of an allowed AEM repository, on its author tier: its URL. Only hosts of allowed repositories are built, so the
// user's token is never sent to another host.
function getAemFolderUrl (aem, { repositoryId, path }) {
  const origin = `https://${aemHost('author', getAemEnvironment(aem, repositoryId))}`
  const url = new URL(String(path || '').replace(/\/$/, ''), origin)
  if (url.origin !== origin || !/^\/content\/dam(\/|$)/.test(url.pathname)) throw new Error(`Not a folder of the AEM repository: ${path}`)
  return url
}

const AEM_MIME_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', psd: 'image/vnd.adobe.photoshop', zip: 'application/zip' }

// Uploads a file to an AEM folder with the direct binary upload of AEM as a Cloud Service: initiateUpload gives the URLs of
// the parts of the binary (cloud storage, without the token), then completeUpload creates the asset, or a new version of an
// asset of the same name.
async function uploadToAem (folderUrl, { fileName, data }, headers) {
  const post = (url, form) => fetchWithRetry(url, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form)
  }, RESPONSE_BUDGET_MS)
  const initiated = await post(`${folderUrl.href}.initiateUpload.json`, { fileName, fileSize: String(data.length) })
  if (!initiated.ok) throw new Error(`AEM refused the upload (HTTP ${initiated.status})`)
  const upload = await initiated.json()
  const file = upload.files?.[0]
  if (!file?.uploadURIs?.length || !upload.completeURI) throw new Error('AEM did not give upload URLs')
  // Parts as large as needed for the URLs given, within the sizes allowed
  const partSize = Math.max(file.minPartSize || 0, Math.ceil(data.length / file.uploadURIs.length))
  if (file.maxPartSize && partSize > file.maxPartSize) throw new Error('The file is too large for AEM')
  for (let start = 0, i = 0; start < data.length || i === 0; start += partSize, i++) {
    const response = await fetchWithRetry(file.uploadURIs[i], { method: 'PUT', body: data.subarray(start, start + partSize) }, RESPONSE_BUDGET_MS)
    await response.body?.cancel().catch(() => {})
    if (!response.ok) throw new Error(`Upload to AEM failed (HTTP ${response.status})`)
  }
  const completeUrl = new URL(upload.completeURI, folderUrl.origin)
  if (completeUrl.origin !== folderUrl.origin) throw new Error('AEM gave an unexpected completion URL')
  const extension = fileName.split('.').pop().toLowerCase()
  const completed = await post(completeUrl, {
    fileName,
    mimeType: file.mimeType || AEM_MIME_TYPES[extension] || 'application/octet-stream',
    uploadToken: file.uploadToken,
    createVersion: 'true'
  })
  await completed.body?.cancel().catch(() => {})
  if (!completed.ok) throw new Error(`AEM did not create the asset (HTTP ${completed.status})`)
}

function toLayerEdit (layer) {
  const edit = { id: layer.id, type: layer.type, operation: { type: 'edit' } }
  if (layer.type === 'text_layer') {
    // Photoshop separates lines with \r: line breaks typed in the views or written by the model are \n
    edit.text = { content: layer.text.replace(/\r?\n/g, '\r') }
    if (layer.characterStyle) edit.text.characterStyles = [{ characterStyle: layer.characterStyle }]
  }
  else edit.smartObject = { smartObjectFile: { source: { url: layer.imageUrl } } }
  return edit
}

// Output files of create-variant by format. A PSD cannot be shown in the view: when no format is displayable, the
// same job also renders a JPEG preview.
const VARIANT_OUTPUTS = {
  png: { extension: 'png', displayable: true, output: { mediaType: 'image/png', compression: 'medium' } },
  jpeg: { extension: 'jpg', displayable: true, output: { mediaType: 'image/jpeg', quality: 'photoshop_max' } },
  psd: { extension: 'psd', displayable: false, output: { mediaType: 'image/vnd.adobe.photoshop' } }
}
const VARIANT_FORMATS = Object.keys(VARIANT_OUTPUTS)
const PREVIEW_OUTPUT = { mediaType: 'image/jpeg', quality: 'high' }

// Renders one variant in all the requested formats with a single Photoshop job, then checks its texts on the visual.
async function createVariant (params, { templateUrl, templateManifest, formats, layers, language, fileName: baseName, deadline, onRendered, readable }) {
  const shownFormat = formats.find(format => VARIANT_OUTPUTS[format].displayable)
  const [files, preview] = await Promise.all([
    Promise.all(formats.map(format => createStorageUrls('variants', `${baseName}.${VARIANT_OUTPUTS[format].extension}`))),
    shownFormat ? null : createStorageUrls('variants', `${baseName}-preview.jpg`)
  ])

  await beforeDeadline(runPhotoshopJob(params, '/create-composite', {
    image: { source: { url: templateUrl } },
    edits: { layers: layers.map(toLayerEdit) },
    outputs: [
      ...formats.map((format, i) => ({ destination: { url: files[i].uploadUrl }, ...VARIANT_OUTPUTS[format].output })),
      ...(preview ? [{ destination: { url: preview.uploadUrl }, ...PREVIEW_OUTPUT }] : [])
    ]
  }), deadline, tooLate('The rendering'))
  // Shown in the view: the first displayable file, or the preview
  const imageUrl = preview ? preview.readUrl : files[formats.indexOf(shownFormat)].readUrl
  const rendered = {
    fileName: baseName,
    imageUrl,
    files: formats.map((format, i) => ({ format, fileName: `${baseName}.${VARIANT_OUTPUTS[format].extension}`, url: files[i].readUrl })),
    // For the view, which marks the text problems on the image
    canvas: boundsSize(templateManifest.document.bounds)
  }
  // Shown while its texts are checked
  onRendered?.(rendered)
  const checkDeadline = Math.min(deadline, Date.now() + TEXT_CHECK_BUDGET_MS)
  return {
    ...rendered,
    ...await beforeDeadline(measureRenderedTexts(imageUrl, templateManifest, layers, language, checkDeadline, readable)
      .then(({ issues, unchecked }) => ({ textIssues: issues, ...(unchecked ? { textsUnchecked: unchecked } : {}) })),
    checkDeadline, () => ({ textIssues: null, textsUnchecked: 'not finished within the time limit' }))
  }
}

// A text overlaps another element when their common area grows beyond this share of the text area compared to the template
const OVERLAP_TOLERANCE = 0.05
// A text that lies mostly on an element in the template (this share of its area at least) is placed on it by design
const DESIGNED_OVERLAP_SHARE = 0.5
// Layers covering more of the canvas than this share are backgrounds, under the texts by design
const BACKGROUND_SHARE = 0.8

// Smallest font scale proposed as a fix, as advised to the model: below it, a text is better shortened
const MIN_FONT_SCALE = 0.8

// The text checks are optional: given up after this long, so that they do not hold the variant (it is shown, its texts not
// checked)
const TEXT_CHECK_BUDGET_MS = 60000

// The OCR gives up this long before the deadline of the measure, so that the other checks are returned in time
const OCR_DEADLINE_MARGIN_MS = 1000

// Margin around a text area read by the OCR, as a share of its height: glyphs may go past the box of the layer
const OCR_MARGIN = 0.15
// ...and at least this many pixels: the box of a small text may cut its last letter
const OCR_MIN_MARGIN_PX = 8
// A text is in place when its words read lie in its area of the template with OCR_MARGIN; to see whether they do, and where it
// went if it grew, the area of the template is read with this wider margin, and wider by the growth expected from its length
// (at least GROWTH_READ_MIN of its width on each side)
const IN_PLACE_READ_MARGIN = 0.4
const GROWTH_READ_MIN = 0.25
// A text whose words read, with the missing ones, would go past an edge of the canvas by more than this, goes past it
const OCR_EDGE_PX = 4
// The area read goes past the sides of the bounds of a text by this many of its line heights: the letters past a side of a panel
// are read, and the words they end are not taken for words read with an error
const PAST_BOUNDS_READ_LINES = 2.5
// A word cut by a side of the bounds of a text is not read: the words read end up to about this many line heights from it
const CUT_WORD_LINES = 3

// Image bytes of a rendered visual, for the OCR.
async function downloadImage (url) {
  const response = await fetchWithRetry(url)
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return Buffer.from(await response.arrayBuffer())
}

// Margin of an area read by the OCR: a share of its height, at least OCR_MIN_MARGIN_PX for OCR_MARGIN (in proportion for others)
const ocrMargin = (area, share) => Math.max(area.height * share, OCR_MIN_MARGIN_PX * share / OCR_MARGIN)

// Area read by the OCR: the text area with a margin (share of its height), inside the canvas.
function ocrRect (area, canvas, marginShare = OCR_MARGIN) {
  const margin = ocrMargin(area, marginShare)
  const left = Math.max(0, area.left - margin)
  const top = Math.max(0, area.top - margin)
  return {
    left,
    top,
    width: Math.min(canvas.width, area.left + area.width + margin) - left,
    height: Math.min(canvas.height, area.top + area.height + margin) - top
  }
}

// Visible layers of a manifest that are drawn, nested or not (groups and adjustment layers are not).
function drawnLayers (layers = []) {
  return layers.flatMap(layer => {
    if (layer.visible === false) return []
    const children = layer.children || layer.layers
    if (children?.length) return drawnLayers(children)
    return /group|section|adjustment/.test(layer.type || '') ? [] : [layer]
  })
}

// Common rectangle of two layer areas, null if none.
function intersection (a, b) {
  const left = Math.max(a.left, b.left)
  const top = Math.max(a.top, b.top)
  const width = Math.min(a.left + a.width, b.left + b.width) - left
  const height = Math.min(a.top + a.height, b.top + b.height) - top
  return width > 0 && height > 0 ? { left, top, width, height } : null
}

const surface = rect => rect ? rect.width * rect.height : 0

// Elements of the template that a rendered text overlaps more than in the template: other texts, images, shapes, logos...
// Layers are compared by their bounding boxes (a round logo counts as its box): only overlaps that appear or grow are
// reported, and not with the elements the text lies on in the template (a photo, a band, a panel), as they are by design (a
// text going out of the element it lies within is found by pastBounds and outOfBounds). Returns [{ name, factor, area }], factor being the
// font scale that removes the overlap, the text shrinking along the axis that needs the least, and area the common rectangle.
function findOverlaps (textArea, textBefore, edited, templateManifest, canvas) {
  const canvasSurface = canvas.width * canvas.height
  return drawnLayers(templateManifest.layers).flatMap(other => {
    if (other.id === edited) return []
    const otherBefore = layerArea(other)
    if (!otherBefore || surface(otherBefore) > canvasSurface * BACKGROUND_SHARE) return []
    const after = intersection(textArea, otherBefore)
    const before = textBefore ? surface(intersection(textBefore, otherBefore)) : 0
    if (textBefore && before >= surface(textBefore) * DESIGNED_OVERLAP_SHARE) return []
    const grown = surface(after) - before
    if (!after || grown <= surface(textArea) * OVERLAP_TOLERANCE) return []
    return [{
      name: other.name || String(other.id),
      factor: Math.max((textArea.width - after.width) / textArea.width, (textArea.height - after.height) / textArea.height),
      area: after
    }]
  })
}

// Text layers of a template that the OCR reads whole on its preview. For the others (e.g. a text over a photo, which the OCR
// cannot tell from it), words not read in a variant say nothing: they are not checked. Cached per template; null when the
// preview cannot be read, all texts are then checked.
const readableCache = createCache(20)
function readableTexts (params, templateUrl, manifest) {
  return readableCache(templateUrl, async () => {
    const started = Date.now()
    const canvas = boundsSize(manifest.document.bounds)
    const texts = getEditableLayers(manifest.layers).filter(layer => layer.type === 'text_layer' && layer.area)
    const preview = await downloadImage(await renderPreview(params, templateUrl))
    const checks = await checkTexts(preview, texts.map(layer => ({
      text: layer.text,
      rect: ocrRect(layer.area, canvas),
      lineHeight: layer.area.height / linesOf(layer.text).length
    })), canvas)
    const readable = new Set(texts.filter((layer, i) => checks[i] && !checks[i].missing.length && !checks[i].broken.length).map(layer => layer.id))
    console.log(`Template texts read in ${(Date.now() - started) / 1000}s: ${texts.map(layer => `"${layer.name}" ${readable.has(layer.id) ? 'readable' : 'not readable'}`).join(', ')}`)
    return readable
  }).catch(error => {
    console.warn(`Template texts not read: ${error.message}`)
    return null
  })
}

// Whether a box lies in an area of the template, with OCR_MARGIN.
function isInside (box, before) {
  const margin = ocrMargin(before, OCR_MARGIN)
  return box.left >= before.left - margin && box.top >= before.top - margin &&
    box.left + box.width <= before.left + before.width + margin && box.top + box.height <= before.top + before.height + margin
}

const longestLine = text => Math.max(1, ...linesOf(text).map(line => line.trim().length))

// Bounds a text must stay within: the smallest element of the template it lies within (a panel, a band), backgrounds left
// out, or the canvas. Returns { name, rect }, name null for the canvas.
function textBounds (before, templateManifest, canvas) {
  const margin = ocrMargin(before, OCR_MARGIN)
  const within = drawnLayers(templateManifest.layers)
    .filter(layer => layer.type !== 'text_layer')
    .map(layer => ({ name: layer.name, rect: layerArea(layer) }))
    .filter(({ rect }) => rect && surface(rect) <= canvas.width * canvas.height * BACKGROUND_SHARE &&
      before.left >= rect.left - margin && before.top >= rect.top - margin &&
      before.left + before.width <= rect.left + rect.width + margin && before.top + before.height <= rect.top + rect.height + margin)
    .sort((a, b) => surface(a.rect) - surface(b.rect))
  return within[0] || { name: null, rect: { left: 0, top: 0, width: canvas.width, height: canvas.height } }
}

// Area where a text is read on the visual: its area in the template with a margin, wider by the growth expected from its
// length and font scale, within its bounds (textBounds: little of what is out of them is read, so that a photo next to a panel
// is not read with the text) but for PAST_BOUNDS_READ_LINES on the sides, and not into the other texts on the same lines (the
// OCR mixes the lines of texts side by side).
function growthRect (t, bounds, otherTexts) {
  const { before } = t
  const ratio = longestLine(t.edit.text) / longestLine(t.original?.text?.content) * (t.edit.fontScale || 1)
  const grow = before.width * Math.max(GROWTH_READ_MIN, ratio - 1 + GROWTH_READ_MIN)
  const margin = ocrMargin(before, IN_PLACE_READ_MARGIN)
  const past = lineHeightOf(t) * PAST_BOUNDS_READ_LINES
  const top = Math.max(bounds.top, before.top - margin)
  const bottom = Math.min(bounds.top + bounds.height, before.top + before.height + margin)
  let left = Math.max(bounds.left - past, before.left - grow)
  let right = Math.min(bounds.left + bounds.width + past, before.left + before.width + grow)
  otherTexts.forEach(other => {
    if (other.top >= bottom || other.top + other.height <= top) return
    if (other.left >= before.left + before.width) right = Math.min(right, other.left)
    else if (other.left + other.width <= before.left) left = Math.max(left, other.left + other.width)
  })
  return { left, top, width: right - left, height: bottom - top }
}

// Expected height of the lines of a text: of its lines in the template, at its font scale.
const lineHeightOf = t => t.before.height / linesOf(t.original?.text?.content).length * (t.edit.fontScale || 1)

// Side of its bounds that the words read of a text (box) go past, by more than OCR_EDGE_PX, as measured: { side, overflow,
// factor, area, atLeast } (see outOfBounds), null if none; atLeast when they reach a side of the area read (read): the text
// goes on past it.
function pastBounds (box, bounds, read) {
  const right = box.left + box.width
  const boundsRight = bounds.left + bounds.width
  const boundsBottom = bounds.top + bounds.height
  const sides = [
    { side: 'right', overflow: right - boundsRight, factor: (boundsRight - box.left) / box.width, atLeast: right >= read.left + read.width - OCR_EDGE_PX },
    { side: 'left', overflow: bounds.left - box.left, factor: (right - bounds.left) / box.width, atLeast: box.left <= read.left + OCR_EDGE_PX },
    { side: 'bottom', overflow: box.top + box.height - boundsBottom, factor: (boundsBottom - box.top) / box.height, atLeast: false }
  ].filter(({ overflow }) => overflow > OCR_EDGE_PX)
  const side = sides.sort((a, b) => b.overflow - a.overflow)[0]
  return side ? { ...side, area: box } : null
}

// Where a text cut by its bounds (textBounds) would end, from its words read and the letters not read: words missing with the
// text read up to a side of its bounds (a word cut there is not read: within CUT_WORD_LINES line heights) go on past it,
// missing at the end of the text for the right side and the bottom, at its start for the left side. On several lines, each
// line read is as much wider as letters of its line of the text (lines) are not read. Returns { side, overflow, factor, area,
// cut: true } when it goes past by more than OCR_EDGE_PX, factor being the font scale at which it fits, area the whole text as
// estimated; null otherwise.
function outOfBounds (check, text, bounds) {
  const { box, missingAt, share } = check
  const shown = 1 - share
  if (!box || !shown || !missingAt) return null
  const textLines = linesOf(text)
  const near = Math.max(OCR_EDGE_PX, box.height / textLines.length * CUT_WORD_LINES)
  const right = bounds.left + bounds.width
  const bottom = bounds.top + bounds.height
  const letters = line => line.normalize('NFKD').replace(/[^\p{L}\p{N}]/gu, '').length
  // The right end of the text: line by line when its lines are read, otherwise from the share of its letters read
  const end = textLines.length > 1 && check.lines.length === textLines.length
    ? Math.max(...check.lines.map((line, i) => line.box.left + line.box.width * Math.max(1, letters(textLines[i]) / Math.max(1, line.letters))))
    : box.left + box.width / shown
  const width = end - box.left
  const height = textLines.length > 1 ? box.height / shown : box.height
  const sides = [
    missingAt !== 'start' && box.left + box.width >= right - near &&
      { side: 'right', overflow: end - right, factor: (right - box.left) / width, area: { ...box, width } },
    missingAt !== 'end' && box.left <= bounds.left + near &&
      { side: 'left', overflow: box.width / shown - (box.left + box.width - bounds.left), factor: (box.left + box.width - bounds.left) / (box.width / shown), area: { ...box, left: box.left + box.width - box.width / shown, width: box.width / shown } },
    missingAt === 'end' && textLines.length > 1 && check.lines.length < textLines.length && box.top + box.height >= bottom - near &&
      { side: 'bottom', overflow: box.top + height - bottom, factor: (bottom - box.top) / height, area: { ...box, height } }
  ]
  const side = sides.find(side => side && side.overflow > OCR_EDGE_PX)
  return side ? { ...side, cut: true } : null
}

// Part of a text area out of a side of its bounds, null if none.
function outsidePart (area, bounds, side) {
  const outside = { ...area }
  if (side === 'right') { outside.left = bounds.left + bounds.width; outside.width = area.left + area.width - outside.left }
  if (side === 'left') outside.width = bounds.left - area.left
  if (side === 'bottom') { outside.top = bounds.top + bounds.height; outside.height = area.top + area.height - outside.top }
  return outside.width > 0 && outside.height > 0 ? outside : null
}

// A rectangle in the logs: left,top,width,height
const rectText = rect => rect ? [rect.left, rect.top, rect.width, rect.height].map(Math.round).join(',') : 'none'

// Missing words, as shown to the user: "sellers", or "best sellers"
const quoteWords = words => `"${words.join(' ')}"`

// Problems of the edited texts of a rendered variant, one check per cause, on the visual. The OCR reads it around the area of
// each text in the template (growthRect), which gives the words read and where they are: a text read whole in its area and
// within its bounds fits; otherwise it goes out of its bounds (the element it lies within, or the canvas: pastBounds for the
// words read past them, outOfBounds for the words cut by them), overlaps other elements more than in the template (their
// areas in the template), or has words broken across lines or missing (cut, hidden or unreadable; only when no edge or
// overlap explains it). A text that only grows is not a problem: what it may cause is checked. The texts that the OCR cannot read in the
// template (see readableTexts) are not checked. One entry per text with problems, with the font scale that brings it back in
// its bounds (rounded down to 5%, not below MIN_FONT_SCALE, then marked as not enough), its area and the rectangles of its
// overlaps. Best effort: returns { issues, unchecked }, issues being null when the texts could not be checked, and unchecked
// what could not be checked and why.
async function measureRenderedTexts (imageUrl, templateManifest, layers, language, deadline, readable) {
  const textLayers = layers.filter(layer => layer.type === 'text_layer')
  if (!textLayers.length) return { issues: [], unchecked: null }
  try {
    const canvas = boundsSize(templateManifest.document.bounds)
    // Downloaded while the readable texts are awaited; its error is reported with the reading
    const image = downloadImage(imageUrl)
    image.catch(() => {})
    const texts = textLayers.map(edit => {
      const original = findLayer(templateManifest.layers, edit.id)
      return { edit, original, before: original && layerArea(original) }
    })
    const notes = []
    // Texts that the OCR can read (see readableTexts)
    const readableIds = await beforeDeadline(readable || Promise.resolve(null), deadline - OCR_DEADLINE_MARGIN_MS, () => null)
    const isReadable = t => t.before && (!readableIds || readableIds.has(t.edit.id))
    const allTexts = drawnLayers(templateManifest.layers).filter(layer => layer.type === 'text_layer')
    const measured = texts.filter(isReadable).map(t => {
      const bounds = textBounds(t.before, templateManifest, canvas)
      const otherTexts = allTexts.filter(layer => layer.id !== t.edit.id).map(layerArea).filter(Boolean)
      return { ...t, bounds, read: growthRect(t, bounds.rect, otherTexts) }
    })
    const unreadable = texts.filter(t => !isReadable(t)).map(t => `"${t.original?.name || t.edit.id}"`)
    if (unreadable.length) {
      notes.push(`${unreadable.join(', ')} not checked: the OCR cannot read ${unreadable.length > 1 ? 'them' : 'it'} in the template either (e.g. over a photo)`)
    }

    const checks = measured.length
      ? await beforeDeadline(
        image.then(visual => checkTexts(visual, measured.map(t => ({
          text: t.edit.text,
          rect: t.read,
          near: { x: t.before.left + t.before.width / 2, y: t.before.top + t.before.height / 2 },
          language,
          lineHeight: lineHeightOf(t)
        })), canvas)).catch(error => { notes.push(`words not read: ${error.message}`); return [] }),
        deadline - OCR_DEADLINE_MARGIN_MS, () => { notes.push('words not read: not finished within the time limit'); return [] })
      : []

    const issues = measured.flatMap((t, i) => {
      const check = checks[i]
      if (!check) return []
      console.log(`Text check: "${t.original?.name}" read "${check.read}" at ${rectText(check.box)}, within ` +
        `"${t.bounds.name || 'canvas'}" ${rectText(t.bounds.rect)}, area read ${rectText(t.read)}`)
      const past = check.box && pastBounds(check.box, t.bounds.rect, t.read)
      // In place: read whole in its area of the template, and not out of its bounds
      if (!check.missing.length && !check.broken.length && check.box && !past && isInside(check.box, t.before)) return []
      const problems = []
      // Factors by which the text must shrink to fix each problem
      const factors = []
      // Rectangles of the overlaps in the canvas, for the view
      const marks = []
      let box = check.box
      if (box) {
        // Words cut by a side of its bounds, or words read past it
        const out = (check.missing.length && outOfBounds(check, t.edit.text, t.bounds.rect)) || past
        if (out) {
          const where = t.bounds.name ? `out of "${t.bounds.name}" on the ${out.side}` : `past the ${out.side} edge of the visual`
          const cut = out.cut ? `: ${quoteWords(check.missing)} cut` : ''
          problems.push(`runs ${out.atLeast ? 'at least' : 'about'} ${Math.round(out.overflow)} px ${where}${cut}`)
          factors.push(out.factor)
          // The whole text as estimated, and the part out of its bounds
          box = intersection(out.area, { left: 0, top: 0, width: canvas.width, height: canvas.height }) || box
          const outside = outsidePart(box, t.bounds.rect, out.side)
          if (outside) marks.push(outside)
        }
        findOverlaps(box, t.before, t.edit.id, templateManifest, canvas).forEach(overlap => {
          problems.push(`now overlaps "${overlap.name}"`)
          factors.push(overlap.factor)
          marks.push(overlap.area)
        })
      }
      // Words broken or missing, when no edge or overlap explains them
      if (!problems.length) {
        check.broken.forEach(({ word, fit }) => {
          problems.push(`breaks "${word}" across two lines: its text box is too narrow for this word`)
          factors.push(fit)
        })
        if (check.missing.length) {
          problems.push(check.share === 1
            ? 'cannot be read in the visual (cut, hidden or low contrast)'
            : `${quoteWords(check.missing)} cannot be read in the visual (cut, hidden or low contrast)`)
          // A smaller text shows the words cut by its box
          factors.push(Math.sqrt(1 - check.share))
        }
      }
      if (!problems.length) return []
      const needed = Math.floor((t.edit.fontScale || 1) * Math.min(...factors) * 20) / 20
      return [{
        layerId: t.edit.id,
        layerName: t.original?.name || String(t.edit.id),
        problems,
        fontScale: Math.max(needed, MIN_FONT_SCALE),
        // A smaller font is not enough: the text should be shortened
        shorten: needed < MIN_FONT_SCALE,
        area: box || t.before,
        marks
      }]
    })
    return { issues, unchecked: notes.join('; ') || null }
  } catch (error) {
    console.warn(`Text check failed: ${error.message}`)
    return { issues: null, unchecked: error.message }
  }
}

// Text problems of one variant, for the model.
function describeTextIssues (label, issues, unchecked) {
  if (issues == null) return `${label}: texts could not be measured (${unchecked}): check the visual.`
  const note = unchecked ? ` (${unchecked})` : ''
  if (!issues.length) return `${label}: all texts fit${note}.`
  return `${label}: ` + issues.map(issue => `"${issue.layerName}" ${issue.problems.join(', ')} (proposed to the user: font size ` +
    `${Math.round(issue.fontScale * 100)}%${issue.shorten ? ', or a shorter text' : ''})`).join('; ') + note + '.'
}

// Character style attributes kept from the template when the font size of a text is scaled. The manifest describes the font
// and color with more fields than an edit accepts (e.g. font.isAvailable): only these are passed again.
const KEPT_STYLE_ATTRIBUTES = ['autoLeading', 'letterSpacing', 'syntheticBold', 'syntheticItalic', 'capsOption']
const COLOR_MODELS = ['rgb', 'cmyk', 'lab', 'gray']

const isScaled = layer => layer.type === 'text_layer' && layer.fontScale != null && layer.fontScale !== 1

// The API cannot scale a text: text edits with a font scale get the character style of their layer in the template, with its
// font size (and line height) scaled, for the whole text. The other attributes are passed again, as a partial style may
// reset them. Takes and returns the layer edits of one variant.
function applyFontScales (manifest, layers) {
  return layers.map(layer => {
    if (!isScaled(layer)) return layer
    const first = findLayer(manifest.layers, layer.id)?.text?.characterStyles?.[0]
    const style = first?.characterStyle || first
    if (!style?.fontSize) throw new Error(`The font size of layer ${layer.id} is not known, it cannot be scaled.`)
    const characterStyle = { fontSize: style.fontSize * layer.fontScale }
    KEPT_STYLE_ATTRIBUTES.forEach(name => { if (style[name] != null) characterStyle[name] = style[name] })
    if (style.font?.postScriptName) characterStyle.font = { postScriptName: style.font.postScriptName }
    const colorModel = COLOR_MODELS.find(model => style.fontColor?.[model])
    if (colorModel) characterStyle.fontColor = { [colorModel]: style.fontColor[colorModel] }
    if (style.lineHeight && !style.autoLeading) characterStyle.lineHeight = style.lineHeight * layer.fontScale
    return { ...layer, characterStyle }
  })
}

// Edits of layers that are not in the template, or not of the same type, fail in the Photoshop API with a less clear error.
function checkLayerEdits (manifest, layers) {
  const seen = new Set()
  layers.forEach(layer => {
    const original = findLayer(manifest.layers, layer.id)
    if (!original) throw new Error(`Layer ${layer.id} is not in the template: use the layer ids of get-psd-manifest.`)
    if (original.type !== layer.type) throw new Error(`Layer ${layer.id} ("${original.name}") is a ${original.type}, not a ${layer.type}.`)
    if (seen.has(layer.id)) throw new Error(`Layer ${layer.id} ("${original.name}") is edited twice.`)
    seen.add(layer.id)
  })
}

// Layer of a manifest, nested or not, by id or by a predicate.
function findLayer (layers = [], id) {
  const matches = typeof id === 'function' ? id : layer => layer.id === id
  for (const layer of layers) {
    if (matches(layer)) return layer
    const nested = findLayer(layer.children || layer.layers, matches)
    if (nested) return nested
  }
  return null
}

function boundsSize (bounds) {
  return { width: bounds.right - bounds.left, height: bounds.bottom - bounds.top }
}

// Subject detection with the Firefly Services auto-crop API (smartCrop mode). It only supports preset aspect
// ratios and reports coordinates on a copy of the image whose shorter side is at most 2000 px.
const AUTO_CROP_API = 'https://image.adobe.io/v1/auto-crop'
const AUTO_CROP_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4', '4:5', '5:4', '3:2', '2:3', '21:9']
const AUTO_CROP_MAX_SHORT_SIDE = 2000

function closestAutoCropRatio (ratio) {
  const distance = r => { const [w, h] = r.split(':').map(Number); return Math.abs(Math.log(w / h / ratio)) }
  return AUTO_CROP_RATIOS.reduce((best, r) => distance(r) < distance(best) ? r : best)
}

// Returns the box auto-crop suggests around the subject, in auto-crop coordinates (see toImageCoordinates).
function detectSubjectBox (params, imageUrl, ratio) {
  return limitJob(async () => {
    const { statusUrl } = await callFirefly(params, 'auto-crop', AUTO_CROP_API, {
      method: 'POST',
      body: JSON.stringify({ image: { source: { url: imageUrl } }, mode: 'smartCrop', aspectRatio: closestAutoCropRatio(ratio) })
    })
    if (!statusUrl) throw new Error('auto-crop: no status URL in the answer')
    return pollJob(async () => {
      const status = await callFirefly(params, 'auto-crop', statusUrl)
      if (status.status === 'failed') throw new Error(`auto-crop failed: ${JSON.stringify(status)}`)
      if (status.status === 'succeeded') return status.output?.crops?.[0]?.boundingBoxes?.[0] || null
    }, 'auto-crop')
  })
}

function toImageCoordinates (box, image) {
  const scale = Math.min(1, AUTO_CROP_MAX_SHORT_SIDE / Math.min(image.width, image.height))
  return { left: box.x / scale, top: box.y / scale, width: box.width / scale, height: box.height / scale }
}

// Crop bounds at the given ratio: the smallest rectangle containing the subject box (or the largest
// centered one without subject), kept inside the image.
function cropBounds (image, ratio, subject) {
  let width = subject ? Math.max(subject.width, subject.height * ratio) : image.width
  if (width > image.width) width = image.width
  let height = width / ratio
  if (height > image.height) {
    height = image.height
    width = height * ratio
  }
  const centerX = subject ? subject.left + subject.width / 2 : image.width / 2
  const centerY = subject ? subject.top + subject.height / 2 : image.height / 2
  const left = Math.round(Math.min(Math.max(centerX - width / 2, 0), image.width - width))
  const top = Math.round(Math.min(Math.max(centerY - height / 2, 0), image.height - height))
  return { left, top, right: left + Math.round(width), bottom: top + Math.round(height) }
}

// Suggested crop of an image for a frame ratio, framed on the subject detected by auto-crop (centered if none, or if the
// detection does not finish by the deadline).
async function suggestCrop (params, imageUrl, ratio, deadline) {
  const [manifest, subject] = await Promise.all([
    beforeDeadline(getManifest(params, imageUrl), deadline, tooLate('Reading the image')),
    beforeDeadline(detectSubjectBox(params, imageUrl, ratio).catch(() => null), deadline, () => null)
  ])
  const image = boundsSize(manifest.document.bounds)
  return { image, crop: cropBounds(image, ratio, subject && toImageCoordinates(subject, image)), subjectDetected: Boolean(subject) }
}

// Crops an image to the given pixel bounds with Photoshop; returns the URL of the cropped image.
async function cropImage (params, imageUrl, bounds) {
  const isPng = /\.png(\?|$)/i.test(new URL(imageUrl).pathname)
  const { uploadUrl, readUrl } = await createStorageUrls('crops', isPng ? 'crop.png' : 'crop.jpg')
  await runPhotoshopJob(params, '/create-composite', {
    image: { source: { url: imageUrl } },
    edits: { document: { crop: { bounds } } },
    outputs: [{ destination: { url: uploadUrl }, ...(isPng ? { mediaType: 'image/png', compression: 'medium' } : { mediaType: 'image/jpeg', quality: 'photoshop_max' }) }]
  })
  return readUrl
}

// Centered crop of an image to the ratio of a frame, for images without a crop chosen in upload-variant-images.
async function cropToFrameCenter (params, imageUrl, frame) {
  const ratio = frame.width / frame.height
  const image = boundsSize((await getManifest(params, imageUrl)).document.bounds)
  if (Math.abs(image.width / image.height - ratio) < 0.01) return imageUrl
  return cropImage(params, imageUrl, cropBounds(image, ratio, null))
}

// Crops a smart object image so that Photoshop's default "fit" placement fills its frame exactly: with the crop chosen by the
// user when given, otherwise centered (unless fit is "fit"). Crops are cached: one done for several variants, or in an earlier
// call, is not done again.
function cropLayerImage (params, manifest, layer) {
  if (layer.type !== 'smart_object_layer' || !(layer.crop || layer.fit !== 'fit')) return layer
  const frame = layer.crop ? null : findLayer(manifest.layers, layer.id)?.referenceFrame
  if (!layer.crop && !frame) return layer
  const key = `${layer.imageUrl}|${JSON.stringify(layer.crop || boundsSize(frame))}`
  return cropCache(key, () => layer.crop
    ? cropImage(params, layer.imageUrl, layer.crop)
    : cropToFrameCenter(params, layer.imageUrl, boundsSize(frame)))
    .then(imageUrl => ({ ...layer, imageUrl }))
}

// Layer edits of a variant ready for the render: checked against the template, with font scales applied and images cropped.
async function prepareLayers (params, manifest, layers) {
  checkLayerEdits(manifest, layers)
  const wrapped = layers.map(layer => wrapText(manifest, layer))
  return Promise.all(applyFontScales(manifest, wrapped).map(layer => cropLayerImage(params, manifest, layer)))
}

const linesOf = text => String(text || '').split(/\r\n|\r|\n/)

// A text written without line breaks for a template text on several lines is spread over as many lines, so that it keeps the
// layout: a point text only breaks lines where its text does. Texts with line breaks are kept as written.
function wrapText (manifest, layer) {
  if (layer.type !== 'text_layer' || linesOf(layer.text).length > 1) return layer
  const count = linesOf(findLayer(manifest.layers, layer.id)?.text?.content).length
  return count > 1 ? { ...layer, text: balanceLines(layer.text, count) } : layer
}

// Words of a text, with the signs written apart kept with their word: "50 %", "Vite !", "« Bonjour »"
function wordsWithSigns (text) {
  const isSign = token => !/[\p{L}\p{N}]/u.test(token)
  return text.trim().split(/\s+/).reduce((words, token, i, tokens) => {
    const previous = tokens[i - 1]
    if (previous && isSign(previous) && /[«“‘(¿¡]$/.test(previous)) words[words.length - 1] += ' ' + token
    else if (words.length && isSign(token) && !/^[«“‘(¿¡]/.test(token)) words[words.length - 1] += ' ' + token
    else words.push(token)
    return words
  }, [])
}

// Words of a text spread over count lines (fewer for fewer words) with the shortest longest line, without breaking words.
function balanceLines (text, count) {
  const words = wordsWithSigns(text)
  const lines = Math.min(count, words.length)
  if (lines < 2) return text
  const lineLength = (from, to) => words.slice(from, to).join(' ').length
  // best[k][i]: { longest, start } for the first i words on k lines, start being the first word of the last line
  const best = [[{ longest: 0 }]]
  for (let k = 1; k <= lines; k++) {
    best[k] = []
    for (let i = k; i <= words.length; i++) {
      for (let start = k - 1; start < i; start++) {
        const before = best[k - 1][start]
        if (!before) continue
        const longest = Math.max(before.longest, lineLength(start, i))
        if (!best[k][i] || longest < best[k][i].longest) best[k][i] = { longest, start }
      }
    }
  }
  const result = []
  for (let k = lines, end = words.length; k > 0; k--) {
    const { start } = best[k][end]
    result.unshift(words.slice(start, end).join(' '))
    end = start
  }
  return result.join('\n')
}

// File names of the variants without extension, made unique (a second "summer" becomes "summer-2").
function uniqueFileNames (variants) {
  const used = new Set()
  return variants.map((variant, index) => {
    const base = String(variant.fileName || '').replace(/\.(png|jpe?g|psd)$/i, '').trim() || `variant-${index + 1}`
    let name = base
    for (let n = 2; used.has(name); n++) name = `${base}-${n}`
    used.add(name)
    return name
  })
}

// Runs each variant on its own, in parallel: its crops, then its render as soon as they are done, in its own formats or the
// formats of the call. A failed or late variant does not prevent the others from being returned. onProgress(list) gets the
// variants each time one changes: { fileName, pending: true } until rendered, then with checking: true until its texts are
// checked, then as returned.
async function createVariants (params, { templateUrl, formats, variants, deadline, onProgress }) {
  const fileNames = uniqueFileNames(variants)
  const progress = fileNames.map(fileName => ({ fileName, pending: true }))
  const report = (index, variant) => { progress[index] = variant; onProgress?.([...progress]) }
  // The OCR engine loads during the renders
  const hasTexts = variants.some(variant => variant.layers.some(layer => layer.type === 'text_layer'))
  // Language of the texts of each variant, as given or guessed from them
  const languages = variants.map(variant => variant.language ||
    guessLanguage(variant.layers.filter(layer => layer.type === 'text_layer').map(layer => layer.text).join('\n')))
  if (hasTexts) {
    warmUpOcr(languages)
    // Needed to read the texts of the template (readableTexts), rendered during the reading of the template
    renderPreview(params, templateUrl).catch(() => {})
  }
  // The crops chosen by the user do not need the template: started during its reading, prepareLayers then gets them cached
  variants.forEach(variant => variant.layers
    .filter(layer => layer.type === 'smart_object_layer' && layer.crop)
    .forEach(layer => Promise.resolve(cropLayerImage(params, null, layer)).catch(() => {})))
  const templateManifest = beforeDeadline(getManifest(params, templateUrl), deadline, tooLate('Reading the template'))
  // Read once for all variants, during the renders
  const readable = hasTexts ? templateManifest.then(manifest => readableTexts(params, templateUrl, manifest), () => null) : null
  // Time of each step of each variant (seconds since the start), logged when all are done
  const started = Date.now()
  const timings = fileNames.map(() => ({}))
  const mark = (index, step) => { timings[index][step] = Math.round((Date.now() - started) / 100) / 10 }
  const results = await Promise.all(variants.map(async (variant, index) => {
    try {
      const manifest = await templateManifest
      mark(index, 'template')
      const layers = await beforeDeadline(prepareLayers(params, manifest, variant.layers), deadline, tooLate('Cropping the images'))
      mark(index, 'crops')
      const result = await createVariant(params, {
        templateUrl,
        templateManifest: manifest,
        deadline,
        formats: variant.formats ? [...new Set(variant.formats)] : formats,
        layers,
        language: languages[index],
        fileName: fileNames[index],
        onRendered: rendered => { mark(index, 'render'); report(index, { ...rendered, checking: true }) },
        readable
      })
      mark(index, 'checks')
      report(index, result)
      return result
    } catch (error) {
      mark(index, 'failed')
      const failed = { fileName: fileNames[index], error: error.message }
      report(index, failed)
      return failed
    }
  }))
  console.log(`Variants, seconds since the start: ${fileNames.map((name, i) => `${name} ${JSON.stringify(timings[i])}`).join('; ')}`)
  return results
}

// Smart object layers that get the same image in several variants: usually a mix-up in the image mapping.
function findSharedImages (variants) {
  const byLayerAndUrl = new Map()
  variants.forEach((variant, index) => variant.layers
    .filter(layer => layer.type === 'smart_object_layer')
    .forEach(layer => {
      const key = `${layer.id}|${layer.imageUrl}`
      byLayerAndUrl.set(key, [...(byLayerAndUrl.get(key) || []), variant.fileName || `variant ${index + 1}`])
    }))
  return [...byLayerAndUrl.entries()].filter(([, names]) => names.length > 1)
    .map(([key, names]) => ({ layerId: Number(key.split('|')[0]), variants: names }))
}

// Results of the widgets, stored for 24 hours under a short random reference and readable only by the user who created
// them. The key includes a hash of the user id: short references of different users never overwrite each other.
function widgetResultKey (userId, ref) {
  return `widget-result-${crypto.createHash('sha256').update(String(userId)).digest('hex').slice(0, 16)}-${ref}`
}

function currentUserId (params) {
  return getUnverifiedClaims(getTokenFromRequest(params)).user_id
}

const shortHash = value => crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 16)

// Text problems of the generated variants, for the model: nothing when there are no text layers or all texts fit.
function describeGeneratedTexts (results) {
  const measured = results.filter(v => !v.error && v.textIssues !== undefined)
  if (!measured.some(v => v.textIssues == null || v.textIssues.length || v.textsUnchecked)) {
    return measured.length ? '\nTexts measured on the generated files: all texts fit.' : ''
  }
  return '\n\nTexts measured on the generated files:\n' + measured.map(v => describeTextIssues(v.fileName, v.textIssues, v.textsUnchecked)).join('\n') +
    '\nThe widget marks these problems on the visuals with the fixes proposed, and sends you the changes the user wants: do not list ' +
    'them in chat, and do not apply a fix the user did not ask for.'
}

async function saveWidgetResult (params, text) {
  const ref = 'r' + Array.from({ length: 6 }, () => REF_ALPHABET[crypto.randomInt(REF_ALPHABET.length)]).join('')
  const userId = currentUserId(params)
  const state = await initState()
  await state.put(widgetResultKey(userId, ref), { userId, text }, { ttl: WIDGET_RESULT_TTL_SECONDS })
  return ref
}

async function readWidgetResult (params, ref) {
  if (!WIDGET_RESULT_REF.test(ref)) return null
  const userId = currentUserId(params)
  const state = await initState()
  const stored = (await state.get(widgetResultKey(userId, ref)))?.value
  return stored && stored.userId === userId ? stored.text : null
}

// Long operations run as tasks, each in its own activation of this action, invoked without waiting for it: a task has the
// action timeout (5 minutes) whatever the time limit of web requests (about 60 seconds), and goes on whichever container
// answers the next requests. The tool that starts a task answers at once with its id; the views poll get-task, which reads
// its progress and result in App Builder state.
const TASK_TTL_SECONDS = 24 * 3600
// Time a task gives its jobs, within the action timeout
const TASK_BUDGET_MS = 270000
// A task still running after this long has stopped (e.g. the activation was ended)
const TASK_STALE_MS = 330000
const TASK_ID = /^[0-9a-f-]{36}$/

const taskKey = (userId, taskId) => `task-${shortHash(userId)}-${taskId}`

// Signature of the task invocations: only this action, which holds the secret, can start a task. The task is passed and signed
// as JSON text, as Runtime does not keep the order of the keys of an object parameter.
const signTask = (params, taskJson) =>
  crypto.createHmac('sha256', String(params.FIREFLY_SERVICES_API_CLIENT_SECRET)).update(taskJson).digest('hex')

// Starts a task of the current user; returns its id.
async function startTask (params, type, args) {
  const task = { id: crypto.randomUUID(), type, args, userId: currentUserId(params) }
  const state = await initState()
  await state.put(taskKey(task.userId, task.id), { status: 'running', startedAt: Date.now() }, { ttl: TASK_TTL_SECONDS })
  const [namespace, ...action] = (process.env.__OW_ACTION_NAME || '').split('/').filter(Boolean)
  const response = await fetchWithRetry(`${process.env.__OW_API_HOST}/api/v1/namespaces/${namespace}/actions/${action.join('/')}?blocking=false`, {
    method: 'POST',
    headers: { Authorization: `Basic ${Buffer.from(String(process.env.__OW_API_KEY)).toString('base64')}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ __task: JSON.stringify(task), __taskSignature: signTask(params, JSON.stringify(task)) })
  })
  await response.body?.cancel().catch(() => {})
  if (!response.ok) throw new Error(`The task could not be started (HTTP ${response.status})`)
  return task.id
}

// Writes the state of a task: each update is merged into the last one, and written after the previous writes.
function taskWriter (task) {
  let current = { status: 'running', startedAt: Date.now() }
  let writes = Promise.resolve()
  return patch => {
    current = { ...current, ...patch, updatedAt: Date.now() }
    const value = current
    writes = writes
      .then(async () => (await initState()).put(taskKey(task.userId, task.id), value, { ttl: TASK_TTL_SECONDS }))
      .catch(error => console.warn(`Task ${task.id} not written: ${error.message}`))
    return writes
  }
}

// What get-psd-manifest shows of a template: its title, size and editable layers.
function templateData (manifest) {
  return {
    document: {
      // Strip the upload timestamp prefix and the job id suffix added by the storage and the Photoshop API
      title: manifest.document?.title?.replace(/^\d+-([0-9a-f]{8}-)?/, '').replace(/_[0-9a-f-]{36}(\.\w+)$/, '$1'),
      width: manifest.document?.bounds?.right,
      height: manifest.document?.bounds?.bottom
    },
    layers: getEditableLayers(manifest.layers)
  }
}

// Text of the result of a generation, for the model: failures, warnings and text problems.
function describeGeneration (results, warnings) {
  const failed = results.filter(v => v.error)
  return `${results.length - failed.length}/${results.length} variant(s) generated and shown to the user with download buttons.` +
    failed.map(v => `\n- ${v.fileName} failed: ${v.error}`).join('') + warnings + describeGeneratedTexts(results)
}

// Tasks by type: (params, task, update, deadline) → result. update({ partial }) gives the views what is ready.
const TASKS = {
  // Manifest of a template (given as soon as read) and its preview
  async template (params, { args }, update) {
    let previewError = null
    const preview = renderPreview(params, args.url).catch(error => { previewError = error.message; return null })
    const data = templateData(await getManifest(params, args.url))
    await update({ partial: data })
    const previewUrl = await preview
    return { ...data, previewUrl, previewError }
  },

  // Size of an image and a crop framed on its subject
  async crop (params, { args }, update, deadline) {
    return suggestCrop(params, args.imageUrl, args.ratio, deadline)
  },

  // Variants, shown as they are rendered
  async variants (params, { args }, update, deadline) {
    const variants = await createVariants(params, {
      templateUrl: args.templateUrl,
      formats: args.formats,
      variants: args.variants,
      deadline,
      onProgress: list => update({ partial: { templateUrl: args.templateUrl, variants: list } })
    })
    return { templateUrl: args.templateUrl, variants, summary: describeGeneration(variants, args.warnings || '') }
  },

  // ZIP archive of the files of a generation
  async zip (params, { args, userId }) {
    return zipGeneration(userId, args.variantsTaskId)
  },

  // Files of a generation sent to an AEM folder
  async aem (params, { args, userId }) {
    return sendGenerationToAem(params, userId, args)
  }
}

// Files of a generation zipped together: at most this many bytes, held in memory
const MAX_ZIP_BYTES = 400 * 1024 * 1024

// Files of a done generation (task variants) of a user: [{ format, fileName, url }].
async function generationFiles (userId, variantsTaskId) {
  const generation = (await (await initState()).get(taskKey(userId, variantsTaskId)))?.value
  if (generation?.status !== 'done') throw new Error('The generation is not done, or expired (24 hours).')
  const files = (generation.result?.variants || []).filter(v => !v.error).flatMap(v => v.files || [])
  if (!files.length) throw new Error('No file generated.')
  return files
}

async function downloadFile (file) {
  const response = await fetchWithRetry(file.url)
  if (!response.ok) throw new Error(`${file.fileName} could not be downloaded (HTTP ${response.status})`)
  return Buffer.from(await response.arrayBuffer())
}

// Files of a generation sent to AEM at a time
const AEM_UPLOAD_CONCURRENCY = 3

// Sends the files of a generation to an AEM folder: { folder, sent: [file names], failed: [{ fileName, error }] }.
async function sendGenerationToAem (params, userId, { variantsTaskId, repositoryId, path, token }) {
  const folderUrl = getAemFolderUrl(requireAemConfig(params), { repositoryId, path })
  const files = await generationFiles(userId, variantsTaskId)
  // The token is of the sign-in with AEM_CLIENT_ID, its API key
  const headers = { Authorization: `Bearer ${token}`, 'X-Api-Key': getUnverifiedClientId(token) }
  const sent = []
  const failed = []
  const queue = [...files]
  await Promise.all(Array.from({ length: AEM_UPLOAD_CONCURRENCY }, async () => {
    for (let file = queue.shift(); file; file = queue.shift()) {
      try {
        await uploadToAem(folderUrl, { fileName: file.fileName, data: await downloadFile(file) }, headers)
        sent.push(file.fileName)
      } catch (error) {
        failed.push({ fileName: file.fileName, error: error.message })
      }
    }
  }))
  console.log(`Sent to AEM ${folderUrl.pathname}: ${sent.length} file(s), ${failed.length} failed${failed.length ? ` (${failed[0].error})` : ''}`)
  return { folder: decodeURIComponent(folderUrl.pathname), sent, failed }
}

// ZIP archive of the files of a done generation (task variants) of the user of the task: { fileName, url, count }.
async function zipGeneration (userId, variantsTaskId) {
  const files = await generationFiles(userId, variantsTaskId)
  let total = 0
  const entries = await Promise.all(files.map(async file => {
    const data = await downloadFile(file)
    total += data.length
    if (total > MAX_ZIP_BYTES) throw new Error('The files are too large to be zipped together: download them one by one.')
    return { name: file.fileName, data }
  }))
  const fileName = 'variants.zip'
  const storage = await initFiles()
  const path = newStoragePath('variants', fileName)
  await storage.write(path, zipFiles(entries))
  return { fileName, count: entries.length, url: await storage.generatePresignURL(path, { expiryInSeconds: URL_EXPIRY_SECONDS, permissions: 'r' }) }
}

// Runs a task invoked by startTask (not a web request), and writes its result or error.
async function runTask (params) {
  if (params.__ow_method) return { error: 'A task cannot come from a web request' }
  const expected = Buffer.from(signTask(params, String(params.__task)))
  const signature = Buffer.from(String(params.__taskSignature || ''))
  if (signature.length !== expected.length || !crypto.timingSafeEqual(signature, expected)) return { error: 'Invalid task signature' }
  const task = JSON.parse(params.__task)
  if (!TASKS[task.type]) return { error: 'Unknown task type' }
  const update = taskWriter(task)
  const started = Date.now()
  try {
    const result = await TASKS[task.type](params, task, update, started + TASK_BUDGET_MS)
    console.log(`Task ${task.type} ${task.id} done in ${(Date.now() - started) / 1000}s`)
    await update({ status: 'done', result, partial: null })
  } catch (error) {
    console.warn(`Task ${task.type} failed: ${error.message}`)
    await update({ status: 'failed', error: error.message })
  }
  return { done: task.id }
}

// State of a task of the current user, null if none (expired, or of another user).
async function readTask (params, taskId) {
  if (!TASK_ID.test(String(taskId))) return null
  const state = await initState()
  const task = (await state.get(taskKey(currentUserId(params), taskId)))?.value
  if (task?.status === 'running' && Date.now() - task.startedAt > TASK_STALE_MS) {
    return { ...task, status: 'failed', error: 'The task stopped before the end: start it again.' }
  }
  return task || null
}

// Waits for the partial or final result of a task, up to the deadline (polling its state); null if not ready by then.
async function awaitTask (params, taskId, deadline, ready) {
  while (Date.now() < deadline) {
    const task = await readTask(params, taskId)
    if (task?.status === 'failed') throw new Error(task.error)
    const data = ready(task)
    if (data) return data
    await wait(TASK_AWAIT_POLL_MS)
  }
  return null
}
const TASK_AWAIT_POLL_MS = 1000

// Tool result with structured content, also given as JSON text for clients without structured content.
function jsonResult (data) {
  return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data }
}

function errorResult (error) {
  return { isError: true, content: [{ type: 'text', text: error.message }] }
}

function uiMeta (view) {
  return { ui: { resourceUri: view.uri }, 'ui/resourceUri': view.uri }
}

const layerEditSchema = z.discriminatedUnion('type', [
  z.object({
    id: z.number().int().describe('Layer id from get-psd-manifest'),
    type: z.literal('text_layer'),
    text: z.string().describe('New text content'),
    fontScale: z.number().min(0.5).max(1.5).optional().describe('Font size relative to the template, e.g. 0.9 for 10% smaller (default 1)')
  }),
  z.object({
    id: z.number().int().describe('Layer id from get-psd-manifest'),
    type: z.literal('smart_object_layer'),
    imageUrl: z.string().url().describe('HTTPS URL of the replacement image (e.g. from upload-variant-images)'),
    crop: z.object({ left: z.number(), top: z.number(), right: z.number(), bottom: z.number() }).optional()
      .describe('Crop of the image in pixels, as chosen by the user in upload-variant-images: pass it as is'),
    fit: z.enum(['fill', 'fit']).default('fill')
      .describe('Without crop: "fill" (default) crops the image, centered, to the frame ratio so it fills the frame; "fit" keeps the whole image, which may leave empty bands')
  })
])

function registerTools (server, params) {
  server.registerTool(
    'start-variant-creation',
    {
      title: 'Start Variant Creation',
      description: 'Entry point to create variants, versions, adaptations or localizations of a banner, ad, visual, social post or any ' +
        'Photoshop (PSD) template. Call it FIRST whenever the user wants variants, before asking for any file: it shows a widget where ' +
        'the user sets the number of variants and uploads the layered PSD template. Its result describes the full workflow to follow.',
      inputSchema: {
        variantCount: z.number().int().min(1).max(MAX_VARIANTS).optional().describe('Number of variants, if the user already said it')
      },
      _meta: uiMeta(VIEWS.start)
    },
    async () => ({
      content: [{ type: 'text', text: `Start widget displayed: wait for the user to set the number of variants, upload the PSD template and continue.\n\n${WORKFLOW}` }]
    })
  )

  server.registerTool(
    'get-psd-manifest',
    {
      title: 'Get PSD Manifest',
      description: 'Step 2 of the variant workflow. Reads a Photoshop PSD template with the Photoshop API and shows the user its ' +
        'unlocked text and smart object layers, so they can pick the layers to vary (their choice is added to your context). ' +
        'Call it right after the template is uploaded with start-variant-creation, with the template URL. ' +
        'After the user\'s selection, go to step 3: ask for the texts of the selected text layers.',
      inputSchema: { url: z.string().url().describe('HTTPS URL of the PSD file') },
      _meta: uiMeta(VIEWS.layers)
    },
    async ({ url }) => {
      try {
        const taskId = await startTask(params, 'template', { url })
        // The model needs the layers: they are waited for here, the preview is waited for by the view
        const ready = await awaitTask(params, taskId, Date.now() + RESPONSE_BUDGET_MS,
          task => task?.status === 'done' ? task.result : task?.partial)
        if (!ready) {
          return {
            content: [{
              type: 'text',
              text: 'The template is still being read: the widget shows its layers when ready. Wait for the user\'s selection, which gives ' +
                'you the selected layers with their original texts and frames.\n\n' + NEXT_STEPS_AFTER_SELECTION
            }],
            structuredContent: { taskId, templateUrl: url }
          }
        }
        // The preview URL and the layer areas are for the view only
        const forModel = { document: ready.document, layers: ready.layers.map(({ area, ...layer }) => layer) }
        return {
          content: [{
            type: 'text',
            text: `Editable layers (unlocked text and smart object layers), shown to the user for selection:\n${JSON.stringify(forModel, null, 2)}\n\n` +
              NEXT_STEPS_AFTER_SELECTION
          }],
          structuredContent: { ...ready, taskId, templateUrl: url }
        }
      } catch (error) {
        return errorResult(error)
      }
    }
  )

  server.registerTool(
    'create-variant',
    {
      title: 'Generate Variants',
      description: 'Step 5 of the variant workflow. Generates variants of a PSD template with the Photoshop API, in parallel: ' +
        'for each variant, replaces the text of text layers and the content of smart object layers (with image URLs from upload-variant-images), ' +
        'then saves it in the requested formats (PNG, JPEG and/or layered PSD, several at once if asked). Only call it once the layers are selected (get-psd-manifest) and all values are known. ' +
        'Pass all variants in a single call, even when their formats differ (set formats on those variants). It starts the generation and answers at once: the widget shows each variant as soon as it is rendered, with download buttons, and gives you the result (failures, text problems) when all are done; do not print the image URLs. ' +
        'Use layer ids and types from get-psd-manifest. For each smart object image, pass the crop chosen in upload-variant-images; ' +
        'without crop, the image is cropped centered to its frame (fit "fill", default). Do not crop or resize images with other tools. ' +
        'Pass the fontScale of each text as confirmed in review-variant-texts or in the changes sent from the widget of the generated variants. The ' +
        'widget marks the texts that do not fit on the visuals, with proposed fixes, and sends you the changes of the user (step 6). To change some variants, pass only those, with the same file names: ' +
        'the new widget shows only the variants of this call, the others stay in the earlier widgets.',
      inputSchema: {
        templateUrl: z.string().url().describe('HTTPS URL of the PSD template (same URL as given to get-psd-manifest)'),
        formats: z.array(z.enum(VARIANT_FORMATS)).min(1).optional()
          .describe('Output formats, one file per format and variant: png and/or jpeg images, psd for the edited layered Photoshop ' +
            'files. Pass several when the user asks for several (e.g. ["png", "psd"]). Default ["jpeg"]'),
        // Single format of earlier versions, still accepted for clients holding a cached tool schema
        format: z.enum(VARIANT_FORMATS).optional().describe('Deprecated: use formats'),
        variants: z.array(z.object({
          fileName: z.string().optional().describe('Output file name without extension, e.g. "variant-summer"'),
          layers: z.array(layerEditSchema).min(1).describe('Edits to apply, one per layer'),
          language: z.string().optional().describe('Language of the texts of this variant, as an ISO 639-1 code (e.g. "fr"), used to check them'),
          formats: z.array(z.enum(VARIANT_FORMATS)).min(1).optional()
            .describe('Formats of this variant only, when they differ between variants (e.g. ["png", "psd"] for one of them); ' +
              'otherwise the formats of the call')
        })).min(1).max(MAX_VARIANTS).optional().describe(`Variants to generate (max ${MAX_VARIANTS} per call)`),
        // Single-variant format of earlier versions, still accepted for clients holding a cached tool schema
        layers: z.array(layerEditSchema).min(1).optional().describe('Deprecated: use variants'),
        fileName: z.string().optional().describe('Deprecated: use variants')
      },
      _meta: uiMeta(VIEWS.variant)
    },
    async ({ templateUrl, formats, format, variants, layers, fileName }) => {
      try {
        if (!variants && !layers) throw new Error('Missing "variants": pass a list of variants, each with its "layers".')
        const variantList = variants || [{ fileName, layers }]
        const warnings = findSharedImages(variantList).map(shared => `\nWarning: variants ${shared.variants.join(', ')} use the same image for layer ` +
          `${shared.layerId}. If the user chose different images in upload-variant-images, check the image of each variant in its ` +
          'confirmation (one line per variant and layer) and call create-variant again with the right URLs and crops.').join('')
        const taskId = await startTask(params, 'variants', {
          templateUrl,
          formats: [...new Set(formats || [format || 'jpeg'])],
          variants: variantList,
          warnings
        })
        return {
          content: [{
            type: 'text',
            text: `Generation of ${variantList.length} variant(s) started. The widget shows each variant as soon as it is rendered, with ` +
              'download buttons, marks the text problems on the visuals, and gives you the result when all are done; the user then sends ' +
              'you the changes to make. Do not call create-variant again meanwhile.' + warnings
          }],
          structuredContent: { taskId, templateUrl, pending: uniqueFileNames(variantList) }
        }
      } catch (error) {
        return errorResult(error)
      }
    }
  )

  server.registerTool(
    'get-task',
    {
      title: 'Get Task',
      description: 'Used by the widgets: returns the state of a task started by a tool (template reading, crop, generation): ' +
        'status (running, done or failed), partial result while running, result or error.',
      inputSchema: { taskId: z.string().describe('Task id returned by the tool') },
      _meta: { ui: { visibility: ['app'] } }
    },
    async ({ taskId }) => {
      try {
        const task = await readTask(params, taskId)
        if (!task) return errorResult(new Error('This task is not known: it expired (24 hours) or belongs to another user.'))
        return jsonResult(task)
      } catch (error) {
        return errorResult(error)
      }
    }
  )

  server.registerTool(
    'create-variants-zip',
    {
      title: 'Create Variants ZIP',
      description: 'Used by the create-variant widget: starts a task (see get-task) whose result is the URL of a ZIP archive of ' +
        'all the files of a generation.',
      inputSchema: { taskId: z.string().describe('Task id of the generation, returned by create-variant') },
      _meta: { ui: { visibility: ['app'] } }
    },
    async ({ taskId }) => {
      try {
        // A generation of the current user, done
        const generation = await readTask(params, taskId)
        if (generation?.status !== 'done') throw new Error('The generation is not done, or expired (24 hours).')
        return jsonResult({ taskId: await startTask(params, 'zip', { variantsTaskId: taskId }) })
      } catch (error) {
        return errorResult(error)
      }
    }
  )

  server.registerTool(
    'send-to-aem',
    {
      title: 'Send to AEM',
      description: 'Used by the create-variant widget: starts a task (see get-task) that uploads all the files of a generation to ' +
        'the AEM folder chosen in the Destination Selector of a picker session (create-aem-picker-session with folder), as ' +
        'assets or new versions, with the token of the sign-in of that session.',
      inputSchema: {
        taskId: z.string().describe('Task id of the generation, returned by create-variant'),
        sessionId: z.string().describe('Id of the picker session where the folder was chosen')
      },
      _meta: { ui: { visibility: ['app'] } }
    },
    async ({ taskId, sessionId }) => {
      try {
        const aem = requireAemConfig(params)
        const generation = await readTask(params, taskId)
        if (generation?.status !== 'done') throw new Error('The generation is not done, or expired (24 hours).')
        const folder = await takeAemFolder(sessionId, currentUserId(params))
        if (!folder) throw new Error('The AEM folder choice has expired, choose the folder again.')
        const folderUrl = getAemFolderUrl(aem, folder)
        // The task uploads with the token of the sign-in for AEM, passed in its signed invocation
        const args = { variantsTaskId: taskId, repositoryId: folder.repositoryId, path: folderUrl.pathname, token: folder.token }
        return jsonResult({ taskId: await startTask(params, 'aem', args) })
      } catch (error) {
        return errorResult(error)
      }
    }
  )

  server.registerTool(
    'get-widget-result',
    {
      title: 'Get Widget Result',
      description: 'Returns what the user confirmed in a widget of the variant workflow (template URL, selected layers, texts, images), ' +
        'from the reference in parentheses at the end of their message (e.g. "(r7k2p9)"). Call it when that result is not in your context.',
      inputSchema: { ref: z.string().describe('Reference from the user message, e.g. r7k2p9') }
    },
    async ({ ref }) => {
      try {
        const text = await readWidgetResult(params, ref.trim().replace(/^[·(\s]+|[)\s]+$/g, '').toLowerCase())
        if (!text) return errorResult(new Error(`No widget result for ${ref}: it expired (24 hours) or belongs to another user.`))
        return { content: [{ type: 'text', text }] }
      } catch (error) {
        return errorResult(error)
      }
    }
  )

  server.registerTool(
    'save-widget-result',
    {
      title: 'Save Widget Result',
      description: 'Used by the widgets: stores what the user confirmed and returns a reference for get-widget-result.',
      inputSchema: { text: z.string().min(1).max(500000).describe('Result of the widget, as sent to the model context') },
      _meta: { ui: { visibility: ['app'] } }
    },
    async ({ text }) => {
      try {
        return jsonResult({ ref: await saveWidgetResult(params, text) })
      } catch (error) {
        return errorResult(error)
      }
    }
  )

  server.registerTool(
    'review-variant-texts',
    {
      title: 'Review Variant Texts',
      description: 'Step 3 of the variant workflow. Shows the texts of the selected text layers for each variant in an editable table, ' +
        'so the user reviews and edits them. Call it ONCE with all variants, once their texts ' +
        'are known (given by the user or written by you); do not write the texts as a table in chat. When the user confirms, the final ' +
        'texts are added to your context and the user says to continue: use them exactly in create-variant. To let the user edit texts ' +
        'again, call it again with the latest texts. Pass the original text of each layer: the table shows it under the layer ' +
        'name. Pass the fontScale of each text, if any: it is kept, without being shown.',
      inputSchema: {
        layers: z.array(z.object({
          id: z.number().int().describe('Layer id from get-psd-manifest'),
          name: z.string().describe('Layer name'),
          text: z.string().optional().describe('Original text of the layer in the template, from get-psd-manifest')
        })).min(1).describe('Selected text layers, in the order of get-psd-manifest'),
        variants: z.array(z.object({
          label: z.string().min(1).describe('Short label of the variant'),
          texts: z.array(z.object({
            layerId: z.number().int().describe('Layer id'),
            text: z.string().describe('Text of the layer for this variant'),
            fontScale: z.number().min(0.5).max(1.5).optional().describe('Font size relative to the template, e.g. 0.9 (default 1)')
          })).describe('One text per text layer')
        })).min(1).max(MAX_VARIANTS).describe('Variants, in order'),
        title: z.string().optional().describe('Heading shown in the widget')
      },
      _meta: uiMeta(VIEWS.texts)
    },
    async ({ layers, variants }) => ({
      content: [{ type: 'text', text: `Texts table displayed (${variants.length} variant(s) x ${layers.length} text layer(s)). Wait for the user to confirm.` }]
    })
  )

  server.registerTool(
    'upload-variant-images',
    {
      title: 'Upload Variant Images',
      description: 'Step 4 of the variant workflow. Shows a grid where the user drops one image per variant and smart object layer ' +
        '(one row per variant, one column per layer). Each image is cropped to the frame of its layer, framed on its subject, and the user ' +
        'can reposition and zoom the crop. When the user confirms, the widget adds to your context, for each variant and layer, the image ' +
        'file name, its temporary HTTPS URL (valid 24 hours), its size and its crop, and the user says to continue: then call create-variant. ' +
        'To adjust crops or replace some images after a generation, call it again with images (URLs, crops and sizes from the previous ' +
        'confirmation): the grid opens pre-filled, without uploading again; then call create-variant again with the new crops.',
      inputSchema: {
        variants: z.array(z.string().min(1)).min(1).max(MAX_VARIANTS).describe('Short label of each variant, in order (e.g. their titles)'),
        layers: z.array(z.object({
          id: z.number().int().describe('Layer id from get-psd-manifest'),
          name: z.string().describe('Layer name'),
          width: z.number().positive().optional().describe('Frame width of the layer, from get-psd-manifest (frame.width)'),
          height: z.number().positive().optional().describe('Frame height of the layer, from get-psd-manifest (frame.height)')
        })).min(1).describe('Selected smart object layers'),
        images: z.array(z.object({
          variant: z.union([z.string(), z.number().int().min(0)])
            .describe('Variant label (as in variants), or its 0-based index; copy it from the JSON of the previous confirmation'),
          layerId: z.number().int().describe('Layer id'),
          url: z.string().url().describe('Image URL from a previous confirmation of this grid'),
          fileName: z.string().optional(),
          crop: z.object({ left: z.number(), top: z.number(), right: z.number(), bottom: z.number() }).optional(),
          width: z.number().positive().optional().describe('Image width in pixels (size from the previous confirmation)'),
          height: z.number().positive().optional().describe('Image height in pixels (size from the previous confirmation)')
        })).optional().describe('Images already uploaded, to pre-fill the grid (e.g. to adjust crops after a generation without uploading ' +
          'again): pass the "images" JSON of the previous confirmation as is'),
        title: z.string().optional().describe('Heading shown in the widget')
      },
      _meta: uiMeta(VIEWS.variantImages)
    },
    async ({ variants, layers }) => ({
      content: [{ type: 'text', text: `Image grid displayed (${variants.length} variant(s) x ${layers.length} layer(s)). Wait for the user to confirm.` }]
    })
  )

  server.registerTool(
    'upload-file',
    {
      title: 'Upload File',
      description: 'Shows a widget to upload ONE file. Only for a single file outside the variant workflow. ' +
        'NEVER use it for the replacement images of smart object layers: call upload-variant-images ONCE instead, which shows one grid for all variants. ' +
        'To start a variant workflow, call start-variant-creation.',
      inputSchema: {
        title: z.string().optional().describe('Heading shown in the widget')
      },
      _meta: uiMeta(VIEWS.upload)
    },
    async () => ({
      content: [{
        type: 'text',
        text: 'Upload widget displayed. Wait for the user to upload. Reminder: for smart object replacement images, ' +
          'do not call upload-file once per image; call upload-variant-images ONCE with all variant labels and layers.'
      }]
    })
  )

  server.registerTool(
    'suggest-crop',
    {
      title: 'Suggest Crop',
      description: 'Used by the upload-variant-images widget: starts a task (see get-task) whose result is the image size and a crop ' +
        'at the given ratio framed on its subject.',
      inputSchema: {
        imageUrl: z.string().url().describe('HTTPS URL of the image'),
        ratio: z.number().positive().describe('Width / height ratio of the frame')
      },
      _meta: { ui: { visibility: ['app'] } }
    },
    async ({ imageUrl, ratio }) => {
      try {
        return jsonResult({ taskId: await startTask(params, 'crop', { imageUrl, ratio }) })
      } catch (error) {
        return errorResult(error)
      }
    }
  )

  server.registerTool(
    'create-upload-url',
    {
      title: 'Create Upload URL',
      description: 'Used by the upload-file widget: returns presigned URLs to upload and read a file.',
      inputSchema: { fileName: z.string().min(1).describe('Name of the file to upload') },
      _meta: { ui: { visibility: ['app'] } }
    },
    async ({ fileName }) => {
      try {
        const urls = await createStorageUrls('uploads', fileName)
        return jsonResult(urls)
      } catch (error) {
        return errorResult(error)
      }
    }
  )

  server.registerTool(
    'get-aem-selector-config',
    {
      title: 'Get AEM Selector Config',
      description: 'Used by the start and upload-variant-images widgets: tells whether AEM Assets is configured on this server.',
      inputSchema: {},
      _meta: { ui: { visibility: ['app'] } }
    },
    async () => {
      const enabled = Boolean(getAemConfig(params))
      // Send to AEM needs a sign-in with a client allowed on AEM author
      return jsonResult({ enabled, send: enabled && Boolean(getAemLogin(params)) })
    }
  )

  server.registerTool(
    'create-aem-picker-session',
    {
      title: 'Create AEM Picker Session',
      description: 'Used by the start, upload-variant-images and create-variant widgets: creates a session of the AEM Asset ' +
        'Selector page, to open in a browser tab, and returns its URL and id (see get-aem-picker-result).',
      inputSchema: {
        multiple: z.boolean().default(false).describe('Allow selecting several assets'),
        folder: z.boolean().default(false).describe('Choose a destination folder (author tier) instead of assets')
      },
      _meta: { ui: { visibility: ['app'] } }
    },
    async ({ multiple, folder }) => {
      try {
        const aem = requireAemConfig(params)
        const login = folder ? getAemLogin(params) : null
        if (folder && !login) throw new Error('Send to AEM is not configured on this server (AEM_CLIENT_ID).')
        const token = getTokenFromRequest(params)
        // The selector needs AEM entitlements in the token: log its client and scopes (never the token) for diagnosis
        try {
          const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'))
          console.log(`AEM picker session: token client ${claims.client_id}, scopes ${claims.scope}`)
        } catch (_) {}
        const sessionId = await createPickerSession({
          // Folders are on the author tier
          repositoryId: folder && aem.pinnedRepository ? aemHost('author', aemEnvironment(aem.pinnedRepository)) : aem.pinnedRepository,
          aemTierType: folder ? 'author' : aem.tier,
          imsOrg: aem.imsOrg,
          // A folder session gets the token of the sign-in on the page
          apiKey: folder ? login.clientId : aemApiKey(params, token),
          imsToken: folder ? null : token
        }, { multiple, folder, login, userId: currentUserId(params) })
        const pickerUrl = `${getStaticOrigin(params)}/${AEM_PICKER_PAGE}#session=${sessionId}&api=${encodeURIComponent(getPickerApiPath())}`
        const session = { sessionId, pickerUrl }
        return { content: [{ type: 'text', text: 'AEM picker session created.' }], structuredContent: session }
      } catch (error) {
        return errorResult(error)
      }
    }
  )

  server.registerTool(
    'get-aem-picker-result',
    {
      title: 'Get AEM Picker Result',
      description: 'Used by the start and upload-variant-images widgets: returns the status of an AEM picker session ' +
        '(pending, selected, cancelled or expired) and the selected assets.',
      inputSchema: { sessionId: z.string().describe('Session id from create-aem-picker-session') },
      _meta: { ui: { visibility: ['app'] } }
    },
    async ({ sessionId }) => {
      try {
        const result = await getPickerResult(sessionId)
        return { content: [{ type: 'text', text: JSON.stringify({ status: result.status }) }], structuredContent: result }
      } catch (error) {
        return errorResult(error)
      }
    }
  )

  server.registerTool(
    'import-aem-asset',
    {
      title: 'Import AEM Asset',
      description: 'Used by the start and upload-variant-images widgets: copies an AEM asset picked in the Asset Selector to ' +
        'temporary storage and returns its HTTPS URL (valid 24 hours).',
      inputSchema: {
        repositoryId: z.string().optional().describe('repo:repositoryId of the asset, e.g. delivery-p12345-e67890.adobeaemcloud.com'),
        assetId: z.string().optional().describe('repo:assetId of the asset (delivery tier), e.g. urn:aaid:aem:...'),
        path: z.string().optional().describe('repo:path of the asset (author tier), e.g. /content/dam/campaign/banner.psd'),
        fileName: z.string().min(1).describe('repo:name of the asset')
      },
      _meta: { ui: { visibility: ['app'] } }
    },
    async (asset) => {
      try {
        const imported = await importAemAsset(params, requireAemConfig(params), asset)
        return jsonResult(imported)
      } catch (error) {
        return errorResult(error)
      }
    }
  )
}

function registerPrompts (server) {
  server.registerPrompt(
    'create-variants',
    {
      title: 'Create variants',
      description: 'Create variants of a PSD template: upload, layer selection, generation'
    },
    () => ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: 'I want to create variants from a PSD template. Call the start-variant-creation tool of the firefly-assembly connector now, ' +
            'then follow the workflow it returns, step by step.'
        }
      }]
    })
  )
}

// Path of the picker endpoint of this action (handled in index.js), on the static hosting origin like the picker page.
function getPickerApiPath () {
  const [, ...actionPath] = (process.env.__OW_ACTION_NAME || '').split('/').filter(Boolean)
  return `/api/v1/web/${actionPath.join('/')}/aem-picker`
}

// App Builder static hosting origin of this namespace, where web-src (the Spectrum bundle) is deployed.
function getStaticOrigin (params) {
  if (params.STATIC_ORIGIN) return String(params.STATIC_ORIGIN).replace(/\/$/, '')
  const namespace = process.env.__OW_NAMESPACE || (process.env.__OW_ACTION_NAME || '').split('/').filter(Boolean)[0]
  return `https://${namespace}.adobeio-static.net`
}

function registerResources (server, params) {
  const staticOrigin = getStaticOrigin(params)
  const scriptUrl = `${staticOrigin}/${spectrumAsset.fileName}`
  const csp = {
    connectDomains: [STORAGE_ORIGIN],
    resourceDomains: [STORAGE_ORIGIN, staticOrigin]
  }
  for (const view of Object.values(VIEWS)) {
    server.resource(
      view.name,
      view.uri,
      { mimeType: RESOURCE_MIME_TYPE, description: view.description },
      async () => ({
        contents: [{
          uri: view.uri,
          mimeType: RESOURCE_MIME_TYPE,
          text: view.html(scriptUrl),
          _meta: { ui: { csp } }
        }]
      })
    )
  }
}

module.exports = { WORKFLOW, registerTools, registerResources, registerPrompts, runTask }
