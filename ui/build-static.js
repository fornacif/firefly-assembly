// 'build-static' hook of app.config.yaml: replaces the default Parcel build of web-src.
// Copies web-src as is (with the Spectrum bundle, built by the pre-app-build hook) to the folder deployed to static hosting.
const fs = require('fs')
const path = require('path')
const { WEB_SRC } = require('./build.js')

module.exports = async (config) => {
  fs.rmSync(config.web.distProd, { recursive: true, force: true })
  // Skip src/config.json, which aio generates in web-src with the action URLs, and hidden files such as .DS_Store
  fs.cpSync(WEB_SRC, config.web.distProd, {
    recursive: true,
    filter: src => !src.startsWith(path.join(WEB_SRC, 'src')) && !path.basename(src).startsWith('.')
  })
  // A truthy return value tells aio to skip its own web build
  return true
}
