// HTML views (MCP Apps) rendered by the host next to tool results, built with Spectrum 2 (Spectrum Web Components).
// The components are bundled by ui/build.js and served by the action at scriptUrl (see index.js).

const BASE_STYLE = `
  * { box-sizing: border-box; }
  [hidden] { display: none !important; }
  html, body { margin: 0; padding: 0; background: transparent; }
  sp-theme {
    display: block;
    padding: var(--spectrum-spacing-300);
    background: var(--spectrum-background-base-color);
    color: var(--spectrum-neutral-content-color-default);
    font-family: var(--spectrum-sans-font-family-stack);
    font-size: var(--spectrum-font-size-100);
  }
  /* Hide components until their definitions are loaded from the CDN */
  :not(:defined) { visibility: hidden; }
  .status { display: block; margin-top: var(--spectrum-spacing-200); }
  .heading {
    margin: 0;
    font-size: var(--spectrum-font-size-300);
    font-weight: var(--spectrum-bold-font-weight);
  }
  .subtle { color: var(--spectrum-neutral-subdued-content-color-default); font-size: var(--spectrum-font-size-75); }
`

// JSON-RPC bridge with the host: request(), notification(), onToolResult(), setStatus(), reportSize().
const BRIDGE_SCRIPT = `
  var _id = 0;
  var _pending = {};
  var _toolResultHandler = null;
  var _toolInputHandler = null;
  // Resolved once the handshake with the host is done: host methods must not be called before
  var _readyResolve;
  var ready = new Promise(function (resolve) { _readyResolve = resolve; });

  function send(msg) { window.parent.postMessage(msg, '*'); }

  function request(method, params) {
    var id = ++_id;
    return new Promise(function (resolve, reject) {
      _pending[id] = { resolve: resolve, reject: reject };
      send({ jsonrpc: '2.0', id: id, method: method, params: params });
    });
  }

  function notification(method, params) {
    send({ jsonrpc: '2.0', method: method, params: params || {} });
  }

  function onToolResult(handler) { _toolResultHandler = handler; }
  function onToolInput(handler) { _toolInputHandler = handler; }

  window.addEventListener('message', function (event) {
    var msg = event.data;
    if (!msg || msg.jsonrpc !== '2.0') return;

    if (msg.id !== undefined && _pending[msg.id]) {
      if (msg.error) _pending[msg.id].reject(msg.error);
      else _pending[msg.id].resolve(msg.result);
      delete _pending[msg.id];
      return;
    }

    if (msg.method === 'ui/notifications/host-context-changed') {
      applyTheme(msg.params);
    } else if (msg.method === 'ui/notifications/tool-result' && _toolResultHandler) {
      _toolResultHandler(msg.params);
    } else if (msg.method === 'ui/notifications/tool-input' && _toolInputHandler) {
      _toolInputHandler((msg.params && msg.params.arguments) || {});
    }

    if (msg.method === 'ping') {
      send({ jsonrpc: '2.0', id: msg.id, result: {} });
    } else if (msg.method === 'ui/resource-teardown') {
      send({ jsonrpc: '2.0', id: msg.id, result: {} });
    }
  });

  // Follow the host's light/dark theme, falling back to the OS preference.
  var themeEl = document.querySelector('sp-theme');
  var darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
  themeEl.setAttribute('color', darkQuery.matches ? 'dark' : 'light');

  function applyTheme(ctx) {
    if (ctx && (ctx.theme === 'light' || ctx.theme === 'dark')) themeEl.setAttribute('color', ctx.theme);
  }

  function setStatus(text, isError) {
    var el = document.getElementById('status');
    el.textContent = text;
    el.setAttribute('variant', isError ? 'negative' : 'neutral');
    reportSize();
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function reportSize() {
    requestAnimationFrame(function () {
      var h = Math.ceil(document.documentElement.getBoundingClientRect().height);
      var w = Math.ceil(window.innerWidth);
      notification('ui/notifications/size-changed', { width: w, height: h });
    });
  }

  if (window.ResizeObserver) new ResizeObserver(reportSize).observe(document.body);

  function initialize(appName) {
    request('ui/initialize', {
      protocolVersion: '2026-01-26',
      appInfo: { name: appName, version: '1.0.0' },
      appCapabilities: {}
    }).then(function (result) {
      applyTheme(result.hostContext);
      notification('ui/notifications/initialized');
      reportSize();
    }).catch(function () {}).then(_readyResolve);
  }
`

// Adobe logo, in the icon slot of the AEM buttons. Inline styles, because sp-button colors (fill and stroke) the icons
// of its slot with the text color, which SVG presentation attributes do not override.
const ADOBE_ICON = '<svg slot="icon" viewBox="0 10.22 16.86 14.94" width="18" height="16" aria-hidden="true" style="fill:#eb1000;stroke:none">' +
  '<path style="fill:#eb1000;stroke:none" d="M6.27,10.22h4.39l6.2,14.94h-4.64l-3.92-9.92-2.59,6.51h3.08l1.23,3.41H0l6.27-14.94"/></svg>'

// Keep in sync with MAX_VARIANTS in tools.js
const MAX_VARIANTS_UI = 10

// Uploads a file to App Builder storage through a presigned URL from create-upload-url; resolves to { name, url }.
const UPLOAD_SCRIPT = `
  function putFile(url, file, onProgress) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open('PUT', url);
      xhr.setRequestHeader('x-ms-blob-type', 'BlockBlob');
      xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
      xhr.upload.onprogress = function (e) { if (e.lengthComputable) onProgress(e.loaded); };
      xhr.onload = function () {
        if (xhr.status >= 200 && xhr.status < 300) resolve();
        else reject(new Error('Upload of ' + file.name + ' failed (HTTP ' + xhr.status + ')'));
      };
      xhr.onerror = function () { reject(new Error('Upload of ' + file.name + ' failed (network or CORS error)')); };
      xhr.send(file);
    });
  }

  function uploadOne(file, onProgress) {
    return request('tools/call', { name: 'create-upload-url', arguments: { fileName: file.name } })
      .then(function (result) {
        if (result.isError) throw new Error(result.content[0].text);
        var urls = result.structuredContent || JSON.parse(result.content[0].text);
        return putFile(urls.uploadUrl, file, onProgress).then(function () { return { name: file.name, url: urls.readUrl }; });
      });
  }
`

// AEM Asset Selector (Content Advisor), opened in a browser tab: Claude does not let views frame experience.adobe.com.
// loadAemConfig() resolves to the config, or null when AEM is not configured; pickAemAssets() opens the selector page
// (aem-picker.html) and resolves to the assets selected there ([] if cancelled); importAemAsset() copies one to
// storage: { name, url }.
const AEM_SCRIPT = `
  var AEM_POLL_INTERVAL_MS = 3000;
  var AEM_PICK_TIMEOUT_MS = 15 * 60 * 1000;
  var aemConfig = null;
  var aemPickId = 0;

  function toolResult(result) {
    if (result.isError) throw new Error(result.content[0].text);
    return result.structuredContent || JSON.parse(result.content[0].text);
  }

  function loadAemConfig() {
    return ready
      .then(function () { return request('tools/call', { name: 'get-aem-selector-config', arguments: {} }); })
      .then(toolResult)
      .then(function (config) { aemConfig = config.enabled ? config : null; return aemConfig; })
      .catch(function () { return null; });
  }

  // Polls the session until the selection is made in the tab; a new pick supersedes the previous one.
  function waitForAemSelection(sessionId, pickId, deadline) {
    return new Promise(function (resolve) { setTimeout(resolve, AEM_POLL_INTERVAL_MS); })
      .then(function () {
        if (pickId !== aemPickId) return { status: 'cancelled', assets: [] };
        return request('tools/call', { name: 'get-aem-picker-result', arguments: { sessionId: sessionId } }).then(toolResult);
      })
      .then(function (result) {
        if (result.status === 'pending' && Date.now() < deadline) return waitForAemSelection(sessionId, pickId, deadline);
        if (result.status === 'pending' || result.status === 'expired') throw new Error('The AEM selection has expired, choose again.');
        return result.assets;
      });
  }

  function pickAemAssets(multiple) {
    var pickId = ++aemPickId;
    return request('tools/call', { name: 'create-aem-picker-session', arguments: { multiple: multiple } })
      .then(toolResult)
      .then(function (session) {
        return request('ui/open-link', { url: session.pickerUrl }).then(function (result) {
          if (result && result.isError) throw new Error('The AEM selector tab could not be opened.');
          setStatus('Choose ' + (multiple ? 'the images' : 'the PSD template') + ' in the AEM tab that opened, then come back here.');
          return waitForAemSelection(session.sessionId, pickId, Date.now() + AEM_PICK_TIMEOUT_MS);
        });
      })
      .then(function (assets) {
        if (pickId === aemPickId) setStatus('');
        return assets;
      });
  }

  function importAemAsset(asset) {
    return request('tools/call', { name: 'import-aem-asset', arguments: { repositoryId: asset['repo:repositoryId'], assetId: asset['repo:assetId'] || undefined, path: asset['repo:path'] || undefined, fileName: asset['repo:name'] } })
      .then(toolResult)
      .then(function (imported) { return { name: imported.fileName, url: imported.url }; });
  }
`

function page (scriptUrl, title, style, body, script) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<script type="module" src="${scriptUrl}"></script>
<style>${BASE_STYLE}${style}</style>
</head>
<body>
<sp-theme system="spectrum-two" color="light" scale="medium">
${body}
</sp-theme>
<script>
(function () {
${BRIDGE_SCRIPT}
${script}
  initialize('${title}');
})();
</script>
</body>
</html>`
}

function getUploadViewHtml (scriptUrl) {
  return page(scriptUrl, 'Upload File', `
  sp-dropzone { width: 100%; }
  sp-illustrated-message { padding: var(--spectrum-spacing-300) 0; margin-inline: auto; }
  .browse { display: flex; justify-content: center; padding-bottom: var(--spectrum-spacing-300); }
  #file { display: none; }
  sp-progress-bar { width: 100%; margin-top: var(--spectrum-spacing-200); display: none; }
  .files { margin: var(--spectrum-spacing-200) 0 0; padding-left: var(--spectrum-spacing-400); }
`, `
<sp-dropzone id="drop">
  <sp-illustrated-message id="message" heading="Drop a file here" description="PSD, images and other files"></sp-illustrated-message>
  <div class="browse">
    <sp-button variant="accent" treatment="outline" id="browse">Browse</sp-button>
    <input type="file" id="file">
  </div>
</sp-dropzone>
<sp-progress-bar id="progress" label="Upload" progress="0"></sp-progress-bar>
<ol class="files subtle" id="files"></ol>
<sp-help-text class="status" id="status"></sp-help-text>
`, `
${UPLOAD_SCRIPT}
  var drop = document.getElementById('drop');
  var input = document.getElementById('file');
  var progress = document.getElementById('progress');
  var message = document.getElementById('message');
  var expected = 1;

  // Tool arguments: title shown in the drop zone, number of files expected (one per variant for smart object images).
  onToolInput(function (args) {
    expected = Math.max(1, Number(args.count) || 1);
    input.multiple = expected > 1;
    if (args.title) message.setAttribute('heading', args.title);
    message.setAttribute('description', expected > 1
      ? expected + ' files expected — the drop order sets the variant order'
      : 'PSD, images and other files');
    reportSize();
  });

  function upload(fileList) {
    var files = Array.prototype.slice.call(fileList || []);
    if (!files.length) return;
    if (files.length !== expected) {
      setStatus(expected + ' file(s) expected, ' + files.length + ' dropped.', true);
      return;
    }
    var total = files.reduce(function (sum, f) { return sum + f.size; }, 0) || 1;
    var loaded = files.map(function () { return 0; });
    progress.style.display = 'block';
    progress.progress = 0;
    progress.label = files.length > 1 ? files.length + ' files' : files[0].name;
    document.getElementById('files').innerHTML = files.length > 1
      ? files.map(function (f) { return '<li>' + escapeHtml(f.name) + '</li>'; }).join('') : '';
    setStatus('Uploading...');

    Promise.all(files.map(function (file, i) {
      return uploadOne(file, function (bytes) {
        loaded[i] = bytes;
        progress.progress = Math.round(loaded.reduce(function (a, b) { return a + b; }, 0) / total * 100);
      });
    }))
      .then(function (uploaded) {
        progress.progress = 100;
        var names = uploaded.map(function (u) { return u.name; }).join(', ');
        var context = 'The user uploaded ' + uploaded.length + ' file(s), in this order (URLs valid 24 hours):\\n'
          + uploaded.map(function (u, i) { return (i + 1) + '. ' + u.name + ': ' + u.url; }).join('\\n');
        setStatus(uploaded.length > 1 ? uploaded.length + ' files uploaded.' : names + ' uploaded.');
        // Put the URLs in the model context (not shown to the user), then send a short prompt so Claude continues.
        return request('ui/update-model-context', { content: [{ type: 'text', text: context }] })
          .then(function () {
            return request('ui/message', {
              role: 'user',
              content: [{ type: 'text', text: 'I uploaded ' + names + ', continue.' }]
            });
          });
      })
      .catch(function (error) {
        setStatus((error && error.message) || String(error), true);
      });
  }

  document.getElementById('browse').addEventListener('click', function () { input.click(); });
  input.addEventListener('change', function () { upload(input.files); });
  drop.addEventListener('sp-dropzone-should-accept', function (e) { e.detail.dataTransfer.dropEffect = 'copy'; });
  drop.addEventListener('sp-dropzone-drop', function (e) { upload(e.detail.dataTransfer.files); });
`)
}

function getStartViewHtml (scriptUrl) {
  return page(scriptUrl, 'Create Variants', `
  .subtle.intro { margin: var(--spectrum-spacing-75) 0 var(--spectrum-spacing-300); }
  .field { display: flex; flex-direction: column; gap: var(--spectrum-spacing-75); margin-bottom: var(--spectrum-spacing-300); }
  .field label { font-size: var(--spectrum-font-size-75); color: var(--spectrum-neutral-subdued-content-color-default); }
  .field input {
    width: 120px;
    font: inherit;
    padding: var(--spectrum-spacing-100) var(--spectrum-spacing-200);
    color: var(--spectrum-neutral-content-color-default);
    background: var(--spectrum-background-layer-2-color);
    border: 2px solid var(--spectrum-gray-300);
    border-radius: var(--spectrum-corner-radius-100);
  }
  .field input:focus { outline: none; border-color: var(--spectrum-gray-800); }
  sp-dropzone { width: 100%; }
  sp-illustrated-message { padding: var(--spectrum-spacing-300) 0; margin-inline: auto; }
  .browse { display: flex; justify-content: center; gap: var(--spectrum-spacing-200); padding-bottom: var(--spectrum-spacing-300); }
  #file { display: none; }
  sp-progress-bar { width: 100%; margin-top: var(--spectrum-spacing-200); display: none; }
  .actions { margin-top: var(--spectrum-spacing-300); display: flex; align-items: center; gap: var(--spectrum-spacing-300); }
  .actions .status { margin-top: 0; }
`, `
<h2 class="heading">Create variants</h2>
<div class="subtle intro">Set the number of variants and drop the layered PSD template.</div>
<div class="field">
  <label for="count">Number of variants (1-${MAX_VARIANTS_UI})</label>
  <input type="number" id="count" min="1" max="${MAX_VARIANTS_UI}" value="2">
</div>
<sp-dropzone id="drop">
  <sp-illustrated-message id="message" heading="Drop your PSD template" description="Layered .psd file"></sp-illustrated-message>
  <div class="browse">
    <sp-button variant="accent" treatment="outline" id="browse">Browse</sp-button>
    <sp-button variant="secondary" treatment="outline" id="aem" hidden>${ADOBE_ICON}Choose from AEM</sp-button>
    <input type="file" id="file" accept=".psd,image/vnd.adobe.photoshop">
  </div>
</sp-dropzone>
<sp-progress-bar id="progress" label="Upload" progress="0"></sp-progress-bar>
<div class="actions">
  <sp-button variant="accent" id="continue" disabled>Continue</sp-button>
  <sp-help-text class="status" id="status"></sp-help-text>
</div>
`, `
${UPLOAD_SCRIPT}
${AEM_SCRIPT}
  var countInput = document.getElementById('count');
  var input = document.getElementById('file');
  var drop = document.getElementById('drop');
  var progress = document.getElementById('progress');
  var message = document.getElementById('message');
  var continueBtn = document.getElementById('continue');
  var aemBtn = document.getElementById('aem');
  var template = null;

  function count() {
    var n = Math.round(Number(countInput.value));
    return n >= 1 && n <= ${MAX_VARIANTS_UI} ? n : null;
  }

  function updateButton() { continueBtn.disabled = !template || !count(); }

  onToolInput(function (args) {
    if (args.variantCount) countInput.value = args.variantCount;
    updateButton();
  });

  function startTransfer(name, status, indeterminate) {
    template = null;
    updateButton();
    progress.style.display = 'block';
    progress.indeterminate = indeterminate;
    progress.progress = 0;
    progress.label = name;
    setStatus(status);
  }

  function setTemplate(file) {
    template = file;
    progress.indeterminate = false;
    progress.progress = 100;
    message.setAttribute('heading', file.name);
    message.setAttribute('description', 'Uploaded — drop another file to replace it');
    setStatus('');
    updateButton();
  }

  function fail(error) {
    progress.indeterminate = false;
    setStatus((error && error.message) || String(error), true);
  }

  function upload(file) {
    if (!file) return;
    startTransfer(file.name, 'Uploading...', false);
    uploadOne(file, function (bytes) { progress.progress = Math.round(bytes / (file.size || 1) * 100); })
      .then(setTemplate)
      .catch(fail);
  }

  // The PSD picked in AEM is copied to storage by the server, like an upload.
  aemBtn.addEventListener('click', function () {
    pickAemAssets(false)
      .then(function (assets) {
        var asset = assets[0];
        if (!asset) return;
        if (!/\.psd$/i.test(asset['repo:name'])) throw new Error(asset['repo:name'] + ' is not a PSD file.');
        startTransfer(asset['repo:name'], 'Importing from AEM...', true);
        return importAemAsset(asset).then(setTemplate);
      })
      .catch(fail);
  });
  loadAemConfig().then(function (config) { aemBtn.hidden = !config; reportSize(); });

  countInput.addEventListener('input', updateButton);
  document.getElementById('browse').addEventListener('click', function () { input.value = ''; input.click(); });
  input.addEventListener('change', function () { upload(input.files[0]); });
  drop.addEventListener('sp-dropzone-should-accept', function (e) { e.detail.dataTransfer.dropEffect = 'copy'; });
  drop.addEventListener('sp-dropzone-drop', function (e) { upload(e.detail.dataTransfer.files[0]); });

  continueBtn.addEventListener('click', function () {
    var n = count();
    continueBtn.disabled = true;
    var context = 'Variant creation started. Number of variants: ' + n + '. PSD template: ' + template.name
      + ', URL (valid 24 hours): ' + template.url + '. Next step: call get-psd-manifest with this URL.';
    request('ui/update-model-context', { content: [{ type: 'text', text: context }] })
      .then(function () {
        setStatus('Template sent.');
        return request('ui/message', {
          role: 'user',
          content: [{ type: 'text', text: 'I want ' + n + ' variant(s) of ' + template.name + ', continue.' }]
        });
      })
      .catch(function (error) {
        updateButton();
        setStatus((error && error.message) || String(error), true);
      });
  });
`)
}

function getVariantImagesViewHtml (scriptUrl) {
  return page(scriptUrl, 'Variant Images', `
  .subtle.intro { margin: var(--spectrum-spacing-75) 0 var(--spectrum-spacing-300); }
  /* One card per slot (variant and smart object layer), as many per row as fit */
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: var(--spectrum-spacing-200); align-items: stretch; }
  .grid > * { min-width: 0; }
  .slot-label { width: 100%; font-weight: var(--spectrum-bold-font-weight); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .slot-empty { margin: auto 0; }
  .slot-label .layer { font-weight: normal; color: var(--spectrum-neutral-subdued-content-color-default); }
  sp-dropzone {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: flex-start;
    gap: var(--spectrum-spacing-100);
    width: 100%;
    min-width: 0;
    min-inline-size: 0;
    min-height: 110px;
    padding: var(--spectrum-spacing-200);
    --mod-drop-zone-padding: var(--spectrum-spacing-200);
    border-radius: var(--spectrum-corner-radius-200);
    text-align: center;
  }
  sp-dropzone img.thumb { max-width: 100%; max-height: 90px; object-fit: contain; border-radius: var(--spectrum-corner-radius-100); }
  .crop {
    position: relative;
    overflow: hidden;
    max-width: 100%;
    border-radius: var(--spectrum-corner-radius-100);
    background: var(--spectrum-gray-200);
    cursor: grab;
    touch-action: none;
    user-select: none;
  }
  .crop.dragging { cursor: grabbing; }
  .crop img { display: block; width: 100%; height: 100%; pointer-events: none; }
  /* Crop frame over the whole image, the parts left out by the crop are dimmed by four shades around it */
  .crop .frame { position: absolute; outline: 2px solid #ffffff; outline-offset: -1px; pointer-events: none; }
  .crop .shade { position: absolute; background: rgba(0, 0, 0, 0.6); pointer-events: none; }
  .zoom { display: flex; align-items: center; gap: var(--spectrum-spacing-100); width: 100%; font-size: var(--spectrum-font-size-75); }
  .zoom input { flex: 1; min-width: 0; accent-color: var(--spectrum-gray-800); }
  .file-name { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  sp-dropzone sp-progress-bar { width: 100%; }
  .cell-error { color: var(--spectrum-negative-content-color-default); font-size: var(--spectrum-font-size-75); }
  .actions { margin-top: var(--spectrum-spacing-300); display: flex; align-items: center; gap: var(--spectrum-spacing-300); }
  .actions .status { margin-top: 0; }
  #file { display: none; }
  .library { margin-bottom: var(--spectrum-spacing-300); }
  .library-header { display: flex; align-items: center; flex-wrap: wrap; gap: var(--spectrum-spacing-200); }
  .library-items { display: flex; flex-wrap: wrap; gap: var(--spectrum-spacing-200); padding-top: var(--spectrum-spacing-200); }
  .library-item {
    position: relative;
    flex: 0 0 96px;
    width: 96px;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: var(--spectrum-spacing-75);
    padding: var(--spectrum-spacing-75);
    font: inherit;
    font-size: var(--spectrum-font-size-75);
    color: inherit;
    background: var(--spectrum-background-layer-2-color);
    border: 2px solid transparent;
    border-radius: var(--spectrum-corner-radius-200);
    cursor: grab;
  }
  .library-item:hover, .library-item:focus-visible { border-color: var(--spectrum-gray-400); outline: none; }
  .library-item.armed { border-color: var(--spectrum-accent-background-color-default); }
  .library-item.busy { cursor: default; }
  .library-item .file-name { display: block; width: 100%; }
  .library-remove {
    position: absolute;
    top: 4px;
    right: 4px;
    width: 20px;
    height: 20px;
    padding: 0;
    font: inherit;
    font-size: 13px;
    line-height: 18px;
    color: var(--spectrum-neutral-content-color-default);
    background: var(--spectrum-background-layer-2-color);
    border: 1px solid var(--spectrum-gray-400);
    border-radius: 50%;
    cursor: pointer;
  }
  .library-remove:hover { background: var(--spectrum-gray-200); }
  .library-item img { width: 100%; height: 64px; object-fit: contain; border-radius: var(--spectrum-corner-radius-100); background: var(--spectrum-gray-200); }
  .library-item sp-progress-bar { width: 100%; }
  .grid.armed sp-dropzone { cursor: copy; }
`, `
<h2 class="heading" id="title">Drop one image per variant</h2>
<div class="subtle intro">Add images, then drag each one onto the slots that use it (or drop a file on a slot). The bright area is what the banner shows: drag it to reposition the crop, use Zoom to resize it.</div>
<div class="library">
  <div class="library-header">
    <sp-button size="s" variant="secondary" treatment="outline" id="browse">Add images from your computer</sp-button>
    <sp-button size="s" variant="secondary" treatment="outline" id="aem" hidden>${ADOBE_ICON}Add images from AEM</sp-button>
    <span class="subtle" id="library-hint"></span>
  </div>
  <div class="library-items" id="library-items" hidden></div>
</div>
<div class="grid" id="grid"></div>
<input type="file" id="file" accept="image/*" multiple>
<div class="actions">
  <sp-button variant="accent" id="confirm" disabled>Confirm images</sp-button>
  <sp-help-text class="status" id="status"></sp-help-text>
</div>
`, `
${UPLOAD_SCRIPT}
${AEM_SCRIPT}
  var CROP_MAX_HEIGHT = 160;
  var MAX_ZOOM = 4;
  var grid = document.getElementById('grid');
  var input = document.getElementById('file');
  var confirmBtn = document.getElementById('confirm');
  var variants = [];
  var layers = [];
  var slots = [];
  var BUSY_LABELS = { uploading: 'Uploading', framing: 'Framing the subject' };
  // Images added from the computer or AEM, in the order of addition:
  // { status: 'uploading' | 'importing' | 'done' | 'error', name, progress, url, error }.
  // A done image is assigned to slots by dragging it onto them, or by clicking it ("armed") then the slots.
  var LIBRARY_DRAG_TYPE = 'application/x-assemble-library-index';
  var aemBtn = document.getElementById('aem');
  var libraryItems = document.getElementById('library-items');
  var libraryHint = document.getElementById('library-hint');
  var library = [];
  var armed = -1;

  // Slots are stored row by row: index = variant * layers.length + layer.
  function layerOf(index) { return layers[index % layers.length]; }
  function ratioOf(index) { var l = layerOf(index); return l.width && l.height ? l.width / l.height : null; }

  // Largest crop at the frame ratio that fits in the image (zoom 1).
  function maxCropSize(slot, ratio) {
    var width = Math.min(slot.image.width, slot.image.height * ratio);
    return { width: width, height: width / ratio };
  }

  function clampCrop(slot, ratio) {
    var c = slot.crop;
    var width = c.right - c.left;
    var height = width / ratio;
    var left = Math.min(Math.max(c.left, 0), slot.image.width - width);
    var top = Math.min(Math.max(c.top, 0), slot.image.height - height);
    slot.crop = { left: left, top: top, right: left + width, bottom: top + height };
  }

  function cellHtml(slot, index) {
    var ratio = ratioOf(index);
    var layer = layerOf(index);
    var html = '<sp-dropzone data-index="' + index + '">'
      + '<div class="slot-label">' + escapeHtml(variants[Math.floor(index / layers.length)])
      + (layers.length > 1 ? ' <span class="layer">· ' + escapeHtml(layer.name) + '</span>' : '') + '</div>';
    if (slot.status === 'done') {
      if (ratio && slot.crop) {
        // The whole image is shown, with the crop frame on top
        var imageRatio = slot.image.width / slot.image.height;
        var zoom = maxCropSize(slot, ratio).width / (slot.crop.right - slot.crop.left);
        html += '<div class="crop" data-index="' + index + '" style="width:' + Math.round(CROP_MAX_HEIGHT * imageRatio) + 'px;aspect-ratio:' + imageRatio + '">'
          + '<img src="' + escapeHtml(slot.url) + '" alt="' + escapeHtml(slot.name) + '"><div class="shade"></div><div class="shade"></div><div class="shade"></div><div class="shade"></div><div class="frame"></div></div>'
          + '<label class="zoom">Zoom <input type="range" data-index="' + index + '" min="1" max="' + MAX_ZOOM + '" step="0.01" value="' + zoom + '"></label>';
      } else {
        html += '<img class="thumb" src="' + escapeHtml(slot.url) + '" alt="' + escapeHtml(slot.name) + '">';
      }
      html += '<div class="subtle file-name">' + escapeHtml(slot.name) + '</div>'
        + '<sp-button size="s" variant="secondary" treatment="outline" data-action="remove" data-index="' + index + '">Remove</sp-button>';
    } else if (BUSY_LABELS[slot.status]) {
      html += '<div class="subtle file-name">' + escapeHtml(slot.name) + '</div>'
        + '<sp-progress-bar size="s" label="' + BUSY_LABELS[slot.status] + '"'
        + (slot.status === 'uploading' ? ' progress="' + slot.progress + '"' : ' indeterminate') + '></sp-progress-bar>';
    } else {
      html += '<div class="subtle slot-empty">Drop an image</div>'
        + (slot.error ? '<div class="cell-error">' + escapeHtml(slot.error) + '</div>' : '');
    }
    return html + '</sp-dropzone>';
  }

  // Positions the crop frame over the image. Percentages of the image keep it independent of when the layout is computed.
  function positionFrame(index) {
    var slot = slots[index];
    var box = grid.querySelector('.crop[data-index="' + index + '"]');
    if (!box || !slot.crop) return;
    var l = slot.crop.left / slot.image.width * 100;
    var t = slot.crop.top / slot.image.height * 100;
    var r = slot.crop.right / slot.image.width * 100;
    var b = slot.crop.bottom / slot.image.height * 100;
    // [left, top, width, height] in % of the image: frame, then the shades above, below, left and right of it
    var rects = [[0, 0, 100, t], [0, b, 100, 100 - b], [0, t, l, b - t], [r, t, 100 - r, b - t], [l, t, r - l, b - t]];
    box.querySelectorAll('.shade, .frame').forEach(function (el, i) {
      el.style.left = rects[i][0] + '%';
      el.style.top = rects[i][1] + '%';
      el.style.width = rects[i][2] + '%';
      el.style.height = rects[i][3] + '%';
    });
  }

  // One card per slot, in the order of the variants, each with the variant name (and the layer name with several layers).
  function render() {
    grid.innerHTML = slots.map(cellHtml).join('');
    slots.forEach(function (slot, i) { positionFrame(i); });
    updateStatus();
  }

  function updateStatus() {
    var done = slots.filter(function (s) { return s.status === 'done'; }).length;
    var busy = slots.some(function (s) { return BUSY_LABELS[s.status]; });
    confirmBtn.disabled = done !== slots.length || !slots.length;
    confirmBtn.textContent = 'Confirm images (' + done + '/' + slots.length + ')';
    setStatus(busy ? 'Uploading and framing...' : '');
  }

  // Puts an image in the slot with transfer(slot), which resolves to { url } once it is in storage, then asks the
  // server for a crop at the frame ratio framed on the subject.
  function fillSlot(index, name, status, transfer) {
    var slot = slots[index] = { status: status, name: name, progress: 0 };
    render();
    transfer(slot)
      .then(function (uploaded) {
        slot.url = uploaded.url;
        var ratio = ratioOf(index);
        if (!ratio) return null;
        slot.status = 'framing';
        render();
        return request('tools/call', { name: 'suggest-crop', arguments: { imageUrl: uploaded.url, ratio: ratio } })
          .then(function (result) {
            if (result.isError) throw new Error(result.content[0].text);
            var suggestion = result.structuredContent || JSON.parse(result.content[0].text);
            slot.image = suggestion.image;
            slot.crop = suggestion.crop;
          });
      })
      .then(function () {
        if (slots[index] !== slot) return;
        slot.status = 'done';
        render();
      })
      .catch(function (error) {
        if (slots[index] !== slot) return;
        slots[index] = { status: 'empty', error: (error && error.message) || String(error) };
        render();
      });
  }

  function uploadToSlot(index, file) {
    fillSlot(index, file.name, 'uploading', function (slot) {
      return uploadOne(file, function (bytes) {
        slot.progress = Math.round(bytes / (file.size || 1) * 100);
        var bar = grid.querySelector('sp-dropzone[data-index="' + index + '"] sp-progress-bar');
        if (bar) bar.progress = slot.progress;
      });
    });
  }

  function useLibraryImage(index, item) {
    fillSlot(index, item.name, 'framing', function () { return Promise.resolve({ url: item.url }); });
  }

  function renderLibrary() {
    libraryItems.hidden = !library.length;
    libraryItems.innerHTML = library.map(function (item, i) {
      var done = item.status === 'done';
      return '<div class="library-item' + (i === armed ? ' armed' : '') + (done ? '' : ' busy') + '" data-index="' + i + '"'
        + (done ? ' draggable="true" tabindex="0" role="button" aria-pressed="' + (i === armed) + '"' : '') + ' title="' + escapeHtml(item.name) + '">'
        + (done ? '<img src="' + escapeHtml(item.url) + '" alt="">'
          : item.status === 'uploading' ? '<sp-progress-bar size="s" label="Uploading" progress="' + item.progress + '"></sp-progress-bar>'
            : item.status === 'importing' ? '<sp-progress-bar size="s" label="Importing" indeterminate></sp-progress-bar>'
              : '<span class="cell-error">' + escapeHtml(item.error) + '</span>')
        + '<span class="file-name">' + escapeHtml(item.name) + '</span>'
        + '<button type="button" class="library-remove" aria-label="Remove ' + escapeHtml(item.name) + '" title="Remove">&times;</button></div>';
    }).join('');
    grid.classList.toggle('armed', armed >= 0);
    libraryHint.textContent = armed >= 0
      ? 'Click the slots that use ' + library[armed].name + ' (Esc when done).'
      : library.length ? 'Drag an image onto a slot, or click it then click the slots.' : '';
    reportSize();
  }

  // Adds an image to the library; transfer(item) puts it in storage and resolves to { url }.
  function addToLibrary(name, status, transfer) {
    var item = { status: status, name: name, progress: 0 };
    library.push(item);
    transfer(item)
      .then(function (stored) { item.status = 'done'; item.url = stored.url; })
      .catch(function (error) { item.status = 'error'; item.error = (error && error.message) || String(error); })
      .then(renderLibrary);
  }

  function addFiles(fileList) {
    Array.prototype.slice.call(fileList || []).filter(function (f) { return !f.type || f.type.indexOf('image/') === 0; }).forEach(function (file) {
      addToLibrary(file.name, 'uploading', function (item) {
        return uploadOne(file, function (bytes) {
          item.progress = Math.round(bytes / (file.size || 1) * 100);
          var bar = libraryItems.querySelector('.library-item[data-index="' + library.indexOf(item) + '"] sp-progress-bar');
          if (bar) bar.progress = item.progress;
        });
      });
    });
    renderLibrary();
  }

  // Picks images in AEM (several at once) and imports them into the library.
  function addFromAem() {
    pickAemAssets(true)
      .then(function (assets) {
        assets.filter(function (a) { return String(a['dc:format'] || '').indexOf('image/') === 0; }).forEach(function (asset) {
          addToLibrary(asset['repo:name'], 'importing', function () { return importAemAsset(asset); });
        });
        renderLibrary();
      })
      .catch(function (error) { setStatus((error && error.message) || String(error), true); });
  }

  // The first file goes to the target slot, the others fill the next empty slots in order.
  function placeFiles(startIndex, fileList) {
    var files = Array.prototype.slice.call(fileList || []).filter(function (f) { return !f.type || f.type.indexOf('image/') === 0; });
    if (!files.length) return;
    uploadToSlot(startIndex, files.shift());
    for (var i = 0; i < slots.length && files.length; i++) {
      var index = (startIndex + 1 + i) % slots.length;
      if (slots[index].status === 'empty') uploadToSlot(index, files.shift());
    }
    if (files.length) setStatus(files.length + ' extra file(s) ignored: all slots are filled.', true);
  }

  // Fills a slot with an image uploaded before (e.g. to re-crop after a generation): only fetches its size and a
  // suggested crop when they are not given.
  function prefillSlot(index, image) {
    var slot = slots[index] = { status: 'done', url: image.url, name: image.fileName || 'image', crop: image.crop };
    if (image.width && image.height) slot.image = { width: image.width, height: image.height };
    var ratio = ratioOf(index);
    if (!ratio || (slot.image && slot.crop)) return;
    slot.status = 'framing';
    request('tools/call', { name: 'suggest-crop', arguments: { imageUrl: image.url, ratio: ratio } })
      .then(function (result) {
        if (result.isError) throw new Error(result.content[0].text);
        var suggestion = result.structuredContent || JSON.parse(result.content[0].text);
        slot.image = suggestion.image;
        if (!slot.crop) slot.crop = suggestion.crop;
        slot.status = 'done';
      })
      .catch(function (error) {
        slots[index] = { status: 'empty', error: 'Image no longer available, upload it again (' + ((error && error.message) || error) + ')' };
      })
      .then(render);
  }

  onToolInput(function (args) {
    variants = (args.variants || []).map(String);
    layers = (args.layers && args.layers.length) ? args.layers : [{ name: 'Image' }];
    if (args.title) document.getElementById('title').textContent = args.title;
    slots = [];
    for (var i = 0; i < variants.length * layers.length; i++) slots.push({ status: 'empty' });
    (args.images || []).forEach(function (image) {
      var layerIndex = layers.findIndex(function (l) { return l.id === image.layerId; });
      // The variant is given by label (preferred) or by 0-based index
      var variantIndex = typeof image.variant === 'string' ? variants.indexOf(image.variant) : image.variant;
      if (layerIndex < 0 || variantIndex < 0 || variantIndex >= variants.length) return;
      prefillSlot(variantIndex * layers.length + layerIndex, image);
    });
    render();
  });
  // Shows the AEM button once the AEM configuration is known
  loadAemConfig().then(function (config) { aemBtn.hidden = !config; reportSize(); });

  document.getElementById('browse').addEventListener('click', function () { input.value = ''; input.click(); });
  input.addEventListener('change', function () { addFiles(input.files); });
  aemBtn.addEventListener('click', addFromAem);
  // Removing an image from the library does not change the slots that already use it.
  function removeFromLibrary(i) {
    library.splice(i, 1);
    if (armed === i) armed = -1;
    else if (armed > i) armed--;
    renderLibrary();
  }

  function toggleArmed(tile) {
    if (tile.classList.contains('busy')) return;
    var i = Number(tile.getAttribute('data-index'));
    armed = armed === i ? -1 : i;
    renderLibrary();
  }

  libraryItems.addEventListener('click', function (e) {
    var tile = e.target.closest('.library-item');
    if (!tile) return;
    if (e.target.closest('.library-remove')) removeFromLibrary(Number(tile.getAttribute('data-index')));
    else toggleArmed(tile);
  });
  libraryItems.addEventListener('keydown', function (e) {
    var tile = e.target.closest('.library-item');
    if (!tile || e.target !== tile || (e.key !== 'Enter' && e.key !== ' ')) return;
    e.preventDefault();
    toggleArmed(tile);
  });
  libraryItems.addEventListener('dragstart', function (e) {
    var tile = e.target.closest('.library-item');
    if (!tile) return;
    e.dataTransfer.setData(LIBRARY_DRAG_TYPE, tile.getAttribute('data-index'));
    e.dataTransfer.effectAllowed = 'copy';
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && armed >= 0) { armed = -1; renderLibrary(); }
  });
  // With an armed library image, a click on a slot (outside its buttons and crop) assigns the image to it.
  grid.addEventListener('click', function (e) {
    if (armed < 0 || e.target.closest('sp-button, .crop, .zoom')) return;
    var zone = e.target.closest('sp-dropzone');
    if (zone) useLibraryImage(Number(zone.getAttribute('data-index')), library[armed]);
  });

  grid.addEventListener('click', function (e) {
    var button = e.target.closest('sp-button');
    if (!button) return;
    if (button.getAttribute('data-action') === 'remove') {
      slots[Number(button.getAttribute('data-index'))] = { status: 'empty' };
      render();
    }
  });
  grid.addEventListener('sp-dropzone-should-accept', function (e) { e.detail.dataTransfer.dropEffect = 'copy'; });
  grid.addEventListener('sp-dropzone-drop', function (e) {
    var index = Number(e.target.getAttribute('data-index'));
    var libraryIndex = e.detail.dataTransfer.getData(LIBRARY_DRAG_TYPE);
    if (libraryIndex !== '') useLibraryImage(index, library[Number(libraryIndex)]);
    else placeFiles(index, e.detail.dataTransfer.files);
  });

  // Drag to reposition the crop: the frame follows the pointer.
  var drag = null;
  grid.addEventListener('pointerdown', function (e) {
    var box = e.target.closest('.crop');
    if (!box) return;
    var index = Number(box.getAttribute('data-index'));
    var slot = slots[index];
    drag = { index: index, box: box, x: e.clientX, y: e.clientY, crop: slot.crop,
      scale: box.clientWidth / slot.image.width };
    box.classList.add('dragging');
    box.setPointerCapture(e.pointerId);
  });
  grid.addEventListener('pointermove', function (e) {
    if (!drag) return;
    var slot = slots[drag.index];
    var dx = (e.clientX - drag.x) / drag.scale;
    var dy = (e.clientY - drag.y) / drag.scale;
    slot.crop = { left: drag.crop.left + dx, top: drag.crop.top + dy, right: drag.crop.right + dx, bottom: drag.crop.bottom + dy };
    clampCrop(slot, ratioOf(drag.index));
    positionFrame(drag.index);
  });
  function endDrag() {
    if (!drag) return;
    drag.box.classList.remove('dragging');
    drag = null;
  }
  grid.addEventListener('pointerup', endDrag);
  grid.addEventListener('pointercancel', endDrag);

  // Zoom around the center of the current crop.
  grid.addEventListener('input', function (e) {
    if (e.target.type !== 'range') return;
    var index = Number(e.target.getAttribute('data-index'));
    var slot = slots[index];
    var ratio = ratioOf(index);
    var size = maxCropSize(slot, ratio);
    var width = size.width / Number(e.target.value);
    var cx = (slot.crop.left + slot.crop.right) / 2;
    var cy = (slot.crop.top + slot.crop.bottom) / 2;
    slot.crop = { left: cx - width / 2, top: cy - width / ratio / 2, right: cx + width / 2, bottom: cy + width / ratio / 2 };
    clampCrop(slot, ratio);
    positionFrame(index);
  });

  confirmBtn.addEventListener('click', function () {
    confirmBtn.disabled = true;
    var mapping = slots.map(function (slot, i) {
      var layer = layerOf(i);
      var crop = slot.crop && {
        left: Math.round(slot.crop.left), top: Math.round(slot.crop.top),
        right: Math.round(slot.crop.right), bottom: Math.round(slot.crop.bottom)
      };
      return { variant: variants[Math.floor(i / layers.length)], layerId: layer.id, layerName: layer.name,
        fileName: slot.name, url: slot.url, crop: crop, size: slot.image };
    });
    // Ready-to-use JSON, so that the mapping between variants and images is copied rather than rebuilt
    var images = mapping.map(function (m) {
      var image = { variant: m.variant, layerId: m.layerId, url: m.url, fileName: m.fileName };
      if (m.crop) image.crop = m.crop;
      if (m.size) { image.width = m.size.width; image.height = m.size.height; }
      return image;
    });
    var context = 'Images chosen by the user for each variant and smart object layer (URLs valid 24 hours):\\n'
      + mapping.map(function (m) { return '- variant "' + m.variant + '", layer "' + m.layerName + '": ' + m.fileName; }).join('\\n')
      + '\\nFor create-variant, use for each variant exactly the entries below whose "variant" is its label '
      + '(smart_object_layer edit = { id: layerId, type: "smart_object_layer", imageUrl: url, crop }). '
      + 'To re-crop later, pass this "images" array as is to upload-variant-images:\\n'
      + JSON.stringify({ images: images });
    request('ui/update-model-context', { content: [{ type: 'text', text: context }] })
      .then(function () {
        setStatus('Images sent.');
        return request('ui/message', {
          role: 'user',
          content: [{ type: 'text', text: 'I added and framed the images for the ' + variants.length + ' variant(s), continue.' }]
        });
      })
      .catch(function (error) {
        confirmBtn.disabled = false;
        setStatus((error && error.message) || String(error), true);
      });
  });
`)
}

function getLayersViewHtml (scriptUrl) {
  return page(scriptUrl, 'PSD Layers', `
  .subtle.intro { margin: var(--spectrum-spacing-75) 0 var(--spectrum-spacing-200); }
  .list { border: 1px solid var(--spectrum-gray-200); border-radius: var(--spectrum-corner-radius-200); overflow: hidden; display: none; }
  .row {
    display: flex;
    align-items: center;
    gap: var(--spectrum-spacing-200);
    min-height: 36px;
    padding: 0 var(--spectrum-spacing-200);
    border-top: 1px solid var(--spectrum-gray-200);
  }
  .row.head { border-top: none; background: var(--spectrum-background-layer-2-color); }
  /* Shared columns across rows (checkbox, name, type, text) so that types and texts are aligned */
  #layers { display: grid; grid-template-columns: auto fit-content(40%) auto minmax(0, 1fr); }
  #layers .row { display: grid; grid-column: 1 / -1; grid-template-columns: subgrid; }
  .layer-name { font-weight: var(--spectrum-bold-font-weight); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .row sp-badge { justify-self: start; }
  .layer-text { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .actions { margin-top: var(--spectrum-spacing-300); }
`, `
<h2 class="heading" id="title">Editable layers</h2>
<div class="subtle intro">Pick the layers to use for the variants.</div>
<div class="list" id="list">
  <div class="row head"><sp-checkbox id="select-all">Select all</sp-checkbox></div>
  <div id="layers"></div>
</div>
<div class="actions"><sp-button variant="accent" id="confirm" disabled>Use these layers</sp-button></div>
<sp-help-text class="status" id="status">Loading the manifest...</sp-help-text>
`, `
  var layers = [];
  var listEl = document.getElementById('layers');
  var confirmBtn = document.getElementById('confirm');
  var selectAll = document.getElementById('select-all');

  function selected() {
    return layers.filter(function (l, i) { return document.getElementById('layer-' + i).checked; });
  }

  // Keeps the "Select all" box and the button in sync with the layer boxes.
  function updateSelection() {
    var count = selected().length;
    selectAll.checked = count === layers.length;
    selectAll.indeterminate = count > 0 && count < layers.length;
    confirmBtn.disabled = !count;
  }

  function render(data) {
    layers = data.layers || [];
    if (data.document && data.document.title) document.getElementById('title').textContent = data.document.title;
    if (!layers.length) {
      setStatus('No unlocked text or smart object layer in this file.');
      return;
    }
    listEl.innerHTML = layers.map(function (l, i) {
      var isText = l.type === 'text_layer';
      return '<div class="row"><sp-checkbox id="layer-' + i + '" aria-label="' + escapeHtml(l.name) + '"></sp-checkbox>'
        + '<span class="layer-name" title="' + escapeHtml(l.name) + '">' + escapeHtml(l.name) + '</span>'
        + '<sp-badge size="s" variant="' + (isText ? 'informative' : 'seafoam') + '">' + (isText ? 'Text' : 'Smart object') + '</sp-badge>'
        + '<span class="subtle layer-text" title="' + escapeHtml(isText ? l.text : '') + '">' + (isText ? escapeHtml(l.text) : '') + '</span>'
        + '</div>';
    }).join('');
    document.getElementById('list').style.display = 'block';
    setStatus(layers.length + ' editable layer(s).');
  }

  listEl.addEventListener('change', updateSelection);
  selectAll.addEventListener('change', function () {
    var checked = selectAll.checked;
    layers.forEach(function (l, i) { document.getElementById('layer-' + i).checked = checked; });
    updateSelection();
  });

  onToolResult(function (result) {
    if (result.isError) {
      setStatus(result.content && result.content[0] ? result.content[0].text : 'Error', true);
      return;
    }
    render(result.structuredContent || {});
  });

  confirmBtn.addEventListener('click', function () {
    var chosen = selected();
    if (!chosen.length) return;
    confirmBtn.disabled = true;
    var images = chosen.filter(function (l) { return l.type === 'smart_object_layer'; });
    var context = 'Layers selected by the user for the variants: ' + JSON.stringify(chosen.map(function (l) {
      return { id: l.id, name: l.name, type: l.type };
    })) + '. Next: if text layers were selected, list them with their current text and ask which texts to use for each variant: '
      + 'the user provides them, or you write them (ask for the brief: subject, tone, language, length) and let the user adjust your proposal; '
      + 'give each variant a short label'
      + (images.length
        ? '; then call upload-variant-images ONCE with all variant labels and layers ' + JSON.stringify(images.map(function (l) { return { id: l.id, name: l.name, width: l.frame && l.frame.width, height: l.frame && l.frame.height }; }))
          + ' (one grid for all variants; never call upload-file per image)'
        : '')
      + '; then recap and call create-variant ONCE with all variants.';
    request('ui/update-model-context', { content: [{ type: 'text', text: context }] })
      .then(function () {
        setStatus('Selection sent.');
        return request('ui/message', {
          role: 'user',
          content: [{ type: 'text', text: 'I picked these layers: ' + chosen.map(function (l) { return l.name; }).join(', ') + '. Continue.' }]
        });
      })
      .catch(function (error) {
        confirmBtn.disabled = false;
        setStatus((error && error.message) || String(error), true);
      });
  });
`)
}

function getVariantViewHtml (scriptUrl) {
  return page(scriptUrl, 'PSD Variants', `
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
    gap: var(--spectrum-spacing-300);
  }
  .card {
    background: var(--spectrum-background-layer-2-color);
    border: 1px solid var(--spectrum-gray-200);
    border-radius: var(--spectrum-corner-radius-500);
    padding: var(--spectrum-spacing-200);
    display: flex;
    flex-direction: column;
    gap: var(--spectrum-spacing-200);
  }
  .card img {
    width: 100%;
    max-height: 320px;
    object-fit: contain;
    border-radius: var(--spectrum-corner-radius-200);
    background: var(--spectrum-gray-100);
    cursor: zoom-in;
  }
  .card-name { word-break: break-all; }
  .card-error { color: var(--spectrum-negative-content-color-default); font-size: var(--spectrum-font-size-75); word-break: break-word; }
  .preview { display: none; }
  .preview.open { display: block; }
  .preview-bar { display: flex; align-items: center; gap: var(--spectrum-spacing-200); margin-bottom: var(--spectrum-spacing-200); }
  .preview-name { flex: 1; min-width: 0; font-weight: var(--spectrum-bold-font-weight); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .preview img {
    display: block;
    width: 100%;
    max-height: 640px;
    object-fit: contain;
    border-radius: var(--spectrum-corner-radius-200);
    background: var(--spectrum-gray-100);
    cursor: zoom-out;
  }
`, `
<div class="preview" id="preview">
  <div class="preview-bar">
    <sp-button size="s" variant="secondary" treatment="outline" data-action="back">All variants</sp-button>
    <span class="preview-name" id="preview-name"></span>
    <sp-button size="s" variant="secondary" treatment="outline" data-action="prev">Previous</sp-button>
    <sp-button size="s" variant="secondary" treatment="outline" data-action="next">Next</sp-button>
    <sp-button size="s" variant="accent" data-action="download">Download</sp-button>
  </div>
  <img id="preview-image" alt="">
</div>
<div class="grid" id="grid"></div>
<sp-help-text class="status" id="status">Generating variants...</sp-help-text>
`, `
  var grid = document.getElementById('grid');
  var preview = document.getElementById('preview');
  var previewImage = document.getElementById('preview-image');
  var variants = [];
  var current = -1;

  function render() {
    grid.innerHTML = variants.map(function (v, i) {
      if (v.error) {
        return '<div class="card"><div class="subtle card-name">' + escapeHtml(v.fileName) + '</div>'
          + '<div class="card-error">' + escapeHtml(v.error) + '</div></div>';
      }
      return '<div class="card"><img src="' + escapeHtml(v.imageUrl) + '" alt="' + escapeHtml(v.fileName) + '" data-index="' + i + '">'
        + '<div class="subtle card-name">' + escapeHtml(v.fileName) + '</div>'
        + '<sp-button variant="secondary" treatment="outline" size="s" data-action="download" data-index="' + i + '">Download</sp-button></div>';
    }).join('');
    var ok = variants.filter(function (v) { return !v.error; }).length;
    setStatus(ok + '/' + variants.length + ' variant(s) generated — click a visual to enlarge it — links valid for 24 hours', ok === 0);
  }

  function generated() {
    return variants.map(function (v, i) { return i; }).filter(function (i) { return !variants[i].error; });
  }

  // Enlarged view of one variant inside the widget; index -1 goes back to the grid.
  function showPreview(index) {
    current = index;
    var open = index >= 0;
    preview.classList.toggle('open', open);
    grid.style.display = open ? 'none' : '';
    if (open) {
      previewImage.src = variants[index].imageUrl;
      previewImage.alt = variants[index].fileName;
      var list = generated();
      document.getElementById('preview-name').textContent = variants[index].fileName + ' (' + (list.indexOf(index) + 1) + '/' + list.length + ')';
    }
    reportSize();
  }

  function step(delta) {
    var list = generated();
    showPreview(list[(list.indexOf(current) + delta + list.length) % list.length]);
  }

  function download(index) {
    request('ui/open-link', { url: variants[index].imageUrl }).catch(function () {
      setStatus('Could not open the download link.', true);
    });
  }

  grid.addEventListener('click', function (e) {
    var target = e.target.closest('img, sp-button');
    if (!target) return;
    var index = Number(target.getAttribute('data-index'));
    if (target.tagName === 'IMG') showPreview(index);
    else download(index);
  });

  preview.addEventListener('click', function (e) {
    if (e.target === previewImage) return showPreview(-1);
    var button = e.target.closest('sp-button');
    if (!button) return;
    var action = button.getAttribute('data-action');
    if (action === 'back') showPreview(-1);
    else if (action === 'prev') step(-1);
    else if (action === 'next') step(1);
    else if (action === 'download') download(current);
  });

  previewImage.addEventListener('load', reportSize);
  document.addEventListener('keydown', function (e) {
    if (current < 0) return;
    if (e.key === 'Escape') showPreview(-1);
    else if (e.key === 'ArrowLeft') step(-1);
    else if (e.key === 'ArrowRight') step(1);
  });

  onToolResult(function (result) {
    variants = (result.structuredContent && result.structuredContent.variants) || [];
    if (!variants.length) {
      setStatus(result.content && result.content[0] ? result.content[0].text : 'Error', true);
      return;
    }
    render();
  });
`)
}

module.exports = { getStartViewHtml, getUploadViewHtml, getVariantImagesViewHtml, getLayersViewHtml, getVariantViewHtml }
