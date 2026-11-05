const crypto = require('crypto')
const { Readable } = require('stream')
const { z } = require('zod')
const filesLib = require('@adobe/aio-lib-files')
const { reviewImage } = require('./review.js')
const { getStartViewHtml, getUploadViewHtml, getVariantImagesViewHtml, getLayersViewHtml, getTextsViewHtml, getVariantViewHtml } = require('./views.js')
const stateStore = require('./state')
const { getTokenFromRequest, getUnverifiedClaims, getUnverifiedClientId } = require('./validator.js')
const { createPickerSession, getPickerResult } = require('./aem-picker.js')
const { zipFiles } = require('./zip.js')
const spectrumAsset = require('./spectrum-asset.js')

const IMS_TOKEN_URL = 'https://ims-na1.adobelogin.com/ims/token/v3'
const PHOTOSHOP_API = 'https://photoshop-api.adobe.io/v2'
const POLL_FIRST_DELAY_MS = 1000
const POLL_MAX_DELAY_MS = 5000
const POLL_TIMEOUT_MS = 240000
const URL_EXPIRY_SECONDS = 24 * 3600
const STORAGE_ORIGIN = 'https://firefly.azureedge.net'
const EDITABLE_LAYER_TYPES = ['text_layer', 'smart_object_layer']
// Variants of a workflow (number of variants times languages), and of a generation: a task renders at most this many within the
// action timeout, a workflow with more is generated in several
const MAX_VARIANTS = 50
const MAX_VARIANTS_PER_GENERATION = 10
// Languages offered in the start widget (see LANGUAGES in views.js)
const LANGUAGES = ['en', 'fr', 'it', 'de', 'es', 'pt']
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
1. Start: call start-variant-creation (pass variantCount and languages if the user already gave them). The user sets the number of variants per language, the languages and uploads the PSD template (from their computer or AEM Assets) in the widget, then says to continue. The widget gives you the template name and URL in your context (or through get-widget-result, see below): use that URL. Never ask for the file or its URL in chat.
2. Layer selection: immediately call get-psd-manifest with the template URL. The user picks the layers to vary in the widget. Then wait.
3. Texts: right after the layer selection, if text layers were selected, get the texts of each variant: the user provides them, or you write them from a brief (subject, tone, language). The user's requests always come first (length, number of words or lines, wording): follow them exactly, even if the text may not fit, and never shorten or change a text the user asked for to make it fit. Otherwise, write each text about as long as the original text of its layer (given by get-psd-manifest): the same number of lines and about the same number of characters per line (within 10%), so that it fits the layout. Write the line breaks yourself (\\n), where the original text has them: a point text layer does not wrap its lines by itself (a text without any line break is spread over the lines of the original text, by length). Each variant is created in each language chosen in the start widget (the total is the number of variants times the number of languages): write the texts of each variant in each language (the same message, translated and adapted, not word for word), and give each a short label ending with its language code (e.g. "Winter sale FR"), in the order variant by variant then language by language. Then call review-variant-texts with the texts and the original text of each layer. Then wait.
4. Images: if smart object layers were selected, call upload-variant-images ONCE with the variant labels and the selected smart object layers (id, name and frame width and height from get-psd-manifest), so the user drops (or picks from AEM Assets) one image per variant and layer in a grid and adjusts how each one is cropped to its frame. When the user confirms, the widget gives you the URL, size and crop of each image the same way. Never ask for image URLs in chat. Then wait.
5. Generation: as soon as the images are confirmed (or the texts, without smart object layers), call create-variant ONCE with all variants (with more than ${MAX_VARIANTS_PER_GENERATION}, in calls of ${MAX_VARIANTS_PER_GENERATION} at most, one after the other, without waiting for the renders), passing for each image the crop chosen in the grid and for each variant its language; do not recap the variants or ask for another approval. The widget shows the generated files with download buttons.
6. Review: when the generation is done, the widget asks you to check the texts of the generated files: call review-variants with the task id it gives: it shows you each visual with the texts sent. Look at each edited text on its visual: cut or past an edge of the visual or of its panel, letters or words hidden, overlapping another element (logo, image, other text) more than in the template, too small or hard to read on its background, lines broken badly, or not the text sent. Then call report-variant-issues ONCE with every variant reviewed (no issues for those that are fine): per problem, the layer, a short description, the fix you propose (e.g. Reduce the font size of "headline" to 85%.) and the rectangle of the text on the visual, in pixels of the canvas. The widget marks each problem on the visual, with your proposed fix. Each variant has a field of changes, pre-filled with its proposed fixes, that the user edits, then sends to you: nothing is generated again before. Do not list the problems in chat: briefly say that the widget shows them and takes the changes. When the user asks for changes (in the widget or in chat), make exactly the changes asked, nothing else: change a font size only when asked; to change the words of a text, rewrite it as asked (e.g. twice as many words, at most two lines) and keep its font size, even if it may not fit; then call create-variant again with the variants to change only, with the same file names and the same edits except the changes (a font size of N% is fontScale N/100): the new widget shows only these variants, the others stay in the earlier widgets. The texts are checked once generated: do not adjust them beforehand. If a text the user asked for does not fit, you may then suggest a fix (a smaller font size or a shorter text), without applying it.
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

// Wait asked by a 429 answer, at most this long
const RATE_LIMIT_MAX_WAIT_MS = 120000
// Until when the requests to each host wait, after a 429 answer of this host: all the requests of the container wait, not only
// the one that got it, as each request counts against the rate limit
const rateLimitedUntil = new Map()

// Delay of a Retry-After header, in seconds or as a date; null without one.
function retryAfterMs (header) {
  if (!header) return null
  const delay = /^\d+$/.test(header.trim()) ? Number(header) * 1000 : Date.parse(header) - Date.now()
  return Number.isFinite(delay) ? Math.max(0, delay) : null
}

// Whether the requests to a host were rate limited within the last minute (a job slowed down by the rate limit is not stalled).
const recentlyRateLimited = url => (rateLimitedUntil.get(new URL(url).host) || 0) > Date.now() - 60000

// fetch with a time limit, that waits and retries when Firefly Services answers 429 (rate limit), for the Retry-After delay
// when given (the other requests to the same host waiting as long), and on server errors and network failures.
async function fetchWithRetry (url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const host = new URL(url).host
  for (let attempt = 0; ; attempt++) {
    const until = rateLimitedUntil.get(host) || 0
    if (until > Date.now()) await wait(until - Date.now())
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
    // Frees the connection
    await response.body?.cancel().catch(() => {})
    if (response.status === 429) {
      const header = response.headers.get('retry-after')
      const delay = Math.min(retryAfterMs(header) ?? backoff(attempt), RATE_LIMIT_MAX_WAIT_MS)
      if (Date.now() + delay > (rateLimitedUntil.get(host) || 0)) {
        rateLimitedUntil.set(host, Date.now() + delay)
        console.warn(`${host} rate limited (429, Retry-After ${header ?? 'none'}): requests wait ${Math.round(delay / 1000)}s`)
      }
    } else {
      await wait(backoff(attempt))
    }
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
// their crops): keeps the polling within the rate limits, without delaying the renders of a full generation.
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
    // A job slowed down by the rate limit is not stalled: submitting it again would add to the requests
    if (settled || recentlyRateLimited(PHOTOSHOP_API)) return first
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
const initFiles = () => (filesClient = filesClient || filesLib.init().catch(error => { filesClient = null; throw error }))
const initState = async () => stateStore

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
    pinnedRepository: pinned ? `${tier}-${pinned}.adobeaemcloud.com` : null,
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
    response = await fetchWithRetry(url, { headers: { Authorization: `Bearer ${token}`, 'X-Api-Key': params.AEM_API_KEY || getUnverifiedClientId(token) } }, RESPONSE_BUDGET_MS)
  }
  const fileName = asset.fileName
  if (!response.ok) throw new Error(`AEM download of ${fileName} failed (HTTP ${response.status})`)

  const files = await initFiles()
  const path = newStoragePath('aem', fileName)
  await files.write(path, Readable.fromWeb(response.body))
  return { fileName, url: await files.generatePresignURL(path, { expiryInSeconds: URL_EXPIRY_SECONDS, permissions: 'r' }) }
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

// Renders one variant in all the requested formats with a single Photoshop job.
async function createVariant (params, { templateUrl, templateManifest, formats, layers, fileName: baseName, deadline }) {
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
  return {
    fileName: baseName,
    imageUrl,
    files: formats.map((format, i) => ({ format, fileName: `${baseName}.${VARIANT_OUTPUTS[format].extension}`, url: files[i].readUrl })),
    // For the view, which marks the text problems on the image
    canvas: boundsSize(templateManifest.document.bounds)
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
// variants each time one changes: { fileName, pending: true } until rendered, then as returned.
async function createVariants (params, { templateUrl, formats, variants, deadline, onProgress }) {
  const fileNames = uniqueFileNames(variants)
  const progress = fileNames.map(fileName => ({ fileName, pending: true }))
  const report = (index, variant) => { progress[index] = variant; onProgress?.([...progress]) }
  // The crops chosen by the user do not need the template: started during its reading, prepareLayers then gets them cached
  variants.forEach(variant => variant.layers
    .filter(layer => layer.type === 'smart_object_layer' && layer.crop)
    .forEach(layer => Promise.resolve(cropLayerImage(params, null, layer)).catch(() => {})))
  const templateManifest = beforeDeadline(getManifest(params, templateUrl), deadline, tooLate('Reading the template'))
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
        fileName: fileNames[index]
      })
      mark(index, 'render')
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
    failed.map(v => `\n- ${v.fileName} failed: ${v.error}`).join('') + warnings
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
    // Reviewed by the assistant: with the layers of the template and the texts sent, for review-variants and report-variant-issues
    const review = variants.some(v => !v.error) &&
      args.variants.some(variant => variant.layers.some(layer => layer.type === 'text_layer'))
    return {
      templateUrl: args.templateUrl,
      variants,
      summary: describeGeneration(variants, args.warnings || ''),
      ...(review ? { review: await reviewData(params, args), doneAt: Date.now() } : {})
    }
  },

  // ZIP archive of the files of a generation
  async zip (params, { args, userId }) {
    return zipGeneration(userId, args.variantsTaskId)
  }
}

// What the assistant needs to review a generation: the drawn layers of the template ({ id, name, type, area }, area in pixels of
// the canvas) and, per variant in order, its edited texts ({ layerId, text, fontScale }).
async function reviewData (params, args) {
  const manifest = await getManifest(params, args.templateUrl).catch(() => null)
  return {
    layers: manifest ? drawnLayers(manifest.layers).map(layer => ({ id: layer.id, name: layer.name, type: layer.type, area: layerArea(layer) })) : [],
    texts: args.variants.map(variant => variant.layers.filter(layer => layer.type === 'text_layer')
      .map(layer => ({ layerId: layer.id, text: layer.text, ...(layer.fontScale ? { fontScale: layer.fontScale } : {}) })))
  }
}

// Problems reported by the assistant on a generation (report-variant-issues), read by its widget
const reviewKey = (userId, taskId) => `review-${shortHash(userId)}-${taskId}`

// A generation of the current user, done and to be reviewed by the assistant; throws otherwise.
async function generationToReview (params, taskId) {
  const generation = await readTask(params, taskId)
  if (!generation) throw new Error('This generation is not known: it expired (24 hours) or belongs to another user.')
  if (generation.status === 'failed') throw new Error(`This generation failed: ${generation.error}`)
  return generation
}

// Content of review-variants: the texts to check, then each visual reduced (the assistant reads images, not their URLs).
async function reviewContent (generation, fileNames) {
  const { variants, review } = generation.result
  const layerName = id => review.layers.find(layer => layer.id === id)?.name || String(id)
  const shown = variants.map((variant, index) => ({ variant, texts: review.texts[index] || [] }))
    .filter(({ variant }) => !variant.error && (!fileNames?.length || fileNames.includes(variant.fileName)))
  const images = await Promise.all(shown.map(async ({ variant }) => {
    const response = await fetchWithRetry(variant.imageUrl)
    if (!response.ok) throw new Error(`The visual of ${variant.fileName} could not be downloaded (HTTP ${response.status})`)
    return reviewImage(Buffer.from(await response.arrayBuffer()))
  }))
  const intro = `${shown.length} variant(s) to review. Layers of the template (pixels of the canvas: left, top, width, height): ` +
    review.layers.map(layer => `"${layer.name}" (id ${layer.id}, ${layer.type}${layer.area ? `, ${['left', 'top', 'width', 'height'].map(k => Math.round(layer.area[k])).join(',')}` : ''})`).join('; ') +
    '. Below, each visual with the texts sent. Check each edited text as the workflow says (step 6), then call report-variant-issues ' +
    'ONCE with every variant below, with the rectangles in pixels of the canvas (each visual is reduced: multiply its pixels by the factor given).'
  return [{ type: 'text', text: intro }, ...shown.flatMap(({ variant, texts }, i) => {
    const canvas = variant.canvas || { width: images[i].width, height: images[i].height }
    return [{
      type: 'text',
      text: `Variant "${variant.fileName}": canvas ${canvas.width}x${canvas.height} px, visual reduced to ${images[i].width}x${images[i].height} ` +
        `(factor ${Math.round(canvas.width / images[i].width * 1000) / 1000}). Texts sent: ` +
        texts.map(t => `"${layerName(t.layerId)}" (id ${t.layerId}${t.fontScale ? `, font ${Math.round(t.fontScale * 100)}%` : ''}): ${JSON.stringify(t.text)}`).join('; ')
    }, { type: 'image', data: images[i].data, mimeType: images[i].mimeType }]
  })]
}

// Problems reported by the assistant, as the widget shows them: per variant
// file name, [{ layerId, layerName, problems, fix, area, marks }], marks being where the text overlaps the layers it names.
function reviewIssues (generation, reported) {
  const layers = generation.result.review.layers
  const fileNames = new Set(generation.result.variants.map(variant => variant.fileName))
  return Object.fromEntries(reported.filter(variant => fileNames.has(variant.fileName)).map(variant => [variant.fileName, variant.issues.map(issue => {
    const layer = layers.find(l => l.id === issue.layerId) || layers.find(l => l.name === issue.layerName)
    const area = issue.area || layer?.area || null
    const marks = area ? (issue.overlapsLayerIds || []).map(id => layers.find(l => l.id === id)?.area)
      .filter(Boolean).map(other => intersection(area, other)).filter(Boolean) : []
    return { layerId: layer?.id ?? issue.layerId, layerName: layer?.name || issue.layerName, problems: [issue.problem], fix: issue.fix, area, marks }
  })]))
}

// Files of a generation zipped together: at most this many bytes, held in memory
const MAX_ZIP_BYTES = 400 * 1024 * 1024

// ZIP archive of the files of a done generation (task variants) of the user of the task: { fileName, url, count }.
async function zipGeneration (userId, variantsTaskId) {
  const generation = (await (await initState()).get(taskKey(userId, variantsTaskId)))?.value
  if (generation?.status !== 'done') throw new Error('The generation is not done, or expired (24 hours).')
  const files = (generation.result?.variants || []).filter(v => !v.error).flatMap(v => v.files || [])
  if (!files.length) throw new Error('No file to download.')
  let total = 0
  const entries = await Promise.all(files.map(async file => {
    const response = await fetchWithRetry(file.url)
    if (!response.ok) throw new Error(`${file.fileName} could not be downloaded (HTTP ${response.status})`)
    const data = Buffer.from(await response.arrayBuffer())
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
// review-variants waits this long for the generation, the rest of the response time being for the visuals
const REVIEW_WAIT_MS = RESPONSE_BUDGET_MS - 15000

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
        'the user sets the number of variants, their languages (each variant is created in each language) and uploads the layered PSD template. Its result describes the full workflow to follow.',
      inputSchema: {
        variantCount: z.number().int().min(1).max(MAX_VARIANTS).optional().describe('Number of variants per language, if the user already said it'),
        languages: z.array(z.enum(LANGUAGES)).min(1).optional().describe('Languages of the variants, as ISO 639-1 codes, if the user already said them')
      },
      _meta: uiMeta(VIEWS.start)
    },
    async () => ({
      content: [{ type: 'text', text: `Start widget displayed: wait for the user to set the number of variants and their languages, upload the PSD template and continue.\n\n${WORKFLOW}` }]
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
        'Pass all variants in a single call, even when their formats differ (set formats on those variants); with more than ' + MAX_VARIANTS_PER_GENERATION + ' variants, in calls of ' + MAX_VARIANTS_PER_GENERATION + ' at most, one after the other, without waiting. It starts the generation and answers at once: the widget shows each variant as soon as it is rendered, with download buttons, and gives you the result (failures, text problems) when all are done; do not print the image URLs. ' +
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
          language: z.string().optional().describe('Language of the texts of this variant, as an ISO 639-1 code (e.g. "fr")'),
          formats: z.array(z.enum(VARIANT_FORMATS)).min(1).optional()
            .describe('Formats of this variant only, when they differ between variants (e.g. ["png", "psd"] for one of them); ' +
              'otherwise the formats of the call')
        })).min(1).max(MAX_VARIANTS_PER_GENERATION).optional().describe(`Variants to generate (max ${MAX_VARIANTS_PER_GENERATION} per call)`),
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
    'review-variants',
    {
      title: 'Review Variants',
      description: 'Step 6 of the variant workflow, when the widget of create-variant asks you to check the texts: shows you the ' +
        'visuals of a generation (images) with the texts sent and the layers of the template, waiting for the generation if needed. ' +
        'Look at them, then call report-variant-issues.',
      inputSchema: {
        taskId: z.string().describe('Task id of the generation, given by the widget'),
        fileNames: z.array(z.string()).optional().describe('Variants to show only (file names), e.g. to review a large generation in parts')
      }
    },
    async ({ taskId, fileNames }) => {
      try {
        await generationToReview(params, taskId)
        const generation = await awaitTask(params, taskId, Date.now() + REVIEW_WAIT_MS, task => task?.status === 'done' && task)
        if (!generation) return { content: [{ type: 'text', text: 'The generation is not finished yet: call review-variants again.' }] }
        if (!generation.result?.review) throw new Error('This generation has no texts to review.')
        return { content: await reviewContent(generation, fileNames) }
      } catch (error) {
        return errorResult(error)
      }
    }
  )

  server.registerTool(
    'report-variant-issues',
    {
      title: 'Report Variant Issues',
      description: 'Step 6 of the variant workflow, after review-variants: gives the widget of the generation the text problems you ' +
        'found on the visuals, which it marks with the fixes you propose and lets the user edit and send. Call it ONCE with every ' +
        'variant reviewed, with no issues for those that are fine.',
      inputSchema: {
        taskId: z.string().describe('Task id of the generation, as given to review-variants'),
        variants: z.array(z.object({
          fileName: z.string().describe('File name of the variant, as in review-variants'),
          issues: z.array(z.object({
            layerId: z.number().int().optional().describe('Id of the text layer with the problem'),
            layerName: z.string().describe('Name of the text layer'),
            problem: z.string().describe('Short description of the problem, e.g. "is cut by the right edge of the visual"'),
            fix: z.string().optional().describe('Fix proposed to the user, e.g. "Reduce the font size of \"headline\" to 85%."'),
            area: z.object({ left: z.number(), top: z.number(), width: z.number(), height: z.number() }).optional()
              .describe('Rectangle of the text on the visual, in pixels of the canvas'),
            overlapsLayerIds: z.array(z.number().int()).optional().describe('Ids of the layers the text overlaps, if it does')
          })).describe('Problems of the variant, none when it is fine')
        })).min(1).max(MAX_VARIANTS)
      }
    },
    async ({ taskId, variants }) => {
      try {
        const generation = await generationToReview(params, taskId)
        if (!generation.result?.review) throw new Error('This generation is not done, or has no texts to review.')
        const issues = reviewIssues(generation, variants)
        const stored = (await (await initState()).get(reviewKey(currentUserId(params), taskId)))?.value || {}
        await (await initState()).put(reviewKey(currentUserId(params), taskId), { ...stored, ...issues }, { ttl: TASK_TTL_SECONDS })
        const count = Object.values(issues).reduce((total, list) => total + list.length, 0)
        return {
          content: [{
            type: 'text',
            text: `${count} problem(s) on ${Object.keys(issues).length} variant(s) given to the widget, which marks them on the visuals ` +
              'with your fixes, for the user to edit and send. Do not list them in chat: say briefly that the widget shows them.'
          }]
        }
      } catch (error) {
        return errorResult(error)
      }
    }
  )

  server.registerTool(
    'get-variant-review',
    {
      title: 'Get Variant Review',
      description: 'Used by the create-variant widget: the text problems reported by the assistant on a generation, by file name ' +
        '(reviewed: false until reported).',
      inputSchema: { taskId: z.string().describe('Task id of the generation') },
      _meta: { ui: { visibility: ['app'] } }
    },
    async ({ taskId }) => {
      try {
        if (!TASK_ID.test(String(taskId))) throw new Error('Invalid task id')
        const issues = (await (await initState()).get(reviewKey(currentUserId(params), taskId)))?.value
        return jsonResult(issues ? { reviewed: true, issues } : { reviewed: false })
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
      const config = { enabled: Boolean(getAemConfig(params)) }
      return jsonResult(config)
    }
  )

  server.registerTool(
    'create-aem-picker-session',
    {
      title: 'Create AEM Picker Session',
      description: 'Used by the start and upload-variant-images widgets: creates a session of the AEM Asset Selector page, ' +
        'to open in a browser tab, and returns its URL and id (see get-aem-picker-result).',
      inputSchema: { multiple: z.boolean().default(false).describe('Allow selecting several assets') },
      _meta: { ui: { visibility: ['app'] } }
    },
    async ({ multiple }) => {
      try {
        const aem = requireAemConfig(params)
        const token = getTokenFromRequest(params)
        // The selector needs AEM entitlements in the token: log its client and scopes (never the token) for diagnosis
        try {
          const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'))
          console.log(`AEM picker session: token client ${claims.client_id}, scopes ${claims.scope}`)
        } catch (_) {}
        const sessionId = await createPickerSession({
          repositoryId: aem.pinnedRepository,
          aemTierType: aem.tier,
          imsOrg: aem.imsOrg,
          apiKey: params.AEM_API_KEY || getUnverifiedClientId(token),
          imsToken: token
        }, { multiple })
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
