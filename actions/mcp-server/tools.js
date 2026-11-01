const crypto = require('crypto')
const { z } = require('zod')
const filesLib = require('@adobe/aio-lib-files')
const { getStartViewHtml, getUploadViewHtml, getVariantImagesViewHtml, getLayersViewHtml, getVariantViewHtml } = require('./views.js')
const spectrumAsset = require('./spectrum-asset.js')

const IMS_TOKEN_URL = 'https://ims-na1.adobelogin.com/ims/token/v3'
const PHOTOSHOP_API = 'https://photoshop-api.adobe.io/v2'
const POLL_INTERVAL_MS = 2000
const POLL_TIMEOUT_MS = 240000
const URL_EXPIRY_SECONDS = 24 * 3600
const STORAGE_ORIGIN = 'https://firefly.azureedge.net'
const EDITABLE_LAYER_TYPES = ['text_layer', 'smart_object_layer']
const MAX_VARIANTS = 10

const RESOURCE_MIME_TYPE = 'text/html;profile=mcp-app'
const VIEWS = {
  start: { uri: 'ui://start-variants/app.html', name: 'Create Variants App', description: 'Variant count and PSD template upload', html: getStartViewHtml },
  upload: { uri: 'ui://upload-file/app.html', name: 'Upload File App', description: 'File upload widget', html: getUploadViewHtml },
  variantImages: { uri: 'ui://variant-images/app.html', name: 'Variant Images App', description: 'Image grid per variant and smart object layer', html: getVariantImagesViewHtml },
  layers: { uri: 'ui://psd-layers/app.html', name: 'PSD Layers App', description: 'Editable layers picker', html: getLayersViewHtml },
  variant: { uri: 'ui://psd-variant/app.html', name: 'PSD Variant App', description: 'Variant preview and download', html: getVariantViewHtml }
}

const WORKFLOW = `Variant creation workflow. When the user asks to create variants (or versions, adaptations, localizations...) of a banner, ad, visual, social post or any PSD template, ALWAYS follow these steps in order, one at a time, without skipping any:
1. Start: call start-variant-creation (pass variantCount if the user already gave it). The user sets the number of variants and uploads the PSD template in the widget, then says to continue. Do not ask for the file in chat and do not look for it elsewhere.
2. Layer selection: immediately call get-psd-manifest with the template URL. The user picks the layers to vary in the widget. Then wait.
3. Texts: right after the layer selection, if text layers were selected, list them with their current text and ask the user which texts to use for each variant: either they provide the texts, or you write them (then ask for the brief: subject, tone, language, length constraints). If you write them, show your proposal per variant and let the user adjust it before going on. Give each variant a short label (e.g. its title). Then wait.
4. Images: if smart object layers were selected, call upload-variant-images ONCE with the variant labels and the selected smart object layers (id, name and frame width and height from get-psd-manifest), so the user drops one image per variant and layer in a grid and adjusts how each one is cropped to its frame. Never ask for an image URL. Then wait.
5. Generation: briefly recap each variant (texts and image file names), then call create-variant ONCE with all variants, passing for each image the crop chosen in the grid. The widget shows the generated files with download buttons.
Changes after generation: to re-crop or swap images, call upload-variant-images again with images pre-filled from the previous confirmation (never ask to upload again the images you already have, unless their URLs expired); to change texts, call create-variant again with the new texts.
Never show presigned URLs to the user; they are internal. Reply in the user's language.`

const NEXT_STEPS_AFTER_SELECTION = 'Wait for the user to pick layers in the widget. Then: (1) if text layers were selected, list them with their ' +
  'current text and ask which texts to use for each variant: the user provides them, or you write them (ask for the brief: subject, tone, ' +
  'language, length) and let the user adjust your proposal; give each variant a short label; (2) if smart object layers were selected, call upload-variant-images ONCE with all variant labels and ' +
  'the selected smart object layers (id, name, and frame width and height): it shows a single grid, one image per variant and layer, ' +
  'where the user adjusts each crop. Never call upload-file per image and never ask for image URLs; (3) recap, then call create-variant ONCE ' +
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

async function callPhotoshop (params, path, options = {}) {
  const token = await getFireflyServicesToken(params)
  const response = await fetch(`${PHOTOSHOP_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'x-api-key': params.FIREFLY_SERVICES_API_CLIENT_ID,
      'Content-Type': 'application/json'
    }
  })
  const body = await response.json()
  if (!response.ok) throw new Error(`Photoshop API ${response.status}: ${JSON.stringify(body)}`)
  return body
}

// Submits an asynchronous Photoshop job and polls it until it finishes; returns the job result.
async function runPhotoshopJob (params, path, body) {
  const { jobId } = await callPhotoshop(params, path, { method: 'POST', body: JSON.stringify(body) })

  const deadline = Date.now() + POLL_TIMEOUT_MS
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS))
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

// Text and smart object layers that are not locked, including those nested in groups and artboards.
function getEditableLayers (layers = []) {
  return layers.flatMap(layer => {
    const nested = getEditableLayers(layer.children || layer.layers)
    if (!EDITABLE_LAYER_TYPES.includes(layer.type) || !isUnlocked(layer)) return nested
    const editable = { id: layer.id, name: layer.name, type: layer.type }
    if (layer.type === 'text_layer') editable.text = layer.text?.content ?? ''
    if (layer.type === 'smart_object_layer' && layer.referenceFrame) editable.frame = boundsSize(layer.referenceFrame)
    return [editable, ...nested]
  })
}

async function createStorageUrls (folder, fileName) {
  const files = await filesLib.init()
  const safeName = fileName.replace(/[^\w.-]/g, '_')
  // Unique path: files with the same name can be created in the same millisecond (e.g. parallel crops)
  const path = `${folder}/${Date.now()}-${crypto.randomUUID().slice(0, 8)}-${safeName}`
  const options = { expiryInSeconds: URL_EXPIRY_SECONDS }
  return {
    uploadUrl: await files.generatePresignURL(path, { ...options, permissions: 'w' }),
    readUrl: await files.generatePresignURL(path, { ...options, permissions: 'r' })
  }
}

function toLayerEdit (layer) {
  const edit = { id: layer.id, type: layer.type, operation: { type: 'edit' } }
  if (layer.type === 'text_layer') edit.text = { content: layer.text }
  else edit.smartObject = { smartObjectFile: { source: { url: layer.imageUrl } } }
  return edit
}

async function createVariant (params, { templateUrl, format, layers, fileName }) {
  const extension = format === 'jpeg' ? 'jpg' : 'png'
  const outputName = `${(fileName || 'variant').replace(/\.(png|jpe?g)$/i, '')}.${extension}`
  const { uploadUrl, readUrl } = await createStorageUrls('variants', outputName)
  const output = format === 'jpeg'
    ? { mediaType: 'image/jpeg', quality: 'photoshop_max' }
    : { mediaType: 'image/png', compression: 'medium' }

  await runPhotoshopJob(params, '/create-composite', {
    image: { source: { url: templateUrl } },
    edits: { layers: layers.map(toLayerEdit) },
    outputs: [{ destination: { url: uploadUrl }, ...output }]
  })
  return { imageUrl: readUrl, fileName: outputName, format }
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
  const token = await getFireflyServicesToken(params)
  const headers = { Authorization: `Bearer ${token}`, 'x-api-key': params.FIREFLY_SERVICES_API_CLIENT_ID, 'Content-Type': 'application/json' }
  const submit = await fetch(AUTO_CROP_API, {
    method: 'POST',
    headers,
    body: JSON.stringify({ image: { source: { url: imageUrl } }, mode: 'smartCrop', aspectRatio: closestAutoCropRatio(ratio) })
  })
  const { statusUrl } = await submit.json()
  if (!statusUrl) throw new Error(`auto-crop request failed (${submit.status})`)

  const deadline = Date.now() + POLL_TIMEOUT_MS
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS))
    const status = await (await fetch(statusUrl, { headers })).json()
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

// Runs all variant jobs in parallel; a failed variant does not prevent the others from being returned.
async function createVariants (params, { templateUrl, format, variants }) {
  const prepared = await cropVariantImages(params, templateUrl, variants)
  const results = await Promise.allSettled(prepared.map((variant, index) =>
    createVariant(params, { templateUrl, format, layers: variant.layers, fileName: variant.fileName || `variant-${index + 1}` })))
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
        const manifest = await generateManifest(params, url)
        const data = {
          document: {
            // Strip the upload timestamp prefix and the job id suffix added by the storage and the Photoshop API
            title: manifest.document?.title?.replace(/^\d+-([0-9a-f]{8}-)?/, '').replace(/_[0-9a-f-]{36}(\.\w+)$/, '$1'),
            width: manifest.document?.bounds?.right,
            height: manifest.document?.bounds?.bottom
          },
          layers: getEditableLayers(manifest.layers)
        }
        return {
          content: [{
            type: 'text',
            text: `Editable layers (unlocked text and smart object layers), shown to the user for selection:\n${JSON.stringify(data, null, 2)}\n\n` +
              NEXT_STEPS_AFTER_SELECTION
          }],
          structuredContent: data
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
        'then renders it as PNG or JPEG. Only call it once the layers are selected (get-psd-manifest) and all values are known. ' +
        'Pass all variants in a single call. The user sees a recap of the generated files with download buttons; do not print the image URLs. ' +
        'Use layer ids and types from get-psd-manifest. For each smart object image, pass the crop chosen in upload-variant-images; ' +
        'without crop, the image is cropped centered to its frame (fit "fill", default). Do not crop or resize images with other tools.',
      inputSchema: {
        templateUrl: z.string().url().describe('HTTPS URL of the PSD template (same URL as given to get-psd-manifest)'),
        format: z.enum(['png', 'jpeg']).default('png').describe('Output image format'),
        variants: z.array(z.object({
          fileName: z.string().optional().describe('Output file name without extension, e.g. "variant-summer"'),
          layers: z.array(layerEditSchema).min(1).describe('Edits to apply, one per layer')
        })).min(1).max(MAX_VARIANTS).optional().describe(`Variants to generate (max ${MAX_VARIANTS} per call)`),
        // Single-variant format of earlier versions, still accepted for clients holding a cached tool schema
        layers: z.array(layerEditSchema).min(1).optional().describe('Deprecated: use variants'),
        fileName: z.string().optional().describe('Deprecated: use variants')
      },
      _meta: uiMeta(VIEWS.variant)
    },
    async ({ templateUrl, format, variants, layers, fileName }) => {
      try {
        if (!variants && !layers) throw new Error('Missing "variants": pass a list of variants, each with its "layers".')
        const variantList = variants || [{ fileName, layers }]
        const results = await createVariants(params, { templateUrl, format, variants: variantList })
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
        return { content: [{ type: 'text', text: JSON.stringify(suggestion) }], structuredContent: suggestion }
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
        return { content: [{ type: 'text', text: JSON.stringify(urls) }], structuredContent: urls }
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
