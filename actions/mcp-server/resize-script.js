// UXP script run by the Photoshop API (execute-actions) to make a template of another format from a PSD: the canvas takes the
// size of the format, and each element of the template keeps its place relative to the canvas, at a scale that keeps it whole.
//
// Elements: the layers at the root of the document, a group that covers the whole canvas being opened (its children are the
// elements), and a layer clipped to another moving with it. An element that covers the canvas (a background, a photo full
// bleed) is scaled to cover the new canvas and centered; another one is scaled to fit (the smaller ratio of the widths and the
// heights, so that it is never cut and the elements do not overlap more than in the template), its center at the same place
// relative to the canvas, then moved inside the canvas if it went past an edge (keeping its margin, at its scale). A frame of an
// image (a smart object, or a layer an image is clipped to) is stretched instead: its edges keep their place relative to the
// canvas (e.g. a half of the canvas stays a half), the images being cropped to the ratio of their frame. The content of a smart
// object is not stretched (nor an image put in it later): it covers the new frame, is cut to it and wrapped in a new smart
// object of the size of the frame; a smart object clipped to a frame is scaled to cover the frame. A text then grows
// (from its center) while it has room: until it touches an element it did not touch in the template, or the canvas with its
// margin, and at most to the geometric mean of the ratios of the widths and the heights (so that a text is not cut down to the
// smaller ratio when the format is much wider or taller). Text layers are scaled like the others (their font size with them),
// smart objects keep their quality, pixel layers are resampled.
// Fill layers (solid color, gradient, pattern) and adjustment layers have no bounds of their own: they are left as they are.
//
// A layout can be given (target.layout, from the review of the formats by the assistant): a rectangle in the new canvas per
// element, by the name of its layer (or of a layer clipped to it). Such an element goes exactly there: a frame of an image is
// stretched to the rectangle, another element is scaled to fit in it (unstretched) and centered in it; it does not grow. A
// text can be given its words broken into other lines first (text, made by the server).
//
// The script is built per format by buildResizeScript: resizeTemplate is sent as source, called with the photoshop module and the
// size of the format. The module is required by the script, not by the function: the bundler of the action would otherwise
// take the require of the function for one of its own. A job whose script fails still succeeds: the error is written in the
// name of a new layer (RESIZE_FAILED), which the server looks for in the manifest of the PSD made.

// Usual formats of the social networks, in pixels, with the name of their files (slug)
const SOCIAL_FORMATS = [
  { id: 'instagram-square', name: 'Instagram post', slug: 'instagram-post', ratio: '1:1', width: 1080, height: 1080 },
  { id: 'instagram-portrait', name: 'Instagram portrait', slug: 'instagram-portrait', ratio: '4:5', width: 1080, height: 1350 },
  { id: 'story', name: 'Story / Reels', slug: 'instagram-story', ratio: '9:16', width: 1080, height: 1920 },
  { id: 'link', name: 'Facebook / LinkedIn', slug: 'facebook-linkedin', ratio: '1.91:1', width: 1200, height: 628 },
  { id: 'landscape', name: 'X / YouTube', slug: 'x-youtube', ratio: '16:9', width: 1600, height: 900 }
]

// Words of a file name that name a format (of a social network, or a size), replaced by the format of a template made from it
const FORMAT_WORDS = /(^|[-_ .])(instagram|insta|story|stories|reels?|post|portrait|square|carre|facebook|fb|linkedin|twitter|x|youtube|yt|tiktok|landscape|paysage|\d{2,5}x\d{2,5})(?=$|[-_ .])/gi

// File name of the template made in a format from another one: the name of the template without the words of its format, then
// the format (e.g. instagram-story.psd: instagram-post.psd; summer-sale-story.psd: summer-sale_instagram-post.psd)
function formatFileName (sourceName, format) {
  let base = String(sourceName || '').replace(/\.psd$/i, '')
  for (let previous = null; previous !== base;) { previous = base; base = base.replace(FORMAT_WORDS, '$1') }
  base = base.replace(/[-_ .]{2,}/g, match => match[0]).replace(/^[-_ .]+|[-_ .]+$/g, '')
  return `${base ? base + '_' : ''}${format.slug}.psd`
}

// Prefix of the name of the layer that tells the error of the script
const RESIZE_FAILED = 'resize failed: '

// Runs in Photoshop: no closure (the function is sent as its source)
async function resizeTemplate (photoshop, target) {
  const { app, core, action, constants } = photoshop
  const RESIZE_FAILED_NAME = target.failed

  // Share of the canvas an element covers in both directions to count as a background
  const COVER_SHARE = 0.9
  // Largest margin a text keeps to the edges of the canvas when it grows (share of the smaller side of the canvas)
  const SAFE_MARGIN = 0.05
  // Kinds of layers with no bounds of their own
  const UNBOUNDED = /solidColor|gradientFill|pattern|brightnessContrast|levels|curves|exposure|vibrance|hueSaturation|colorBalance|blackAndWhite|photoFilter|channelMixer|colorLookup|invert|posterize|threshold|selectiveColor|gradientMap/i

  const box = bounds => ({ left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom })
  const width = b => b.right - b.left
  const height = b => b.bottom - b.top
  const isEmpty = b => !b || width(b) <= 0 || height(b) <= 0
  const union = (a, b) => isEmpty(a) ? b : isEmpty(b) ? a
    : { left: Math.min(a.left, b.left), top: Math.min(a.top, b.top), right: Math.max(a.right, b.right), bottom: Math.max(a.bottom, b.bottom) }
  const overlaps = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
  const isGroup = layer => layer.kind === constants.LayerKind.GROUP
  const isUnbounded = layer => UNBOUNDED.test(String(layer.kind))

  // The Background layer cannot move: it becomes a normal layer
  async function unlockBackground (doc) {
    const background = doc.layers.find(layer => layer.isBackgroundLayer)
    if (!background) return
    await action.batchPlay([{
      _obj: 'set',
      _target: [{ _ref: 'layer', _property: 'background' }],
      to: { _obj: 'layer', opacity: 100, mode: { _enum: 'blendMode', _value: 'normal' } }
    }], {})
  }

  // Elements of a list of sibling layers: each layer with the layers clipped to it (above it in the panel, so before it in
  // the list, which goes from the top to the bottom)
  function elementsOf (layers, canvas) {
    const elements = []
    let clipped = []
    for (const layer of layers) {
      if (!layer.visible || isUnbounded(layer)) { if (!layer.isClippingMask) clipped = []; continue }
      if (layer.isClippingMask) { clipped.push(layer); continue }
      const members = [layer, ...clipped]
      clipped = []
      const bounds = members.reduce((all, member) => union(all, box(member.bounds)), null)
      if (isEmpty(bounds)) continue
      const covers = width(bounds) >= canvas.width * COVER_SHARE && height(bounds) >= canvas.height * COVER_SHARE
      // A group over the whole canvas holds the elements (e.g. the whole template in one group)
      if (covers && isGroup(layer) && members.length === 1) elements.push(...elementsOf(layer.layers, canvas))
      // A frame of an image (a smart object, or a layer an image is clipped to) is stretched: the image is cropped to the ratio
      // of its frame when a variant is generated
      else elements.push({ members, bounds, covers, stretches: !covers && members.some(member => member.kind === constants.LayerKind.SMARTOBJECT) })
    }
    return elements
  }

  // batchPlay does not throw when a command fails: it answers an error descriptor, thrown here
  async function play (descriptors) {
    const results = await action.batchPlay(descriptors, {})
    const failed = results.find(result => result && (result._obj === 'error' || typeof result.message === 'string'))
    if (failed) throw new Error(failed.message || 'A Photoshop command failed')
  }

  // The transforms act on the active layer (whatever the layer they are called on)
  const select = layer => action.batchPlay([{ _obj: 'select', _target: [{ _ref: 'layer', _id: layer.id }], makeVisible: false }], {})

  // A smart object put in a frame of another ratio, unstretched: its content covers the frame (scaled the same in both
  // directions), is merged into a layer filled at 1% over the frame (so that the frame is the bounds even where the content is
  // transparent), whose pixels in the frame are copied to a new layer (Layer via Copy: the frame for bounds; cleared pixels would
  // still count), wrapped in a new smart object of the size of the frame (Convert to Smart Object).
  // An image put in it when a variant is generated (cropped to the ratio of the frame) fills it. The layer keeps its name.
  async function frameSmartObject (layer, frame) {
    const name = layer.name
    const rectangle = {
      _obj: 'rectangle',
      top: { _unit: 'pixelsUnit', _value: Math.round(frame.top) },
      left: { _unit: 'pixelsUnit', _value: Math.round(frame.left) },
      bottom: { _unit: 'pixelsUnit', _value: Math.round(frame.bottom) },
      right: { _unit: 'pixelsUnit', _value: Math.round(frame.right) }
    }
    const selection = [{ _ref: 'channel', _property: 'selection' }]
    const current = [{ _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }]
    await select(layer)
    // The layer at 1% over the frame, moved under the content, then the content merged into it (a layer of pixels), cut to the
    // frame and wrapped in a new smart object
    await play([
      { _obj: 'set', _target: selection, to: rectangle },
      { _obj: 'make', _target: [{ _ref: 'layer' }] },
      { _obj: 'fill', using: { _enum: 'fillContents', _value: 'black' }, opacity: { _unit: 'percentUnit', _value: 1 }, mode: { _enum: 'blendMode', _value: 'normal' } },
      { _obj: 'set', _target: selection, to: { _enum: 'ordinal', _value: 'none' } },
      { _obj: 'move', _target: current, to: { _ref: 'layer', _enum: 'ordinal', _value: 'previous' } }
    ])
    await select(layer)
    await play([{ _obj: 'mergeLayersNew' }])
    // The pixels of the frame copied to a new layer (Layer via Copy: bounds of the frame), the merged layer deleted
    const merged = app.activeDocument.activeLayers[0]
    await play([{ _obj: 'set', _target: selection, to: rectangle }, { _obj: 'copyToLayer' }, { _obj: 'set', _target: selection, to: { _enum: 'ordinal', _value: 'none' } }])
    const copy = app.activeDocument.activeLayers[0]
    if (merged && copy && copy.id !== merged.id) await play([{ _obj: 'delete', _target: [{ _ref: 'layer', _id: merged.id }] }])
    if (copy) await select(copy)
    await play([{ _obj: 'newPlacedLayer' }])
    const framed = app.activeDocument.activeLayers[0]
    if (framed && framed.name !== name) framed.name = name
  }

  // Scales a layer by k around its own center, then moves its center to the point given
  async function place (layer, kx, ky, centerX, centerY) {
    await select(layer)
    if (layer.allLocked) layer.allLocked = false
    if (layer.positionLocked) layer.positionLocked = false
    if (Math.abs(kx - 1) > 0.001 || Math.abs(ky - 1) > 0.001) await layer.scale(kx * 100, ky * 100, constants.AnchorPosition.MIDDLECENTER)
    const b = box(layer.bounds)
    const dx = centerX - (b.left + b.right) / 2
    const dy = centerY - (b.top + b.bottom) / 2
    if (Math.abs(dx) > 0.01 || Math.abs(dy) > 0.01) await layer.translate(dx, dy)
  }

  function findLayers (layers, name) {
    return layers.flatMap(layer => [...(layer.name === name ? [layer] : []), ...(layer.layers ? findLayers(layer.layers, name) : [])])
  }

  await core.executeAsModal(async () => {
    const doc = app.activeDocument
    try {
    // Texts broken into other lines by the layout, before they are measured
    for (const item of (target.layout || []).filter(item => item.text)) {
      for (const layer of findLayers(doc.layers, item.name).filter(layer => layer.kind === constants.LayerKind.TEXT)) {
        await select(layer)
        layer.textItem.contents = item.text
      }
    }
    const from = { width: doc.width, height: doc.height }
    const to = { width: target.width, height: target.height }
    await unlockBackground(doc)
    const elements = elementsOf(doc.layers, from)

    // The canvas around the center: the elements are measured in the new canvas from there
    await doc.resizeCanvas(to.width, to.height, constants.AnchorPosition.MIDDLECENTER)
    const offsetX = (to.width - from.width) / 2
    const offsetY = (to.height - from.height) / 2
    const ratioX = to.width / from.width
    const ratioY = to.height / from.height
    const fit = Math.min(ratioX, ratioY)
    const cover = Math.max(ratioX, ratioY)

    // Place of each element in the new canvas: its scale (kx, ky) and its center
    const plans = elements.map(element => {
      const { bounds, covers, stretches } = element
      const centerX = (bounds.left + bounds.right) / 2
      const centerY = (bounds.top + bounds.bottom) / 2
      // The rectangle given for the element, if any: there exactly
      const given = (target.layout || []).find(item => item.width > 0 && item.height > 0 && element.members.some(member => member.name === item.name))
      if (given) {
        const gx = given.width / width(bounds)
        const gy = given.height / height(bounds)
        const g = Math.min(gx, gy)
        return { ...element, kx: stretches ? gx : g, ky: stretches ? gy : g, centerX, centerY, newX: given.left + given.width / 2, newY: given.top + given.height / 2 }
      }
      const k = covers ? cover : fit
      // Center of the element in the new canvas: the middle for a background, the same place relative to the canvas otherwise
      let newX = covers ? to.width / 2 : centerX * ratioX
      let newY = covers ? to.height / 2 : centerY * ratioY
      // Margins of the template (to the nearest edges) at the scale that fits
      const marginX = Math.max(0, Math.min(bounds.left, from.width - bounds.right)) * fit
      const marginY = Math.max(0, Math.min(bounds.top, from.height - bounds.bottom)) * fit
      if (!covers && !stretches) {
        // Inside the canvas, with the margin of the template at the scale of the element (when it fits)
        const clamp = (value, half, margin, size) => half * 2 + margin * 2 > size
          ? size / 2
          : Math.min(Math.max(value, half + margin), size - half - margin)
        newX = clamp(newX, width(bounds) * k / 2, marginX, to.width)
        newY = clamp(newY, height(bounds) * k / 2, marginY, to.height)
      }
      const isText = !covers && !stretches && element.members.every(member => member.kind === constants.LayerKind.TEXT)
      return { ...element, kx: stretches ? ratioX : k, ky: stretches ? ratioY : k, centerX, centerY, newX, newY, marginX, marginY, isText }
    })
    const boxOf = (plan, kx = plan.kx, ky = plan.ky) => ({
      left: plan.newX - width(plan.bounds) * kx / 2,
      right: plan.newX + width(plan.bounds) * kx / 2,
      top: plan.newY - height(plan.bounds) * ky / 2,
      bottom: plan.newY + height(plan.bounds) * ky / 2
    })

    // The texts grow while they have room, one after the other (each one with the room the others left). The margin kept to the
    // edges of the canvas is the one of the template, at most a share of the canvas (a text far from an edge is not held by it)
    const most = Math.sqrt(ratioX * ratioY)
    const edge = SAFE_MARGIN * Math.min(to.width, to.height)
    if (most > fit) {
      for (const plan of plans.filter(p => p.isText)) {
        const others = plans.filter(other => other !== plan && !other.covers && !overlaps(other.bounds, plan.bounds))
        const marginX = Math.min(plan.marginX, edge)
        const marginY = Math.min(plan.marginY, edge)
        const fits = k => {
          const b = boxOf(plan, k, k)
          return b.left >= marginX - 0.5 && b.right <= to.width - marginX + 0.5 &&
            b.top >= marginY - 0.5 && b.bottom <= to.height - marginY + 0.5 &&
            others.every(other => !overlaps(b, boxOf(other)))
        }
        let low = plan.kx
        let high = most
        if (fits(high)) low = high
        else for (let i = 0; i < 20; i++) { const mid = (low + high) / 2; if (fits(mid)) low = mid; else high = mid }
        plan.kx = plan.ky = low
      }
    }

    for (const { members, kx, ky, centerX, centerY, newX, newY, stretches } of plans) {
      // Each member keeps its place relative to the center of the element, at its scale (a stretched frame has its edges at the
      // same place relative to the canvas); the bounds of the layers are read in the new canvas: moved by the offset of the canvas
      for (const member of members) {
        const b = box(member.bounds)
        const memberX = (b.left + b.right) / 2 - offsetX
        const memberY = (b.top + b.bottom) / 2 - offsetY
        const x = newX + (memberX - centerX) * kx
        const y = newY + (memberY - centerY) * ky
        const isSmartObject = member.kind === constants.LayerKind.SMARTOBJECT
        const k = Math.max(kx, ky)
        // An image clipped to a frame covers the frame, unstretched
        if (stretches && isSmartObject && member !== members[0]) await place(member, k, k, x, y)
        // A smart object frame of another ratio: its content covers the new frame, cut to it
        else if (stretches && isSmartObject && Math.abs(kx - ky) > 0.001) {
          const halfW = width(b) * kx / 2
          const halfH = height(b) * ky / 2
          await place(member, k, k, x, y)
          await frameSmartObject(member, { left: x - halfW, top: y - halfH, right: x + halfW, bottom: y + halfH })
        } else await place(member, kx, ky, x, y)
      }
    }
    } catch (error) {
      await doc.createLayer({ name: (RESIZE_FAILED_NAME + String(error && (error.message || error))).slice(0, 250) })
    }
  }, { commandName: `Resize to ${target.width}x${target.height}` })
}

// Source of the script for a format ({ width, height } in pixels), with the layout given if any ([{ name, left, top, width,
// height, text }] in pixels of the format)
function buildResizeScript ({ width, height }, layout) {
  if (!(width > 0 && height > 0)) throw new Error('The size of the format is missing.')
  const target = { width: Math.round(width), height: Math.round(height), failed: RESIZE_FAILED, ...(layout?.length ? { layout } : {}) }
  return `const photoshop = require('photoshop');\n${resizeTemplate.toString()}\nawait resizeTemplate(photoshop, ${JSON.stringify(target)});\n`
}

module.exports = { SOCIAL_FORMATS, RESIZE_FAILED, formatFileName, buildResizeScript }
