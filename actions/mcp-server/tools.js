const crypto = require('crypto')
const { Readable } = require('stream')
const { z } = require('zod')
const filesLib = require('@adobe/aio-lib-files')
const { getStartViewHtml, getUploadViewHtml, getVariantImagesViewHtml, getLayersViewHtml, getTextsViewHtml, getVariantViewHtml } = require('./views.js')
const stateLib = require('@adobe/aio-lib-state')
const { getTokenFromRequest, getUnverifiedClaims, getUnverifiedClientId } = require('./validator.js')
const { createPickerSession, getPickerResult } = require('./aem-picker.js')
const spectrumAsset = require('./spectrum-asset.js')

const IMS_TOKEN_URL = 'https://ims-na1.adobelogin.com/ims/token/v3'
const PHOTOSHOP_API = 'https://photoshop-api.adobe.io/v2'
const POLL_INTERVAL_MS = 2000
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
3. Texts: right after the layer selection, if text layers were selected, get the texts of each variant: the user provides them, or you write them from a brief (subject, tone, language, length constraints). Give each variant a short label (e.g. its title), then call review-variant-texts. Then wait.
4. Images: if smart object layers were selected, call upload-variant-images ONCE with the variant labels and the selected smart object layers (id, name and frame width and height from get-psd-manifest), so the user drops (or picks from AEM Assets) one image per variant and layer in a grid and adjusts how each one is cropped to its frame. When the user confirms, the widget gives you the URL, size and crop of each image the same way. Never ask for image URLs in chat. Then wait.
5. Generation: recap the variants in a Markdown table (one row per variant: label, the text of each text layer, the image file name of each smart object layer), then call create-variant ONCE with all variants, passing for each image the crop chosen in the grid. The widget shows the generated files with download buttons.
Changes after generation: to re-crop or swap images, call upload-variant-images again with images pre-filled from the previous confirmation (never ask to upload again the images you already have, unless their URLs expired); to change texts, call create-variant again with the new texts.
Widgets send their result (template URL, layers, texts, images) in your context and end the user's message with a reference in parentheses like "(r7k2p9)": if you do not have that result in your context, call get-widget-result with this ref before going on; never ask the user to redo a step because a result seems missing.
The URLs from the widgets are temporary presigned URLs: use them in tool calls, but never show them to the user. Reply in the user's language.`

const NEXT_STEPS_AFTER_SELECTION = 'Wait for the user to pick layers in the widget. Then: (1) if text layers were selected, get the ' +
  'texts of each variant (from the user, or written from a brief: subject, tone, language, length), give each variant a short label, then ' +
  'call review-variant-texts; (2) if smart object layers were selected, call upload-variant-images ONCE with all variant labels and ' +
  'the selected smart object layers (id, name, and frame width and height): it shows a single grid, one image per variant and layer, ' +
  'where the user adjusts each crop. Never call upload-file per image and never ask for image URLs; (3) recap the variants in a Markdown ' +
  'table (label, texts, image file names), then call create-variant ONCE ' +
  'with all variants, passing each image crop as given by the grid.'

// Server-to-server token for Firefly Services, reused across warm invocations.
let cachedToken = null

async function getFireflyServicesToken (params) {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60000) return cachedToken.value

  const response = await fetch(IMS_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: params.FIREFLY_SERVICES_API_CLIENT_ID,
      client_secret: params.FIREFLY_SERVICES_API_CLIENT_SECRET,
      scope: params.FIREFLY_SERVICES_API_SCOPES
    })
  })
  const result = await response.json()
  if (!result.access_token) throw new Error(`IMS token request failed: ${result.error_description || result.error || response.status}`)

  cachedToken = { value: result.access_token, expiresAt: Date.now() + result.expires_in * 1000 }
  return cachedToken.value
}

const RATE_LIMIT_RETRIES = 6
const RATE_LIMIT_BASE_DELAY_MS = 1000
const RATE_LIMIT_MAX_DELAY_MS = 30000

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

// fetch that waits and retries when Firefly Services answers 429 (rate limit): for the Retry-After delay when given,
// otherwise with an exponential backoff, randomized so that parallel jobs do not retry all at once.
async function fetchWithRateLimit (url, options) {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url, options)
    if (response.status !== 429 || attempt >= RATE_LIMIT_RETRIES) return response
    const retryAfterMs = Number(response.headers.get('retry-after')) * 1000
    const backoffMs = RATE_LIMIT_BASE_DELAY_MS * 2 ** attempt * (0.5 + Math.random())
    await wait(Math.min(retryAfterMs > 0 ? retryAfterMs : backoffMs, RATE_LIMIT_MAX_DELAY_MS))
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

async function callPhotoshop (params, path, options = {}) {
  const response = await fetchWithRateLimit(`${PHOTOSHOP_API}${path}`, { ...options, headers: await fireflyHeaders(params) })
  const body = await response.json()
  if (!response.ok) throw new Error(`Photoshop API ${response.status}: ${JSON.stringify(body)}`)
  return body
}

// Submits an asynchronous Photoshop job and polls it until it finishes; returns the job result.
async function runPhotoshopJob (params, path, body) {
  const { jobId } = await callPhotoshop(params, path, { method: 'POST', body: JSON.stringify(body) })

  const deadline = Date.now() + POLL_TIMEOUT_MS
  while (Date.now() < deadline) {
    await wait(POLL_INTERVAL_MS)
    const status = await callPhotoshop(params, `/status/${jobId}`)
    if (status.status === 'succeeded') return status.result
    if (status.status === 'failed') throw new Error(`Photoshop job failed: ${JSON.stringify(status.errorDetails)}`)
  }
  throw new Error(`Photoshop job ${jobId} did not finish within ${POLL_TIMEOUT_MS / 1000}s`)
}

async function generateManifest (params, url) {
  const result = await runPhotoshopJob(params, '/generate-manifest', {
    image: { source: { url } },
    outputs: [{ destination: { embedded: 'json' }, mediaType: 'application/json' }]
  })
  return result?.outputs?.[0]?.destination?.content ?? result
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
async function renderPreview (params, url) {
  const { uploadUrl, readUrl } = await createStorageUrls('previews', 'preview.jpg')
  await runPhotoshopJob(params, '/create-composite', {
    image: { source: { url } },
    outputs: [{ destination: { url: uploadUrl }, mediaType: 'image/jpeg', quality: 'high' }]
  })
  return readUrl
}

function newStoragePath (folder, fileName) {
  const safeName = fileName.replace(/[^\w.-]/g, '_')
  // Unique path: files with the same name can be created in the same millisecond (e.g. parallel crops)
  return `${folder}/${Date.now()}-${crypto.randomUUID().slice(0, 8)}-${safeName}`
}

async function createStorageUrls (folder, fileName) {
  const files = await filesLib.init()
  const path = newStoragePath(folder, fileName)
  const options = { expiryInSeconds: URL_EXPIRY_SECONDS }
  return {
    uploadUrl: await files.generatePresignURL(path, { ...options, permissions: 'w' }),
    readUrl: await files.generatePresignURL(path, { ...options, permissions: 'r' })
  }
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
  let response = await fetch(url)
  if (response.status === 401 || response.status === 403) {
    const token = getTokenFromRequest(params)
    response = await fetch(url, { headers: { Authorization: `Bearer ${token}`, 'X-Api-Key': params.AEM_API_KEY || getUnverifiedClientId(token) } })
  }
  const fileName = asset.fileName
  if (!response.ok) throw new Error(`AEM download of ${fileName} failed (HTTP ${response.status})`)

  const files = await filesLib.init()
  const path = newStoragePath('aem', fileName)
  await files.write(path, Readable.fromWeb(response.body))
  return { fileName, url: await files.generatePresignURL(path, { expiryInSeconds: URL_EXPIRY_SECONDS, permissions: 'r' }) }
}

function toLayerEdit (layer) {
  const edit = { id: layer.id, type: layer.type, operation: { type: 'edit' } }
  if (layer.type === 'text_layer') edit.text = { content: layer.text }
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
async function createVariant (params, { templateUrl, formats, layers, fileName }) {
  const baseName = (fileName || 'variant').replace(/\.(png|jpe?g|psd)$/i, '')
  const shownFormat = formats.find(format => VARIANT_OUTPUTS[format].displayable)
  const [files, preview] = await Promise.all([
    Promise.all(formats.map(format => createStorageUrls('variants', `${baseName}.${VARIANT_OUTPUTS[format].extension}`))),
    shownFormat ? null : createStorageUrls('variants', `${baseName}-preview.jpg`)
  ])

  await runPhotoshopJob(params, '/create-composite', {
    image: { source: { url: templateUrl } },
    edits: { layers: layers.map(toLayerEdit) },
    outputs: [
      ...formats.map((format, i) => ({ destination: { url: files[i].uploadUrl }, ...VARIANT_OUTPUTS[format].output })),
      ...(preview ? [{ destination: { url: preview.uploadUrl }, ...PREVIEW_OUTPUT }] : [])
    ]
  })
  return {
    fileName: baseName,
    // Shown in the view: the first displayable file, or the preview
    imageUrl: preview ? preview.readUrl : files[formats.indexOf(shownFormat)].readUrl,
    files: formats.map((format, i) => ({ format, fileName: `${baseName}.${VARIANT_OUTPUTS[format].extension}`, url: files[i].readUrl }))
  }
}

function findLayer (layers = [], id) {
  for (const layer of layers) {
    if (layer.id === id) return layer
    const nested = findLayer(layer.children || layer.layers, id)
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
async function detectSubjectBox (params, imageUrl, ratio) {
  const headers = await fireflyHeaders(params)
  const submit = await fetchWithRateLimit(AUTO_CROP_API, {
    method: 'POST',
    headers,
    body: JSON.stringify({ image: { source: { url: imageUrl } }, mode: 'smartCrop', aspectRatio: closestAutoCropRatio(ratio) })
  })
  const { statusUrl } = await submit.json()
  if (!statusUrl) throw new Error(`auto-crop request failed (${submit.status})`)

  const deadline = Date.now() + POLL_TIMEOUT_MS
  while (Date.now() < deadline) {
    await wait(POLL_INTERVAL_MS)
    const status = await (await fetchWithRateLimit(statusUrl, { headers })).json()
    if (status.status === 'failed') throw new Error(`auto-crop failed: ${JSON.stringify(status)}`)
    if (status.status !== 'succeeded') continue
    return status.output?.crops?.[0]?.boundingBoxes?.[0] || null
  }
  throw new Error('auto-crop did not finish in time')
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

// Suggested crop of an image for a frame ratio, framed on the subject detected by auto-crop (centered if none).
async function suggestCrop (params, imageUrl, ratio) {
  const [manifest, subject] = await Promise.all([
    generateManifest(params, imageUrl),
    // Subject detection is best effort: fall back to a centered crop
    detectSubjectBox(params, imageUrl, ratio).catch(() => null)
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
  const image = boundsSize((await generateManifest(params, imageUrl)).document.bounds)
  if (Math.abs(image.width / image.height - ratio) < 0.01) return imageUrl
  return cropImage(params, imageUrl, cropBounds(image, ratio, null))
}

// Crops every smart object image so that Photoshop's default "fit" placement fills its frame exactly: with the
// crop chosen by the user when given, otherwise centered (unless fit is "fit"). Each distinct crop is done once.
async function cropVariantImages (params, templateUrl, variants) {
  const needsCrop = layer => layer.type === 'smart_object_layer' && (layer.crop || layer.fit !== 'fit')
  const cropKey = layer => `${layer.id}|${layer.imageUrl}|${JSON.stringify(layer.crop || null)}`
  const toCrop = variants.flatMap(v => v.layers).filter(needsCrop)
  if (!toCrop.length) return variants

  // The template manifest gives the frames, only needed for images without a chosen crop
  const manifest = toCrop.some(layer => !layer.crop) ? await generateManifest(params, templateUrl) : null
  const crops = new Map()
  for (const layer of toCrop) {
    if (crops.has(cropKey(layer))) continue
    const frame = layer.crop ? null : findLayer(manifest.layers, layer.id)?.referenceFrame
    crops.set(cropKey(layer), layer.crop
      ? cropImage(params, layer.imageUrl, layer.crop)
      : frame ? cropToFrameCenter(params, layer.imageUrl, boundsSize(frame)) : Promise.resolve(layer.imageUrl))
  }

  return Promise.all(variants.map(async variant => ({
    ...variant,
    layers: await Promise.all(variant.layers.map(async layer => needsCrop(layer)
      ? { ...layer, imageUrl: await crops.get(cropKey(layer)) }
      : layer))
  })))
}

// Runs all variant jobs in parallel, each in its own formats or the formats of the call; a failed variant does not
// prevent the others from being returned.
async function createVariants (params, { templateUrl, formats, variants }) {
  const prepared = await cropVariantImages(params, templateUrl, variants)
  const results = await Promise.allSettled(prepared.map((variant, index) => createVariant(params, {
    templateUrl,
    formats: variant.formats ? [...new Set(variant.formats)] : formats,
    layers: variant.layers,
    fileName: variant.fileName || `variant-${index + 1}`
  })))
  return results.map((result, index) => result.status === 'fulfilled'
    ? result.value
    : { fileName: variants[index].fileName || `variant-${index + 1}`, error: result.reason.message })
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

async function saveWidgetResult (params, text) {
  const ref = 'r' + Array.from({ length: 6 }, () => REF_ALPHABET[crypto.randomInt(REF_ALPHABET.length)]).join('')
  const userId = currentUserId(params)
  const state = await stateLib.init()
  await state.put(widgetResultKey(userId, ref), { userId, text }, { ttl: WIDGET_RESULT_TTL_SECONDS })
  return ref
}

async function readWidgetResult (params, ref) {
  if (!WIDGET_RESULT_REF.test(ref)) return null
  const userId = currentUserId(params)
  const state = await stateLib.init()
  const stored = (await state.get(widgetResultKey(userId, ref)))?.value
  return stored && stored.userId === userId ? stored.text : null
}

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
    text: z.string().describe('New text content')
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
        const [manifest, previewUrl] = await Promise.all([
          generateManifest(params, url),
          // The preview is best effort: without it, the view shows the list of layers only
          renderPreview(params, url).catch(() => null)
        ])
        const data = {
          document: {
            // Strip the upload timestamp prefix and the job id suffix added by the storage and the Photoshop API
            title: manifest.document?.title?.replace(/^\d+-([0-9a-f]{8}-)?/, '').replace(/_[0-9a-f-]{36}(\.\w+)$/, '$1'),
            width: manifest.document?.bounds?.right,
            height: manifest.document?.bounds?.bottom
          },
          layers: getEditableLayers(manifest.layers)
        }
        // The preview URL and the layer areas are for the view only
        const forModel = { document: data.document, layers: data.layers.map(({ area, ...layer }) => layer) }
        return {
          content: [{
            type: 'text',
            text: `Editable layers (unlocked text and smart object layers), shown to the user for selection:\n${JSON.stringify(forModel, null, 2)}\n\n` +
              NEXT_STEPS_AFTER_SELECTION
          }],
          structuredContent: { ...data, previewUrl }
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
      description: 'Step 5 (last) of the variant workflow. Generates variants of a PSD template with the Photoshop API, in parallel: ' +
        'for each variant, replaces the text of text layers and the content of smart object layers (with image URLs from upload-variant-images), ' +
        'then saves it in the requested formats (PNG, JPEG and/or layered PSD, several at once if asked). Only call it once the layers are selected (get-psd-manifest) and all values are known. ' +
        'Pass all variants in a single call, even when their formats differ (set formats on those variants). The user sees a recap of the generated files with download buttons; do not print the image URLs. ' +
        'Use layer ids and types from get-psd-manifest. For each smart object image, pass the crop chosen in upload-variant-images; ' +
        'without crop, the image is cropped centered to its frame (fit "fill", default). Do not crop or resize images with other tools.',
      inputSchema: {
        templateUrl: z.string().url().describe('HTTPS URL of the PSD template (same URL as given to get-psd-manifest)'),
        formats: z.array(z.enum(VARIANT_FORMATS)).min(1).optional()
          .describe('Output formats, one file per format and variant: png and/or jpeg images, psd for the edited layered Photoshop ' +
            'files. Pass several when the user asks for several (e.g. ["png", "psd"]). Default ["png"]'),
        // Single format of earlier versions, still accepted for clients holding a cached tool schema
        format: z.enum(VARIANT_FORMATS).optional().describe('Deprecated: use formats'),
        variants: z.array(z.object({
          fileName: z.string().optional().describe('Output file name without extension, e.g. "variant-summer"'),
          layers: z.array(layerEditSchema).min(1).describe('Edits to apply, one per layer'),
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
        const outputFormats = [...new Set(formats || [format || 'png'])]
        const results = await createVariants(params, { templateUrl, formats: outputFormats, variants: variantList })
        const failed = results.filter(v => v.error)
        const summary = `${results.length - failed.length}/${results.length} variant(s) generated and shown to the user with download buttons.` +
          failed.map(v => `\n- ${v.fileName} failed: ${v.error}`).join('') +
          findSharedImages(variantList).map(shared => `\nWarning: variants ${shared.variants.join(', ')} use the same image for layer ` +
            `${shared.layerId}. If the user chose different images in upload-variant-images, check the image of each variant in its ` +
            'confirmation (one line per variant and layer) and call create-variant again with the right URLs and crops.').join('')
        return {
          content: [{ type: 'text', text: summary }],
          structuredContent: { variants: results },
          isError: failed.length === results.length
        }
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
        'again, call it again with the latest texts.',
      inputSchema: {
        layers: z.array(z.object({
          id: z.number().int().describe('Layer id from get-psd-manifest'),
          name: z.string().describe('Layer name')
        })).min(1).describe('Selected text layers, in the order of get-psd-manifest'),
        variants: z.array(z.object({
          label: z.string().min(1).describe('Short label of the variant'),
          texts: z.array(z.object({
            layerId: z.number().int().describe('Layer id'),
            text: z.string().describe('Text of the layer for this variant')
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
        'file name, its temporary HTTPS URL (valid 24 hours), its size and its crop, and the user says to continue: then recap and call create-variant. ' +
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
      description: 'Used by the upload-variant-images widget: returns the image size and a crop at the given ratio framed on its subject.',
      inputSchema: {
        imageUrl: z.string().url().describe('HTTPS URL of the image'),
        ratio: z.number().positive().describe('Width / height ratio of the frame')
      },
      _meta: { ui: { visibility: ['app'] } }
    },
    async ({ imageUrl, ratio }) => {
      try {
        const suggestion = await suggestCrop(params, imageUrl, ratio)
        return jsonResult(suggestion)
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
          text: 'I want to create variants from a PSD template. Call the start-variant-creation tool of the Assemble connector now, ' +
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

module.exports = { WORKFLOW, registerTools, registerResources, registerPrompts }
