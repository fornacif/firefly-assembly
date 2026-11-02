// Reads the texts of a rendered visual with Tesseract, to check that the texts sent are all in it. tesseract.js-core embeds its
// WebAssembly in the script, so it runs in the bundled action, in the main thread (a text area takes about 50 ms).
// Latin script only, with the model of the language of the text (English, French, German, Spanish or Italian), which reads its
// accents and knows its words (the English model reads "là" as "Iq"); the English model for the other languages. Models are
// downloaded once per container. Texts are compared without accents and case. Texts in other scripts are not checked.
const zlib = require('zlib')

// Tesseract models of the languages read, by ISO 639-1 code
const MODELS = { en: 'eng', fr: 'fra', de: 'deu', es: 'spa', it: 'ita' }
const DEFAULT_LANGUAGE = 'en'
const modelUrl = model => `https://cdn.jsdelivr.net/npm/@tesseract.js-data/${model}/4.0.0_best_int/${model}.traineddata.gz`
const MODEL_DOWNLOAD_TIMEOUT_MS = 20000
// Tesseract page segmentation mode 6: a single uniform block of text
const SINGLE_BLOCK = '6'
// Height of a line of text, in pixels, below which an area is enlarged before it is read (Tesseract reads best letters about
// 20 to 30 px high), up to MAX_UPSCALE times
const MIN_LINE_HEIGHT = 40
const MAX_UPSCALE = 3

let engine = null
const readers = new Map()

// Recognition engine, created once; a failed load is tried again on the next call.
function getEngine () {
  // Required here: the engine (4 MB of script) is only loaded by the requests that read visuals. Without the warnings it
  // prints about parameters of older models.
  engine = engine || Promise.resolve()
    .then(() => require('tesseract.js-core/tesseract-core-simd-lstm.wasm.js')({ print: () => {}, printErr: () => {} }))
    .catch(error => { engine = null; throw error })
  return engine
}

// Reader of a language: the engine with its model, created once per language; a failed download is tried again on the next call.
function getReader (language) {
  const model = MODELS[language] || MODELS[DEFAULT_LANGUAGE]
  if (!readers.has(model)) readers.set(model, loadReader(model).catch(error => { readers.delete(model); throw error }))
  return readers.get(model)
}

async function loadReader (model) {
  const [tesseract, response] = await Promise.all([
    getEngine(),
    fetch(modelUrl(model), { signal: AbortSignal.timeout(MODEL_DOWNLOAD_TIMEOUT_MS) })
  ])
  if (!response.ok) throw new Error(`OCR model ${model} download failed (HTTP ${response.status})`)
  tesseract.FS.writeFile(`/${model}.traineddata`, zlib.gunzipSync(Buffer.from(await response.arrayBuffer())))
  const api = new tesseract.TessBaseAPI()
  if (api.Init('/', model) !== 0) throw new Error(`OCR model ${model} could not be loaded`)
  // Each area read is one text layer: read as one block of text. The default page layout analysis looks for blocks of text,
  // and finds none in a text over a photo or a texture.
  api.SetVariable('tessedit_pageseg_mode', SINGLE_BLOCK)
  return { tesseract, api }
}

// Letters without accents and case; letters that do not decompose are spelled out
const SPELLED = { ß: 'ss', æ: 'ae', œ: 'oe', ø: 'o', ł: 'l', đ: 'd', ð: 'd', þ: 'th', ı: 'i' }
const normalize = text => text.toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '').replace(/[ßæœøłđðþı]/g, c => SPELLED[c])

const wordsOf = text => normalize(text).match(/[\p{L}\p{N}]+/gu) || []
const isLatin = text => !/[^\p{Script=Latin}\p{Script=Common}\p{M}]/u.test(text)

// Small words of each language, to tell the language of a text that has none given
const COMMON_WORDS = {
  en: 'the and of to for with your you our is are on in new now at this all from get off free shop discover',
  fr: 'le les un une des et est du de pour avec votre vos nos notre sur dans au aux ce qui plus en decouvrez jusqu nouvelle nouveautes offre',
  de: 'der die das und ist mit fur ihr ihre unser unsere auf im ein eine den dem zu jetzt neu von bis entdecken angebot',
  es: 'el los las y es con para tu tus su sus nuestra nuestro del de en por hasta ya mas nuevo nueva descubre oferta ahora todo',
  it: 'il lo gli e con per tuo tua tuoi nostra nostro del della di in sul al nei dei delle fino ora nuovo nuova che scopri offerta'
}
const commonWords = Object.fromEntries(Object.entries(COMMON_WORDS).map(([language, words]) => [language, new Set(words.split(' '))]))

// Language of a text, from its small words: the language with most of them, English if none.
function guessLanguage (text) {
  const words = wordsOf(text)
  let best = DEFAULT_LANGUAGE
  let bestCount = 0
  for (const [language, set] of Object.entries(commonWords)) {
    const count = words.filter(word => set.has(word)).length
    if (count > bestCount) { best = language; bestCount = count }
  }
  return best
}

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

// Font scale proposed at most for a word broken across lines
const MAX_BROKEN_FIT = 0.95
// A word read is at most this many times as wide as its letters at the median width of the letters read; a word misread (or
// read joined with others) as its letters with a punctuation sign, PUNCTUATION_LETTERS wide
const WORD_WIDTH_TOLERANCE = 1.4
const MISREAD_WIDTH_TOLERANCE = 1.1
const PUNCTUATION_LETTERS = 0.5
const READ_EXCERPT_LENGTH = 60

// Compares the expected text with the text read, line by line. Each word read is used once ("new" twice in the text needs it
// twice in the visual). A word not read whole but as the end of a line and the start of the next is broken across lines: a
// paragraph box too narrow for it at this font size, where Photoshop breaks the word without hyphen. A longer word found in
// the text read joined, on one line, is read split in two by the OCR. Returns { missing: [words], broken: [{ word, fit }],
// missingAt: 'end' | 'start' | 'middle' | null }, fit being about the font scale at which the word fits on one line: the letters of
// its first line, which it fills, over those of the word.
function compareTexts (expected, read) {
  const lines = read.split('\n').map(wordsOf).filter(line => line.length)
  const lineLength = words => words.join(' ').length
  const remaining = lines.flat()
  const readJoined = remaining.join('')
  const missing = []
  const missingIndexes = []
  const broken = []
  const use = index => { remaining.splice(index, 1); return true }
  const expectedWords = wordsOf(expected)
  expectedWords.forEach((word, wordIndex) => {
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
    // Words read joined (e.g. "jointheclub"): a longer word in the text read, or a shorter one with a word next to it
    const before = expectedWords[wordIndex - 1]
    const after = expectedWords[wordIndex + 1]
    const joined = (word.length > 3 && readJoined.includes(word)) ||
      (before && readJoined.includes(before + word)) || (after && readJoined.includes(word + after))
    if (!joined) {
      missing.push(word)
      missingIndexes.push(wordIndex)
    }
  })
  // Where the missing words are: the last ones (a text cut at its end), the first ones, or elsewhere
  const missingAt = !missing.length ? null
    : missingIndexes.every((index, k) => index === expectedWords.length - missing.length + k) ? 'end'
      : missingIndexes.every((index, k) => index === k) ? 'start' : 'middle'
  return { missing, broken, missingAt }
}

// Pixels of a PNG or JPEG image: { width, height, data } in RGBA.
function decodeImage (image) {
  if (image.readUInt32BE(0) === 0x89504e47) return require('pngjs').PNG.sync.read(image)
  if (image[0] === 0xff && image[1] === 0xd8) return require('jpeg-js').decode(image, { useTArray: true, formatAsRGBA: true })
  throw new Error('the visual is neither a PNG nor a JPEG image')
}

// Area of an image, enlarged scale times (bilinear), as a PPM image (RGB), which Tesseract reads without decoding.
function areaImage (pixels, area, scale) {
  const width = Math.max(1, Math.round(area.width * scale))
  const height = Math.max(1, Math.round(area.height * scale))
  const header = Buffer.from(`P6\n${width} ${height}\n255\n`)
  const out = Buffer.alloc(header.length + width * height * 3)
  header.copy(out)
  const at = (x, y, c) => pixels.data[(Math.min(y, pixels.height - 1) * pixels.width + Math.min(x, pixels.width - 1)) * 4 + c]
  let o = header.length
  for (let y = 0; y < height; y++) {
    const sy = Math.max(0, area.top + (y + 0.5) / scale - 0.5)
    const y0 = Math.floor(sy)
    const fy = sy - y0
    for (let x = 0; x < width; x++) {
      const sx = Math.max(0, area.left + (x + 0.5) / scale - 0.5)
      const x0 = Math.floor(sx)
      const fx = sx - x0
      for (let c = 0; c < 3; c++) {
        const top = at(x0, y0, c) * (1 - fx) + at(x0 + 1, y0, c) * fx
        const bottom = at(x0, y0 + 1, c) * (1 - fx) + at(x0 + 1, y0 + 1, c) * fx
        out[o++] = Math.round(top * (1 - fy) + bottom * fy)
      }
    }
  }
  return out
}

const scaleRect = (rect, sx, sy) => ({ left: rect.left * sx, top: rect.top * sy, width: rect.width * sx, height: rect.height * sy })

// Words of the last recognition, from its TSV output: [{ text, line, box: { left, top, width, height } }] in image pixels.
function readWords (api) {
  return api.GetTSVText(0).split('\n')
    .map(row => row.split('\t'))
    // Word rows: level 5, with a text
    .filter(fields => fields[0] === '5' && fields[11]?.trim())
    .map(fields => {
      const [left, top, width, height] = fields.slice(6, 10).map(Number)
      // Block, paragraph and line numbers
      return { text: fields[11], line: fields.slice(2, 5).join('.'), box: { left, top, width, height } }
    })
}

// Rectangle around boxes, null if none.
function unionBox (boxes) {
  if (!boxes.length) return null
  const left = Math.min(...boxes.map(b => b.left))
  const top = Math.min(...boxes.map(b => b.top))
  const right = Math.max(...boxes.map(b => b.left + b.width))
  const bottom = Math.max(...boxes.map(b => b.top + b.height))
  return { left, top, width: right - left, height: bottom - top }
}

// Rectangle of the words of the expected text in the words read: for each expected word, the nearest word read that is it, or
// a piece of it (broken across lines), or words read joined with it. Words of other texts read in the area are left out. A word
// read joined with several words of the text counts once.
function textBox (expected, words, near) {
  const distance = box => Math.hypot(box.left + box.width / 2 - near.x, box.top + box.height / 2 - near.y)
  const candidates = words.map(word => ({ ...word, tokens: wordsOf(word.text) }))
  // Word read → the expected word it is
  const used = new Map()
  wordsOf(expected).forEach(word => {
    // The word, a piece of it (broken across lines), words read joined with it (at least 3 letters, to be specific), or the word
    // with a letter more (e.g. "da," read "day": a punctuation sign read as a letter)
    const matches = candidates.filter(c => !used.has(c) && c.tokens.some(token => isClose(word, token) ||
      (token.length > 1 && word.includes(token)) || ((word.length > 2 || token.length === word.length + 1) && token.includes(word))))
    matches.sort((a, b) => distance(a.box) - distance(b.box))
    if (matches[0]) used.set(matches[0], word)
  })
  // A word read with what is next to it (e.g. "da," read "day" with the photo behind its comma) gets a box wider than its
  // letters: each box is cut to its letters at the median width of the letters of the words read as they are, on the side of
  // the text; a word misread to the letters of the word expected, with a punctuation sign
  const isRead = (c, word) => c.tokens.length === 1 && isClose(word, c.tokens[0])
  const letterWidths = [...used].filter(([c, word]) => isRead(c, word))
    .map(([c]) => c.box.width / Math.max(1, c.tokens[0].length)).sort((a, b) => a - b)
  if (!letterWidths.length) return unionBox([...used.keys()].map(c => c.box))
  const letterWidth = letterWidths[Math.floor(letterWidths.length / 2)]
  return unionBox([...used].map(([c, word]) => {
    const { box } = c
    const width = isRead(c, word)
      ? c.tokens[0].length * letterWidth * WORD_WIDTH_TOLERANCE
      : (Math.min(word.length, c.tokens.join('').length) + PUNCTUATION_LETTERS) * letterWidth * MISREAD_WIDTH_TOLERANCE
    if (!(box.width > width)) return box
    return box.left + box.width / 2 >= near.x ? { ...box, width } : { ...box, left: box.left + box.width - width, width }
  }))
}

// Checks texts in an image: [{ text, rect, near, language, lineHeight }] in pixels of the canvas (the image may be rendered at
// another size: the areas are scaled to it, and the boxes back), near being the point where the text is expected (the center of
// rect by default), language its ISO 639-1 code (guessed from the text by default) and lineHeight the expected height of its
// lines (areas with smaller lines are enlarged before they are read)
// → per text, null when it is not checked (not in Latin script), otherwise { missing: [words not found], share: of the letters,
// broken: [{ word, fit }] and missingAt (see compareTexts), box: rectangle of the words of the text read, lines: [{ box, letters }]
// of the lines read, read: start of the text read }.
// Throws when the OCR is not available.
async function checkTexts (image, texts, canvas) {
  const toCheck = texts.map(({ text }) => isLatin(text) && wordsOf(text).length > 0)
  if (!toCheck.some(Boolean)) return texts.map(() => null)
  const languages = texts.map(({ text, language }) => MODELS[language] ? language : guessLanguage(text))
  const ocr = Object.fromEntries(await Promise.all([...new Set(languages.filter((_, i) => toCheck[i]))]
    .map(async language => [language, await getReader(language)])))
  // Synchronous from here: the areas are read without another call in between
  try {
    const pixels = decodeImage(image)
    const sx = canvas ? pixels.width / canvas.width : 1
    const sy = canvas ? pixels.height / canvas.height : 1
    return texts.map(({ text, rect, near, lineHeight }, i) => {
      if (!toCheck[i]) return null
      const { tesseract, api } = ocr[languages[i]]
      // The area in the image, and how much it is enlarged
      const left = Math.max(0, Math.round(rect.left * sx))
      const top = Math.max(0, Math.round(rect.top * sy))
      const area = {
        left,
        top,
        width: Math.min(pixels.width, Math.round((rect.left + rect.width) * sx)) - left,
        height: Math.min(pixels.height, Math.round((rect.top + rect.height) * sy)) - top
      }
      // Out of the image: nothing read
      if (area.width < 1 || area.height < 1) {
        return { missing: wordsOf(text), share: 1, broken: [], missingAt: 'middle', box: null, lines: [], read: '' }
      }
      const scale = lineHeight ? Math.min(MAX_UPSCALE, Math.max(1, MIN_LINE_HEIGHT / (lineHeight * sy))) : 1
      tesseract.FS.writeFile('/input', areaImage(pixels, area, scale))
      if (api.SetImageFile(1, 0) === 1) throw new Error('the visual could not be read')
      api.Recognize(null)
      // Boxes in pixels of the image
      const words = readWords(api).map(word => ({
        ...word,
        box: { left: area.left + word.box.left / scale, top: area.top + word.box.top / scale, width: word.box.width / scale, height: word.box.height / scale }
      }))
      // The text read, line by line
      const read = words.reduce((lines, word, k) => lines + (k && word.line !== words[k - 1].line ? '\n' : k ? ' ' : '') + word.text, '')
      const { missing, broken, missingAt } = compareTexts(text, read)
      const center = near || { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
      // Each line read: its rectangle and its letters
      const lines = [...new Set(words.map(word => word.line))].map(line => {
        const lineWords = words.filter(word => word.line === line)
        return { box: scaleRect(unionBox(lineWords.map(word => word.box)), 1 / sx, 1 / sy), letters: wordsOf(lineWords.map(word => word.text).join(' ')).join('').length }
      })
      const box = textBox(text, words, { x: center.x * sx, y: center.y * sy })
      return {
        missing,
        share: missing.join('').length / wordsOf(text).join('').length,
        broken,
        missingAt,
        box: box && scaleRect(box, 1 / sx, 1 / sy),
        lines,
        // What was read, on one line, to tell a misread from a missing text
        read: read.replace(/\s+/g, ' ').trim().slice(0, READ_EXCERPT_LENGTH)
      }
    })
  } catch (error) {
    // The engine may be left in a broken state (e.g. an abort of the WebAssembly module): a new one is created next time
    engine = null
    readers.clear()
    throw new Error(`OCR failed: ${error.message}`)
  }
}

// Starts loading the engine and the models of languages (ISO 639-1 codes; English by default), so that they are ready when the
// first visual is rendered.
function warmUp (languages = [DEFAULT_LANGUAGE]) {
  for (const language of new Set(languages)) getReader(language).catch(error => console.warn(`OCR not available: ${error.message}`))
}

module.exports = { checkTexts, guessLanguage, warmUp }
