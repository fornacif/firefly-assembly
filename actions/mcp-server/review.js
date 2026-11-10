// Visuals of the generated variants for the review by the assistant (review-variants): the assistant reads images given in a
// tool result, not their URLs, so each visual is downloaded, reduced (fewer tokens, a smaller result) and given as a JPEG.
const jpeg = require('jpeg-js')

// Longest side of a visual shown to the assistant, in pixels, and its JPEG quality
const REVIEW_MAX_SIDE = 640
const REVIEW_JPEG_QUALITY = 70

// Pixels of a PNG or JPEG image: { width, height, data } in RGBA.
function decodeImage (image) {
  if (image.readUInt32BE(0) === 0x89504e47) return require('pngjs').PNG.sync.read(image)
  if (image[0] === 0xff && image[1] === 0xd8) return jpeg.decode(image, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 1024 })
  throw new Error('the visual is neither a PNG nor a JPEG image')
}

// Image reduced so that its longest side is at most maxSide, each pixel the average of the pixels it covers.
function reduce (pixels, maxSide) {
  const scale = Math.min(1, maxSide / Math.max(pixels.width, pixels.height))
  if (scale === 1) return pixels
  const width = Math.max(1, Math.round(pixels.width * scale))
  const height = Math.max(1, Math.round(pixels.height * scale))
  const data = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor(y / scale)
    const y1 = Math.max(y0 + 1, Math.min(pixels.height, Math.floor((y + 1) / scale)))
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor(x / scale)
      const x1 = Math.max(x0 + 1, Math.min(pixels.width, Math.floor((x + 1) / scale)))
      const sum = [0, 0, 0]
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * pixels.width + sx) * 4
          sum[0] += pixels.data[i]
          sum[1] += pixels.data[i + 1]
          sum[2] += pixels.data[i + 2]
        }
      }
      const count = (y1 - y0) * (x1 - x0)
      const o = (y * width + x) * 4
      data[o] = sum[0] / count
      data[o + 1] = sum[1] / count
      data[o + 2] = sum[2] / count
      data[o + 3] = 255
    }
  }
  return { width, height, data }
}

// Visual reduced for the assistant: { data (base64 JPEG), mimeType, width, height }.
function reviewImage (image) {
  const reduced = reduce(decodeImage(image), REVIEW_MAX_SIDE)
  const encoded = jpeg.encode(reduced, REVIEW_JPEG_QUALITY)
  return { data: Buffer.from(encoded.data).toString('base64'), mimeType: 'image/jpeg', width: reduced.width, height: reduced.height }
}

module.exports = { reviewImage }
