// Fonts added by each user (the .otf or .ttf files of fonts that the Photoshop API does not have), kept in the database of the
// workspace (collection fonts) so that the start widget offers them again, and adds by itself those a template needs. The
// files stay in the storage of the action; the widget gets them with URLs signed again.
const { withCollection } = require('./history.js')

const COLLECTION = 'fonts'
const INDEXES = [{ userId: 1, addedAt: -1 }]
// Fonts kept per user, the oldest removed beyond
const MAX_FONTS = 100

// Names of a font file (OpenType or TrueType, the "name" table): { postScriptName, fullName, family }, the fields not found
// missing; null when the file is not a font.
function fontNames (data) {
  if (data.length < 12) return null
  const tag = data.toString('latin1', 0, 4)
  if (!['\u0000\u0001\u0000\u0000', 'OTTO', 'true'].includes(tag)) return null
  const tables = data.readUInt16BE(4)
  let name = null
  for (let i = 0; i < tables; i++) {
    const record = 12 + i * 16
    if (record + 16 > data.length) return null
    if (data.toString('latin1', record, record + 4) === 'name') name = { offset: data.readUInt32BE(record + 8), length: data.readUInt32BE(record + 12) }
  }
  if (!name || name.offset + 6 > data.length) return null
  const count = data.readUInt16BE(name.offset + 2)
  const strings = name.offset + data.readUInt16BE(name.offset + 4)
  const found = {}
  // Windows (Unicode, UTF-16BE) names first, then Macintosh (Roman) ones; English when there are several languages
  const read = (platform, id) => {
    for (let i = 0; i < count; i++) {
      const record = name.offset + 6 + i * 12
      if (record + 12 > data.length) break
      const [platformId, , language, nameId, length, offset] = [0, 2, 4, 6, 8, 10].map(k => data.readUInt16BE(record + k))
      if (platformId !== platform || nameId !== id) continue
      if (platform === 3 && language !== 0x409 && language !== 0) continue
      const start = strings + offset
      if (start + length > data.length) continue
      if (platform === 1) return data.toString('latin1', start, start + length)
      const bytes = Buffer.from(data.subarray(start, start + length))
      return bytes.swap16().toString('utf16le')
    }
    return null
  }
  for (const [field, id] of [['postScriptName', 6], ['fullName', 4], ['family', 1]]) {
    const value = read(3, id) || read(1, id)
    if (value) found[field] = value.trim()
  }
  return found
}

// Fonts of a user, the latest first: [{ id, fileName, path, postScriptName, fullName, family, addedAt }]
function listFonts (params, userId) {
  return withCollection(params, COLLECTION, fonts => fonts.find({ userId }).project({ _id: 0, userId: 0 }).sort({ addedAt: -1 }).toArray(), INDEXES)
}

// Adds a font to the library of a user (in place of a font of the same PostScript name); returns it
async function addFont (params, userId, font) {
  const entry = { id: font.id, fileName: font.fileName, path: font.path, ...font.names, addedAt: new Date() }
  await withCollection(params, COLLECTION, async fonts => {
    if (entry.postScriptName) await fonts.deleteMany({ userId, postScriptName: entry.postScriptName })
    await fonts.insertOne({ userId, ...entry })
    const extra = await fonts.find({ userId }).project({ _id: 0, id: 1 }).sort({ addedAt: -1 }).skip(MAX_FONTS).toArray()
    if (extra.length) await fonts.deleteMany({ userId, id: { $in: extra.map(f => f.id) } })
  }, INDEXES)
  return entry
}

// Removes a font from the library of a user (its file stays in storage)
function removeFont (params, userId, id) {
  return withCollection(params, COLLECTION, fonts => fonts.deleteOne({ userId, id }), INDEXES)
}

module.exports = { fontNames, listFonts, addFont, removeFont }
