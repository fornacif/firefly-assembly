// Reads the texts of a rendered visual with Tesseract, to check that the texts sent are all in it. tesseract.js-core embeds its
// WebAssembly in the script, so it runs in the bundled action, in the main thread (a text area takes about 50 ms).
// Latin script only: the English model, downloaded once per container, reads all the languages written in it, without their
// accents, so texts are compared without accents and case. Texts in other scripts are not checked.
const zlib = require('zlib')

const MODEL_URL = 'https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz'
const MODEL_DOWNLOAD_TIMEOUT_MS = 20000

let engine = null

// Recognition engine, created once; a failed download is tried again on the next call.
function getEngine () {
  engine = engine || loadEngine().catch(error => { engine = null; throw error })
  return engine
}

async function loadEngine () {
  // Required here: the engine (4 MB of script) is only loaded by the requests that read visuals
  const TesseractCore = require('tesseract.js-core/tesseract-core-simd-lstm.wasm.js')
  const [tesseract, response] = await Promise.all([
    // Without the warnings it prints about parameters of older models
    TesseractCore({ print: () => {}, printErr: () => {} }),
    fetch(MODEL_URL, { signal: AbortSignal.timeout(MODEL_DOWNLOAD_TIMEOUT_MS) })
  ])
  if (!response.ok) throw new Error(`OCR model download failed (HTTP ${response.status})`)
  tesseract.FS.writeFile('/eng.traineddata', zlib.gunzipSync(Buffer.from(await response.arrayBuffer())))
  const api = new tesseract.TessBaseAPI()
  if (api.Init('/', 'eng') !== 0) throw new Error('OCR model could not be loaded')
  return { tesseract, api }
}

// Letters without accents and case; letters that do not decompose are spelled out
const SPELLED = { ß: 'ss', æ: 'ae', œ: 'oe', ø: 'o', ł: 'l', đ: 'd', ð: 'd', þ: 'th', ı: 'i' }
const normalize = text => text.toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '').replace(/[ßæœøłđðþı]/g, c => SPELLED[c])

const wordsOf = text => normalize(text).match(/[\p{L}\p{N}]+/gu) || []
const isLatin = text => !/[^\p{Script=Latin}\p{Script=Common}\p{M}]/u.test(text)

function editDistance (a, b) {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    for (let j = 1; j <= b.length; j++) row.push(Math.min(previous[j] + 1, row[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)))
    previous = row
  }
  return previous[b.length]
}

// A word read with at most one error in four letters is the word
function isClose (word, read) {
  const allowed = Math.floor(word.length / 4)
  return Math.abs(read.length - word.length) <= allowed && editDistance(read, word) <= allowed
}

const MAX_BROKEN_FIT = 0.95
const READ_EXCERPT_LENGTH = 60

// Compares the expected text with the text read, line by line. Each word read is used once ("new" twice in the text needs it
// twice in the visual). A word not read whole but as the end of a line and the start of the next is broken across lines: a
// paragraph box too narrow for it at this font size, where Photoshop breaks the word without hyphen. A longer word found in
// the text read joined, on one line, is read split in two by the OCR. Returns { missing: [words], broken: [{ word, fit }] }, fit being about
// the font scale at which the word fits on one line: the letters of its first line, which it fills, over those of the word.
function compareTexts (expected, read) {
  const lines = read.split('\n').map(wordsOf).filter(line => line.length)
  const lineLength = words => words.join(' ').length
  const remaining = lines.flat()
  const readJoined = remaining.join('')
  const missing = []
  const broken = []
  const use = index => { remaining.splice(index, 1); return true }
  wordsOf(expected).forEach(word => {
    // Read exactly, then broken across lines, then read with an error (a broken word is also one letter off on its first line)
    const exact = remaining.indexOf(word)
    if (exact >= 0 && use(exact)) return
    const line = lines.findIndex((words, i) => i + 1 < lines.length && words[words.length - 1] !== word &&
      isClose(word, words[words.length - 1] + lines[i + 1][0]))
    // Slightly smaller when the line seems long enough: letters are not all as wide
    if (line >= 0) {
      broken.push({ word, fit: Math.min(MAX_BROKEN_FIT, lineLength(lines[line]) / word.length) })
      return
    }
    const close = remaining.findIndex(r => isClose(word, r))
    if (close >= 0 && use(close)) return
    if (!(word.length > 3 && readJoined.includes(word))) missing.push(word)
  })
  return { missing, broken }
}

// Size in pixels of a PNG or JPEG image, from its header; null for another format.
function imageSize (image) {
  if (image.readUInt32BE(0) === 0x89504e47) return { width: image.readUInt32BE(16), height: image.readUInt32BE(20) }
  if (image[0] !== 0xff || image[1] !== 0xd8) return null
  // JPEG: the frame header (SOF0 to SOF15, except DHT, JPG and DAC) gives the size
  for (let offset = 2; offset + 9 < image.length;) {
    if (image[offset] !== 0xff) return null
    const marker = image[offset + 1]
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { width: image.readUInt16BE(offset + 7), height: image.readUInt16BE(offset + 5) }
    }
    offset += 2 + image.readUInt16BE(offset + 2)
  }
  return null
}

const scaleRect = (rect, sx, sy) => ({ left: rect.left * sx, top: rect.top * sy, width: rect.width * sx, height: rect.height * sy })

// Rectangle around the words read in the last recognition (from its TSV output, in image pixels), null if none.
function wordsBox (api) {
  const boxes = api.GetTSVText(0).split('\n')
    .map(row => row.split('\t'))
    // Word rows: level 5, with a text
    .filter(fields => fields[0] === '5' && fields[11]?.trim())
    .map(fields => fields.slice(6, 10).map(Number))
  if (!boxes.length) return null
  const left = Math.min(...boxes.map(([l]) => l))
  const top = Math.min(...boxes.map(([, t]) => t))
  const right = Math.max(...boxes.map(([l, , w]) => l + w))
  const bottom = Math.max(...boxes.map(([, t, , h]) => t + h))
  return { left, top, width: right - left, height: bottom - top }
}

// Checks texts in an image: [{ text, rect: { left, top, width, height } }] (in pixels of the canvas: the image may be rendered at
// another size, the areas are scaled to it and the boxes back) → per text, null when it is not
// checked (not in Latin script), otherwise { missing: [words not found], share: of the letters,
// broken: [{ word, fit }] (see compareTexts), box: rectangle of the words read in the area, read: start of the text read }.
// Throws when the OCR is not available.
async function checkTexts (image, texts, canvas) {
  const toCheck = texts.map(({ text }) => isLatin(text) && wordsOf(text).length > 0)
  if (!toCheck.some(Boolean)) return texts.map(() => null)
  const ocr = await getEngine()
  // Synchronous from here: the image and its areas are read without another call in between
  try {
    const size = imageSize(image)
    const sx = size && canvas ? size.width / canvas.width : 1
    const sy = size && canvas ? size.height / canvas.height : 1
    ocr.tesseract.FS.writeFile('/input', image)
    if (ocr.api.SetImageFile(1, 0) === 1) throw new Error('the visual could not be decoded')
    return texts.map(({ text, rect }, i) => {
      if (!toCheck[i]) return null
      const area = scaleRect(rect, sx, sy)
      ocr.api.SetRectangle(Math.round(area.left), Math.round(area.top), Math.round(area.width), Math.round(area.height))
      ocr.api.Recognize(null)
      const read = ocr.api.GetUTF8Text()
      const { missing, broken } = compareTexts(text, read)
      const box = wordsBox(ocr.api)
      return {
        missing,
        share: missing.join('').length / wordsOf(text).join('').length,
        broken,
        box: box && scaleRect(box, 1 / sx, 1 / sy),
        // What was read, on one line, to tell a misread from a missing text
        read: read.replace(/\s+/g, ' ').trim().slice(0, READ_EXCERPT_LENGTH)
      }
    })
  } catch (error) {
    // The engine may be left in a broken state (e.g. an abort of the WebAssembly module): a new one is created next time
    engine = null
    throw new Error(`OCR failed: ${error.message}`)
  }
}

// Starts loading the engine, so that it is ready when the first visual is rendered.
function warmUp () {
  getEngine().catch(error => console.warn(`OCR not available: ${error.message}`))
}

module.exports = { checkTexts, warmUp }
