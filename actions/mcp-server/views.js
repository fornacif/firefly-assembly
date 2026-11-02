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
  .subtle.intro { margin: var(--spectrum-spacing-75) 0 var(--spectrum-spacing-300); }
  .actions { margin-top: var(--spectrum-spacing-300); display: flex; align-items: center; gap: var(--spectrum-spacing-300); }
  .actions .status { margin-top: 0; }
  /* Spinner shown before the status while something loads */
  #status-loader { vertical-align: middle; margin-right: var(--spectrum-spacing-100); }
  #status-loader:not([hidden]) + .status { display: inline-block; vertical-align: middle; }
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

  // Status line of the view, with a spinner before it while loading.
  function setStatus(text, isError, loading) {
    var el = document.getElementById('status');
    el.textContent = text;
    el.setAttribute('variant', isError ? 'negative' : 'neutral');
    var loader = document.getElementById('status-loader');
    if (!loader && loading) {
      loader = document.createElement('sp-progress-circle');
      loader.id = 'status-loader';
      loader.setAttribute('size', 's');
      loader.setAttribute('indeterminate', '');
      loader.setAttribute('label', 'Loading');
      el.parentNode.insertBefore(loader, el);
    }
    if (loader) loader.hidden = !loading;
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

  // Calls a tool of this server; resolves to its structured result, rejects with its error text.
  function callTool(name, args) {
    return request('tools/call', { name: name, arguments: args || {} }).then(function (result) {
      if (result.isError) throw new Error(result.content[0].text);
      return result.structuredContent || JSON.parse(result.content[0].text);
    });
  }

  // Polls a task started by a tool (get-task) until it is done: resolves to its result, and calls onProgress(partial) with
  // what is ready meanwhile. A few failed polls in a row (e.g. a gateway error) are tolerated.
  var TASK_POLL_MS = 1500;
  var TASK_POLL_ERRORS = 5;
  function waitForTask(taskId, onProgress) {
    var errors = 0;
    var lastUpdate = null;
    return new Promise(function (resolve, reject) {
      function poll() {
        callTool('get-task', { taskId: taskId }).then(function (task) {
          errors = 0;
          if (task.status === 'done') return resolve(task.result);
          if (task.status === 'failed') return reject(new Error(task.error || 'The task failed'));
          if (onProgress && task.partial && task.updatedAt !== lastUpdate) {
            lastUpdate = task.updatedAt;
            onProgress(task.partial);
          }
          setTimeout(poll, TASK_POLL_MS);
        }, function (error) {
          if (++errors >= TASK_POLL_ERRORS) return reject(error);
          setTimeout(poll, TASK_POLL_MS);
        });
      }
      poll();
    });
  }

  // Sends the result of a view to Claude, then a user message so that it continues. The result is stored on the server
  // under a short reference carried by the message (get-widget-result), because some models do not reliably see the
  // model context the host is given with ui/update-model-context; it is still given there too.
  function sendToModel(context, message, sentStatus) {
    return callTool('save-widget-result', { text: context })
      .then(function (saved) { return saved.ref; })
      // Without a reference, Claude can still read the result in the model context
      .catch(function () { return null; })
      .then(function (ref) {
        return request('ui/update-model-context', { content: [{ type: 'text', text: context }] })
          .then(function () {
            if (sentStatus) setStatus(sentStatus);
            return request('ui/message', { role: 'user', content: [{ type: 'text', text: message + (ref ? ' (' + ref + ')' : '') }] });
          });
      });
  }

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
    return callTool('create-upload-url', { fileName: file.name })
      .then(function (urls) {
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

  function loadAemConfig() {
    return ready
      .then(function () { return callTool('get-aem-selector-config'); })
      .then(function (config) { aemConfig = config.enabled ? config : null; return aemConfig; })
      .catch(function () { return null; });
  }

  // Polls the session until the selection is made in the tab; a new pick supersedes the previous one.
  function waitForAemSelection(sessionId, pickId, deadline) {
    return new Promise(function (resolve) { setTimeout(resolve, AEM_POLL_INTERVAL_MS); })
      .then(function () {
        if (pickId !== aemPickId) return { status: 'cancelled', assets: [] };
        return callTool('get-aem-picker-result', { sessionId: sessionId });
      })
      .then(function (result) {
        if (result.status === 'pending' && Date.now() < deadline) return waitForAemSelection(sessionId, pickId, deadline);
        if (result.status === 'pending' || result.status === 'expired') throw new Error('The AEM selection has expired, choose again.');
        return result.assets;
      });
  }

  function pickAemAssets(multiple) {
    var pickId = ++aemPickId;
    return callTool('create-aem-picker-session', { multiple: multiple })
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
    return callTool('import-aem-asset', { repositoryId: asset['repo:repositoryId'], assetId: asset['repo:assetId'] || undefined, path: asset['repo:path'] || undefined, fileName: asset['repo:name'] })
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
    setStatus('Uploading...', false, true);

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
        // The URLs go to Claude only (not shown to the user), with a short prompt so that it continues
        return sendToModel(context, 'I uploaded ' + names + ', continue.');
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
  /* Compact drop zone: one row with the message on the left and the buttons on the right, wrapping when narrow */
  sp-dropzone {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--spectrum-spacing-200);
    width: 100%;
    padding: var(--spectrum-spacing-200) var(--spectrum-spacing-300);
    --mod-drop-zone-padding: var(--spectrum-spacing-200);
    border-radius: var(--spectrum-corner-radius-200);
  }
  .message { flex: 1 1 220px; min-width: 0; text-align: left; }
  #message-heading { font-weight: var(--spectrum-bold-font-weight); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .browse { display: flex; flex-wrap: wrap; gap: var(--spectrum-spacing-200); }
  /* sp-dropzone gives its content a larger font and a 1.5 line height, which sp-button inherits and which pushes its label down */
  sp-dropzone sp-button { font-size: var(--spectrum-font-size-100); line-height: var(--spectrum-line-height-100); }
  #file { display: none; }
  sp-progress-bar { width: 100%; margin-top: var(--spectrum-spacing-200); }
`, `
<h2 class="heading">Create variants</h2>
<div class="subtle intro">Set the number of variants and drop the layered PSD template.</div>
<div class="field">
  <label for="count">Number of variants (1-${MAX_VARIANTS_UI})</label>
  <input type="number" id="count" min="1" max="${MAX_VARIANTS_UI}" value="2">
</div>
<sp-dropzone id="drop">
  <div class="message"><div id="message-heading">Drop your PSD template</div><div class="subtle" id="message-description">Layered .psd file</div></div>
  <div class="browse">
    <sp-button variant="accent" treatment="outline" id="browse">Browse</sp-button>
    <sp-button variant="secondary" treatment="outline" id="aem" hidden>${ADOBE_ICON}Choose from AEM</sp-button>
    <input type="file" id="file" accept=".psd,image/vnd.adobe.photoshop">
  </div>
</sp-dropzone>
<sp-progress-bar id="progress" label="Upload" progress="0" side-label hidden></sp-progress-bar>
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
  var messageHeading = document.getElementById('message-heading');
  var messageDescription = document.getElementById('message-description');
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

  // The drop zone shows the file being transferred, the progress bar a short label and the percentage on one line.
  function startTransfer(name, label, indeterminate) {
    template = null;
    updateButton();
    messageHeading.textContent = name;
    messageHeading.title = name;
    messageDescription.textContent = label + '...';
    progress.hidden = false;
    progress.indeterminate = indeterminate;
    progress.progress = 0;
    progress.label = label;
    setStatus('');
  }

  function setTemplate(file) {
    template = file;
    // The bar stays at 100% with a short label: the drop zone already shows the file name
    progress.indeterminate = false;
    progress.progress = 100;
    progress.label = progress.label === 'Uploading' ? 'Uploaded' : 'Imported';
    messageHeading.textContent = file.name;
    messageHeading.title = file.name;
    messageDescription.textContent = 'Uploaded — drop or choose another file to replace it';
    setStatus('');
    updateButton();
  }

  function fail(error) {
    progress.hidden = true;
    messageHeading.textContent = 'Drop your PSD template';
    messageHeading.title = '';
    messageDescription.textContent = 'Layered .psd file';
    setStatus((error && error.message) || String(error), true);
  }

  function upload(file) {
    if (!file) return;
    startTransfer(file.name, 'Uploading', false);
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
        startTransfer(asset['repo:name'], 'Importing from AEM', true);
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
    sendToModel(context, 'I want ' + n + ' variant(s) of ' + template.name + ', continue.', 'Template sent.')
      .catch(function (error) {
        updateButton();
        setStatus((error && error.message) || String(error), true);
      });
  });
`)
}

function getVariantImagesViewHtml (scriptUrl) {
  return page(scriptUrl, 'Variant Images', `
  /* With several layers, one group per variant; one card per slot (variant and smart object layer), as many per row as fit */
  .grid { display: flex; flex-direction: column; gap: var(--spectrum-spacing-300); }
  /* Group of a variant: a panel headed by its number and name, above the cards of its layers */
  .variant-group {
    padding: var(--spectrum-spacing-200) var(--spectrum-spacing-300) var(--spectrum-spacing-300);
    background: var(--spectrum-background-layer-2-color);
    border: 1px solid var(--spectrum-gray-200);
    border-radius: var(--spectrum-corner-radius-500);
  }
  .variant-name {
    display: flex;
    align-items: center;
    gap: var(--spectrum-spacing-100);
    margin: 0 0 var(--spectrum-spacing-200);
    font-size: var(--spectrum-font-size-300);
    font-weight: var(--spectrum-bold-font-weight);
  }
  .variant-group .slot-label { font-weight: normal; color: var(--spectrum-neutral-subdued-content-color-default); font-size: var(--spectrum-font-size-75); }
  .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: var(--spectrum-spacing-200); align-items: stretch; }
  .cards > * { min-width: 0; }
  .slot-label { width: 100%; font-weight: var(--spectrum-bold-font-weight); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .slot-empty { margin: auto 0; }
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
  /* sp-dropzone gives its content a larger font and a 1.5 line height, which sp-button inherits and which pushes its label down */
  sp-dropzone sp-button { font-size: var(--spectrum-font-size-75); line-height: var(--spectrum-line-height-100); }
  .cell-error { color: var(--spectrum-negative-content-color-default); font-size: var(--spectrum-font-size-75); }
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
  var LIBRARY_DRAG_TYPE = 'application/x-firefly-assembly-library-index';
  var aemBtn = document.getElementById('aem');
  var libraryItems = document.getElementById('library-items');
  var libraryHint = document.getElementById('library-hint');
  var library = [];
  var armed = -1;

  // Size of the image and a crop at the frame ratio, framed on its subject. Each call runs Photoshop jobs in a task: at
  // most SUGGEST_CROP_CONCURRENCY at once, one per image and ratio (an image used in several slots is framed once), and
  // tried again once on failure (e.g. a gateway error).
  var SUGGEST_CROP_CONCURRENCY = 4;
  var cropSuggestions = {};
  var cropQueue = [];
  var cropsRunning = 0;
  function nextCropSuggestion() {
    if (cropsRunning >= SUGGEST_CROP_CONCURRENCY || !cropQueue.length) return;
    cropsRunning++;
    var job = cropQueue.shift();
    var args = { imageUrl: job.imageUrl, ratio: job.ratio };
    // suggest-crop starts a task, whose result is the suggestion
    var suggest = function () {
      return callTool('suggest-crop', args).then(function (started) { return started.taskId ? waitForTask(started.taskId) : started; });
    };
    suggest()
      .catch(suggest)
      .then(job.resolve, job.reject)
      .then(function () { cropsRunning--; nextCropSuggestion(); });
  }
  function suggestCrop(imageUrl, ratio) {
    var key = imageUrl + '|' + ratio;
    if (!cropSuggestions[key]) {
      cropSuggestions[key] = new Promise(function (resolve, reject) {
        cropQueue.push({ imageUrl: imageUrl, ratio: ratio, resolve: resolve, reject: reject });
        nextCropSuggestion();
      }).catch(function (error) { delete cropSuggestions[key]; throw error; });
    }
    return cropSuggestions[key];
  }

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
    // Grouped by variant with several layers, so the card only names the layer
    var label = layers.length > 1 ? layer.name : variants[Math.floor(index / layers.length)];
    var html = '<sp-dropzone data-index="' + index + '">'
      + '<div class="slot-label">' + escapeHtml(label) + '</div>';
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

  // One card per slot, in the order of the variants. With several layers, the cards of a variant are grouped under its name.
  function render() {
    if (layers.length > 1) {
      grid.innerHTML = variants.map(function (variant, v) {
        var start = v * layers.length;
        return '<section class="variant-group"><h3 class="variant-name"><sp-badge size="s" variant="neutral">' + (v + 1) + '</sp-badge>'
          + escapeHtml(variant) + '</h3><div class="cards">'
          + slots.slice(start, start + layers.length).map(function (slot, l) { return cellHtml(slot, start + l); }).join('')
          + '</div></section>';
      }).join('');
    } else {
      grid.innerHTML = '<div class="cards">' + slots.map(cellHtml).join('') + '</div>';
    }
    slots.forEach(function (slot, i) { positionFrame(i); });
    updateStatus();
  }

  function updateStatus() {
    var done = slots.filter(function (s) { return s.status === 'done'; }).length;
    var busy = slots.some(function (s) { return BUSY_LABELS[s.status]; });
    confirmBtn.disabled = done !== slots.length || !slots.length;
    confirmBtn.textContent = 'Confirm images (' + done + '/' + slots.length + ')';
    setStatus(busy ? 'Uploading and framing...' : '', false, busy);
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
        return suggestCrop(uploaded.url, ratio).then(function (suggestion) {
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
    suggestCrop(image.url, ratio)
      .then(function (suggestion) {
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
    sendToModel(context, 'I added and framed the images for the ' + variants.length + ' variant(s), continue.', 'Images sent.')
      .catch(function (error) {
        confirmBtn.disabled = false;
        setStatus((error && error.message) || String(error), true);
      });
  });
`)
}

function getLayersViewHtml (scriptUrl) {
  return page(scriptUrl, 'PSD Layers', `
  .subtle.intro { margin-bottom: var(--spectrum-spacing-200); }
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
  /* Shared columns across rows (checkbox, number, name, type) so that types are aligned */
  #layers { display: grid; grid-template-columns: auto auto minmax(0, max-content) auto; }
  #layers .row { display: grid; grid-column: 1 / -1; grid-template-columns: subgrid; cursor: default; }
  #layers .row.hover { background: var(--spectrum-gray-100); }
  .layer-name { font-weight: var(--spectrum-bold-font-weight); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .row sp-badge { justify-self: start; }
  /* Preview on the left (half of the width at most) and list on the right; the list goes below on very narrow views */
  .picker { display: flex; align-items: flex-start; gap: var(--spectrum-spacing-300); }
  .picker .list { flex: 1 1 0; min-width: 0; }
  @media (max-width: 420px) { .picker { flex-direction: column; align-items: stretch; } .picker .list { flex: none; } }
  /* The padding leaves room for the numbers, centered on the top left corner of the zones */
  .preview { flex: 0 1 auto; max-width: 50%; padding: 10px; line-height: 0; }
  @media (max-width: 420px) { .preview { max-width: 100%; } }
  .stage { position: relative; display: inline-block; max-width: 100%; }
  .stage img { display: block; max-width: 100%; max-height: 460px; border-radius: var(--spectrum-corner-radius-100); }
  /* In place of the preview while it renders */
  .preview-loader {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--spectrum-spacing-200);
    width: 240px;
    max-width: 100%;
    height: 240px;
    line-height: normal;
    border-radius: var(--spectrum-corner-radius-100);
    background: var(--spectrum-gray-100);
  }
  .preview-loader[hidden], .stage[hidden] { display: none; }
  /* Zones are outlined only, so that what they cover stays visible */
  .zone {
    position: absolute;
    padding: 0;
    background: transparent;
    border: 2px dashed rgba(255, 255, 255, 0.95);
    outline: 1px solid rgba(0, 0, 0, 0.5);
    border-radius: 2px;
    cursor: pointer;
  }
  .zone:hover, .zone.hover, .zone:focus-visible { border-style: solid; background: rgba(255, 255, 255, 0.12); outline-color: rgba(0, 0, 0, 0.7); }
  /* Numbers and selected zones take the color of the layer type, as its badge in the list (Text, Smart object) */
  .zone.selected { border-style: solid; outline: 1px solid #ffffff; }
  .zone.text.selected { border-color: var(--spectrum-informative-background-color-default); }
  .zone.image.selected { border-color: var(--spectrum-seafoam-background-color-default); }
  .num {
    display: inline-block;
    min-width: 20px;
    height: 20px;
    padding: 0 5px;
    border-radius: 10px;
    font-size: 12px;
    font-weight: var(--spectrum-bold-font-weight);
    line-height: 20px;
    text-align: center;
    color: #ffffff;
    background: rgba(0, 0, 0, 0.75);
  }
  .zone .num { position: absolute; top: -1px; left: -1px; transform: translate(-50%, -50%); box-shadow: 0 0 0 1.5px #ffffff; pointer-events: none; }
  .num.text { background: var(--spectrum-informative-background-color-default); }
  .num.image { background: var(--spectrum-seafoam-background-color-default); }
  .row .num { justify-self: center; }
  .row .num:empty { visibility: hidden; }
`, `
<h2 class="heading" id="title">Editable layers</h2>
<div class="subtle intro" id="intro">Pick the layers to use for the variants.</div>
<div class="picker">
  <div class="preview" id="preview" hidden>
    <div class="preview-loader" id="preview-loader" hidden><sp-progress-circle size="l" indeterminate label="Rendering the preview"></sp-progress-circle><span class="subtle">Rendering the preview...</span></div>
    <div class="stage" id="stage"><img id="preview-img" alt="Template preview"><div id="zones"></div></div>
  </div>
  <div class="list" id="list">
    <div class="row head"><sp-checkbox id="select-all">Select all</sp-checkbox></div>
    <div id="layers"></div>
  </div>
</div>
<div class="actions"><sp-button variant="accent" id="confirm" disabled>Use these layers</sp-button></div>
<sp-help-text class="status" id="status"></sp-help-text>
`, `
  setStatus('Reading the template...', false, true);
  var layers = [];
  // Number of each layer shown on the preview (1, 2...), in the order of the list; none for layers without a zone
  var numbers = [];
  var listEl = document.getElementById('layers');
  var zonesEl = document.getElementById('zones');
  var confirmBtn = document.getElementById('confirm');
  var selectAll = document.getElementById('select-all');

  function selected() {
    return layers.filter(function (l, i) { return document.getElementById('layer-' + i).checked; });
  }

  // Keeps the "Select all" box, the preview zones and the button in sync with the layer boxes.
  function updateSelection() {
    var count = selected().length;
    layers.forEach(function (l, i) {
      var checked = document.getElementById('layer-' + i).checked;
      listEl.querySelector('.row[data-index="' + i + '"]').classList.toggle('selected', checked);
      var zone = zonesEl.querySelector('.zone[data-index="' + i + '"]');
      if (zone) {
        zone.classList.toggle('selected', checked);
        zone.setAttribute('aria-pressed', String(checked));
      }
    });
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
    var doc = data.document || {};
    var hasPreview = Boolean(data.previewUrl && doc.width && doc.height && layers.some(function (l) { return l.area; }));
    var next = 0;
    numbers = layers.map(function (l) { return hasPreview && l.area ? ++next : null; });
    listEl.innerHTML = layers.map(function (l, i) {
      var isText = l.type === 'text_layer';
      return '<div class="row" data-index="' + i + '"><sp-checkbox id="layer-' + i + '" aria-label="' + escapeHtml(l.name) + '"></sp-checkbox>'
        + '<span class="num ' + (isText ? 'text' : 'image') + '">' + (numbers[i] || '') + '</span>'
        + '<span class="layer-name" title="' + escapeHtml(l.name) + '">' + escapeHtml(l.name) + '</span>'
        + '<sp-badge size="s" variant="' + (isText ? 'informative' : 'seafoam') + '">' + (isText ? 'Text' : 'Smart object') + '</sp-badge>'
        + '</div>';
    }).join('');
    document.getElementById('list').style.display = 'block';
    if (hasPreview) renderPreview(data.previewUrl, doc);
    setStatus(layers.length + ' editable layer(s).');
  }

  // Spinner in place of the preview while it renders; hidePreviewLoader when it cannot be shown.
  function showPreviewLoader() {
    document.getElementById('stage').hidden = true;
    document.getElementById('preview-loader').hidden = false;
    document.getElementById('preview').hidden = false;
  }
  function hidePreviewLoader() {
    if (!document.getElementById('stage').hidden) return;
    document.getElementById('preview').hidden = true;
  }

  // Shows the preview rendered after the list, with the numbers of the layers, without changing the boxes already ticked.
  function showLatePreview(previewUrl, doc) {
    if (!doc.width || !doc.height || !layers.some(function (l) { return l.area; })) return;
    var next = 0;
    numbers = layers.map(function (l) { return l.area ? ++next : null; });
    layers.forEach(function (l, i) {
      listEl.querySelector('.row[data-index="' + i + '"] .num').textContent = numbers[i] || '';
    });
    renderPreview(previewUrl, doc);
    updateSelection();
  }

  // Numbered zones of the layers over the preview, the largest first so that smaller ones stay clickable on top.
  function renderPreview(previewUrl, doc) {
    var withArea = layers.map(function (l, i) { return i; }).filter(function (i) { return numbers[i]; });
    withArea.sort(function (a, b) { return layers[b].area.width * layers[b].area.height - layers[a].area.width * layers[a].area.height; });
    zonesEl.innerHTML = withArea.map(function (i) {
      var a = layers[i].area;
      var kind = layers[i].type === 'text_layer' ? 'text' : 'image';
      return '<button type="button" class="zone ' + kind + '" data-index="' + i + '" aria-pressed="false" aria-label="' + numbers[i] + '. ' + escapeHtml(layers[i].name) + '"'
        + ' title="' + escapeHtml(layers[i].name) + '" style="left:' + (a.left / doc.width * 100) + '%;top:' + (a.top / doc.height * 100) + '%;'
        + 'width:' + (a.width / doc.width * 100) + '%;height:' + (a.height / doc.height * 100) + '%">'
        + '<span class="num ' + kind + '">' + numbers[i] + '</span></button>';
    }).join('');
    var img = document.getElementById('preview-img');
    img.onload = function () { reportSize(); };
    img.src = previewUrl;
    document.getElementById('preview-loader').hidden = true;
    document.getElementById('stage').hidden = false;
    document.getElementById('preview').hidden = false;
    document.getElementById('intro').textContent = 'Click the numbered zones of the template, or the list, to pick the layers to use for the variants.';
  }

  // Hovering a row highlights its zone, and the other way around.
  function setHover(index) {
    [listEl, zonesEl].forEach(function (el) {
      el.querySelectorAll('.hover').forEach(function (node) { node.classList.remove('hover'); });
      if (index === null) return;
      var node = el.querySelector('[data-index="' + index + '"]');
      if (node) node.classList.add('hover');
    });
  }

  listEl.addEventListener('change', updateSelection);
  [listEl, zonesEl].forEach(function (el) {
    el.addEventListener('mouseover', function (e) {
      var node = e.target.closest('[data-index]');
      setHover(node ? node.getAttribute('data-index') : null);
    });
    el.addEventListener('mouseleave', function () { setHover(null); });
  });
  zonesEl.addEventListener('click', function (e) {
    var zone = e.target.closest('.zone');
    if (!zone) return;
    var box = document.getElementById('layer-' + zone.getAttribute('data-index'));
    box.checked = !box.checked;
    updateSelection();
  });
  selectAll.addEventListener('change', function () {
    var checked = selectAll.checked;
    layers.forEach(function (l, i) { document.getElementById('layer-' + i).checked = checked; });
    updateSelection();
  });

  // The template is read in a task: the layers come with the tool result when read in time, otherwise from the task, then
  // the preview from the task.
  onToolResult(function (result) {
    if (result.isError) {
      setStatus(result.content && result.content[0] ? result.content[0].text : 'Error', true);
      return;
    }
    var data = result.structuredContent || {};
    if (data.layers) render(data);
    if (!data.taskId || data.previewUrl) return;
    setStatus(layers.length ? layers.length + ' editable layer(s). Rendering the preview of the template...' : 'Reading the template...', false, true);
    showPreviewLoader();
    waitForTask(data.taskId, function (partial) {
      if (layers.length || !partial.layers) return;
      render(partial);
      setStatus(layers.length + ' editable layer(s). Rendering the preview of the template...', false, true);
      showPreviewLoader();
    })
      .then(function (template) {
        if (!layers.length) render(template);
        else if (template.previewUrl) showLatePreview(template.previewUrl, template.document || {});
        if (!template.previewUrl) hidePreviewLoader();
        setStatus(layers.length + ' editable layer(s).' + (template.previewUrl ? '' : ' Preview not available: ' + (template.previewError || 'no preview')));
      })
      .catch(function (error) {
        var reason = (error && error.message) || String(error);
        hidePreviewLoader();
        setStatus(layers.length ? layers.length + ' editable layer(s). Preview not available: ' + reason : reason, !layers.length);
      });
  });

  confirmBtn.addEventListener('click', function () {
    var chosen = selected();
    if (!chosen.length) return;
    confirmBtn.disabled = true;
    var images = chosen.filter(function (l) { return l.type === 'smart_object_layer'; });
    var context = 'Layers selected by the user for the variants: ' + JSON.stringify(chosen.map(function (l) {
      return { id: l.id, name: l.name, type: l.type };
    })) + '. Next: if text layers were selected, get the texts of each variant (from the user, or written from a brief), each as long as '
      + 'the original text of its layer, give each variant a short label, then call review-variant-texts'
      + (images.length
        ? '; then call upload-variant-images ONCE with all variant labels and layers ' + JSON.stringify(images.map(function (l) { return { id: l.id, name: l.name, width: l.frame && l.frame.width, height: l.frame && l.frame.height }; }))
          + ' (one grid for all variants; never call upload-file per image)'
        : '')
      + '; then call create-variant ONCE with all variants, without a recap.';
    var message = 'I picked these layers: ' + chosen.map(function (l) { return l.name; }).join(', ') + '. '
      + (chosen.length > images.length ? "Let's fill in the texts of each variant." : 'Continue.');
    sendToModel(context, message, 'Selection sent.')
      .catch(function (error) {
        confirmBtn.disabled = false;
        setStatus((error && error.message) || String(error), true);
      });
  });
`)
}

function getTextsViewHtml (scriptUrl) {
  return page(scriptUrl, 'Variant Texts', `
  .subtle.intro { margin-bottom: var(--spectrum-spacing-200); }
  .table-wrap { overflow-x: auto; }
  /* Compact table with Spectrum tokens: header row above a rounded, bordered body, one column per text layer */
  .texts { width: 100%; border-collapse: separate; border-spacing: 0; }
  .texts th {
    padding: var(--spectrum-spacing-100) var(--spectrum-spacing-200);
    font-size: var(--spectrum-font-size-75);
    font-weight: var(--spectrum-bold-font-weight);
    text-align: left;
    min-width: 180px;
  }
  .texts th:first-child { width: 130px; min-width: 130px; }
  .texts td { padding: var(--spectrum-spacing-100) var(--spectrum-spacing-200); vertical-align: top; border-top: 1px solid var(--spectrum-gray-300); }
  .texts td:first-child { font-weight: var(--spectrum-bold-font-weight); border-left: 1px solid var(--spectrum-gray-300); }
  .texts td:last-child { border-right: 1px solid var(--spectrum-gray-300); }
  .texts tr:last-child td { border-bottom: 1px solid var(--spectrum-gray-300); }
  .texts tr:first-child td:first-child { border-top-left-radius: var(--spectrum-corner-radius-200); }
  .texts tr:first-child td:last-child { border-top-right-radius: var(--spectrum-corner-radius-200); }
  .texts tr:last-child td:first-child { border-bottom-left-radius: var(--spectrum-corner-radius-200); }
  .texts tr:last-child td:last-child { border-bottom-right-radius: var(--spectrum-corner-radius-200); }
  /* Editable texts: a light filled box, outlined on hover and in the accent color on focus, growing with its text */
  .text-input {
    display: block;
    width: 100%;
    min-height: 32px;
    field-sizing: content;
    padding: var(--spectrum-spacing-75) var(--spectrum-spacing-100);
    font: inherit;
    line-height: 1.4;
    color: var(--spectrum-neutral-content-color-default);
    background: var(--spectrum-gray-100);
    border: 1px solid transparent;
    border-radius: var(--spectrum-corner-radius-100);
    resize: none;
    overflow: hidden;
    cursor: text;
  }
  .text-input:hover { border-color: var(--spectrum-gray-400); }
  .text-input:focus { outline: none; border-color: var(--spectrum-accent-background-color-default); background: var(--spectrum-background-base-color); }
  /* Original text of a layer under its name */
  .original { font-weight: normal; color: var(--spectrum-neutral-subdued-content-color-default); white-space: pre-line; }
`, `
<h2 class="heading" id="title">Texts per variant</h2>
<div class="subtle intro">Click a text to edit it, then confirm. Keep each text about as long as the original, so that it fits the layout.</div>
<div class="table-wrap"><table class="texts" id="table"></table></div>
<div class="actions">
  <sp-button variant="accent" id="confirm" disabled>Use these texts</sp-button>
  <sp-help-text class="status" id="status"></sp-help-text>
</div>
`, `
  var table = document.getElementById('table');
  var confirmBtn = document.getElementById('confirm');
  var layers = [];
  var variants = [];

  function textOf(variant, layer) {
    var entry = (variant.texts || []).find(function (t) { return t.layerId === layer.id; });
    return entry ? entry.text : '';
  }

  function scaleOf(variant, layer) {
    var entry = (variant.texts || []).find(function (t) { return t.layerId === layer.id; });
    return entry && entry.fontScale ? entry.fontScale : 1;
  }

  function inputs() { return Array.prototype.slice.call(table.querySelectorAll('.text-input')); }

  // Current texts of the table, one entry per variant with one text per layer.
  // The font scale chosen by the model is kept as is: it is not shown in the table.
  function currentTexts() {
    var fields = inputs();
    return variants.map(function (v, r) {
      return {
        label: v.label,
        texts: layers.map(function (l, c) {
          var text = { layerId: l.id, layerName: l.name, text: fields[r * layers.length + c].value };
          var scale = scaleOf(v, l);
          if (scale !== 1) text.fontScale = scale;
          return text;
        })
      };
    });
  }

  // Browsers without CSS field-sizing fit the heights in JS: once per frame at most, resetting all heights before
  // reading them so that the layout is computed once; again when the column widths change.
  var FITS_CONTENT = Boolean(window.CSS && CSS.supports('field-sizing', 'content'));
  var fitPending = false;
  function fit(fields) {
    fields.forEach(function (field) { field.style.height = 'auto'; });
    var heights = fields.map(function (field) { return field.scrollHeight + 2; });
    fields.forEach(function (field, i) { field.style.height = heights[i] + 'px'; });
  }
  function fitAll() {
    if (FITS_CONTENT || fitPending) return;
    fitPending = true;
    requestAnimationFrame(function () { fitPending = false; fit(inputs()); });
  }
  if (!FITS_CONTENT) {
    var lastWidth = 0;
    if (window.ResizeObserver) {
      new ResizeObserver(function (entries) {
        var width = entries[0].contentRect.width;
        if (width !== lastWidth) { lastWidth = width; fitAll(); }
      }).observe(table);
    }
    table.addEventListener('input', function (e) { if (e.target.classList.contains('text-input')) fit([e.target]); });
  }

  // One column per text layer, one row per variant with an editable text per layer (in this order in the DOM).
  function render() {
    table.innerHTML = '<thead><tr><th>Variant</th>'
      + layers.map(function (l) {
        return '<th>' + escapeHtml(l.name) + (l.text != null ? '<div class="original">' + escapeHtml(l.text) + '</div>' : '') + '</th>';
      }).join('')
      + '</tr></thead><tbody>'
      + variants.map(function (v) {
        return '<tr><td>' + escapeHtml(v.label) + '</td>'
          + layers.map(function (l, c) {
            return '<td><textarea class="text-input" rows="1" data-layer="' + c + '" aria-label="' + escapeHtml(v.label + ', ' + l.name) + '">'
              + escapeHtml(textOf(v, l)) + '</textarea></td>';
          }).join('') + '</tr>';
      }).join('')
      + '</tbody>';
    fitAll();
    confirmBtn.disabled = !variants.length;
  }

  onToolInput(function (args) {
    layers = args.layers || [];
    variants = args.variants || [];
    if (args.title) document.getElementById('title').textContent = args.title;
    render();
  });

  confirmBtn.addEventListener('click', function () {
    confirmBtn.disabled = true;
    var confirmed = currentTexts();
    var context = 'Texts confirmed by the user for each variant. Use them exactly, as text_layer edits '
      + '{ id: layerId, type: "text_layer", text, fontScale } in create-variant (fontScale only where given):\\n' + JSON.stringify({ variants: confirmed });
    sendToModel(context, 'I confirmed the texts of the ' + confirmed.length + ' variant(s), continue.', 'Texts sent.')
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
  /* Visual of a variant, at the ratio of its canvas so that the marks of its text problems are placed over it */
  .visual { position: relative; width: 100%; margin: 0 auto; }
  .visual img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: contain;
    border-radius: var(--spectrum-corner-radius-200);
    background: var(--spectrum-gray-100);
  }
  .card .visual img { max-height: 320px; cursor: zoom-in; }
  .mark { position: absolute; box-sizing: border-box; pointer-events: none; }
  .mark-text { border: 2px dashed var(--spectrum-notice-visual-color, #e68619); }
  .mark-overlap { background: rgba(227, 72, 80, 0.35); border: 1px solid rgb(227, 72, 80); }
  .mark-number, .issue-number {
    display: inline-block;
    min-width: 18px;
    height: 18px;
    padding: 0 4px;
    box-sizing: border-box;
    border-radius: 9px;
    background: var(--spectrum-notice-visual-color, #e68619);
    color: #fff;
    font-size: 11px;
    font-weight: bold;
    line-height: 18px;
    text-align: center;
  }
  .mark-number { position: absolute; top: -9px; left: -9px; }
  .issue-number { margin-right: 4px; }
  .card-name { word-break: break-all; }
  /* In place of the visual of a variant being rendered */
  .rendering {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--spectrum-spacing-200);
    height: 200px;
    border-radius: var(--spectrum-corner-radius-200);
    background: var(--spectrum-gray-100);
  }
  /* Changes of each variant, in free text, pre-filled with the proposed fixes of its texts */
  .change-request {
    width: 100%;
    min-height: 48px;
    padding: var(--spectrum-spacing-75) var(--spectrum-spacing-100);
    font: inherit;
    font-size: var(--spectrum-font-size-75);
    color: var(--spectrum-neutral-content-color-default);
    background: var(--spectrum-gray-100);
    border: 1px solid transparent;
    border-radius: var(--spectrum-corner-radius-100);
    resize: vertical;
  }
  .change-request:focus { outline: none; border-color: var(--spectrum-accent-background-color-default); }
  .downloads { display: flex; flex-wrap: wrap; gap: var(--spectrum-spacing-100); }
  .card-error { color: var(--spectrum-negative-content-color-default); font-size: var(--spectrum-font-size-75); word-break: break-word; }
  .card-warning { color: var(--spectrum-notice-content-color-default, var(--spectrum-negative-content-color-default)); font-size: var(--spectrum-font-size-75); word-break: break-word; }
  .preview { display: none; }
  .preview.open { display: block; }
  .preview-bar { display: flex; align-items: center; gap: var(--spectrum-spacing-200); margin-bottom: var(--spectrum-spacing-200); }
  .preview-name { flex: 1; min-width: 0; font-weight: var(--spectrum-bold-font-weight); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .preview .visual img { max-height: 640px; cursor: zoom-out; }
`, `
<div class="preview" id="preview">
  <div class="preview-bar">
    <sp-button size="s" variant="secondary" treatment="outline" data-action="back">All variants</sp-button>
    <span class="preview-name" id="preview-name"></span>
    <sp-button size="s" variant="secondary" treatment="outline" data-action="prev">Previous</sp-button>
    <sp-button size="s" variant="secondary" treatment="outline" data-action="next">Next</sp-button>
    <span class="downloads" id="preview-downloads"></span>
  </div>
  <div id="preview-visual"></div>
</div>
<div class="grid" id="grid"></div>
<div class="actions" id="fix-actions" hidden>
  <sp-button variant="accent" id="send-changes" disabled>Send changes</sp-button>
</div>
<sp-help-text class="status" id="status"></sp-help-text>
`, `
  setStatus('Generating variants...', false, true);
  var grid = document.getElementById('grid');
  var preview = document.getElementById('preview');
  var previewVisual = document.getElementById('preview-visual');
  var variants = [];
  var current = -1;
  // Changes of each variant, by file name: pre-filled with the proposed fixes, edited by the user
  var requests = {};
  var busy = false;
  // While the variants of the tool call are generated
  var generating = false;
  var sendBtn = document.getElementById('send-changes');
  var FORMAT_LABELS = { png: 'PNG', jpeg: 'JPEG', psd: 'PSD' };
  // Download icon (arrow into a tray), in the text color of the button
  var DOWNLOAD_ICON = '<svg slot="icon" viewBox="0 0 18 18" width="16" height="16" aria-hidden="true">'
    + '<path fill="currentColor" d="M9 1.5a.75.75 0 0 1 .75.75v7.94l2.47-2.47a.75.75 0 1 1 1.06 1.06l-3.75 3.75a.75.75 0 0 1-1.06 0L4.72 8.78a.75.75 0 0 1 1.06-1.06l2.47 2.47V2.25A.75.75 0 0 1 9 1.5ZM2.25 12a.75.75 0 0 1 .75.75v1.5c0 .41.34.75.75.75h10.5c.41 0 .75-.34.75-.75v-1.5a.75.75 0 0 1 1.5 0v1.5A2.25 2.25 0 0 1 14.25 16.5H3.75A2.25 2.25 0 0 1 1.5 14.25v-1.5a.75.75 0 0 1 .75-.75Z"/></svg>';

  // Files of a variant, one per format (results of earlier versions have a single image)
  function filesOf(v) {
    return v.files || [{ format: v.format, url: v.downloadUrl || v.imageUrl }];
  }

  // One compact button per file of the variant: download icon and format, "Download <format>" as its accessible name
  function downloadButtons(index, variant) {
    return filesOf(variants[index]).map(function (file, f) {
      var label = FORMAT_LABELS[file.format] || 'file';
      return '<sp-button size="s" variant="' + variant + '" treatment="outline" data-action="download" data-index="' + index + '" data-file="' + f + '"'
        + ' label="Download ' + label + '" title="Download ' + label + '">' + DOWNLOAD_ICON + label + '</sp-button>';
    }).join('');
  }

  // Rectangle of the canvas as a box over the visual, in % (kept inside the canvas: a text past an edge is marked up to it)
  function markHtml(canvas, rect, className, number) {
    var left = Math.max(0, rect.left);
    var top = Math.max(0, rect.top);
    var right = Math.min(canvas.width, rect.left + rect.width);
    var bottom = Math.min(canvas.height, rect.top + rect.height);
    if (right <= left || bottom <= top) return '';
    return '<div class="mark ' + className + '" style="left:' + left / canvas.width * 100 + '%;top:' + top / canvas.height * 100
      + '%;width:' + (right - left) / canvas.width * 100 + '%;height:' + (bottom - top) / canvas.height * 100 + '%">'
      + (number ? '<span class="mark-number">' + number + '</span>' : '') + '</div>';
  }

  // Visual of a variant with its text problems marked over it: the box of each text with problems, numbered as in the list,
  // and where it overlaps other elements. Without the canvas size (variants of earlier versions), the image only.
  function visualHtml(v, index, maxHeight) {
    var c = v.canvas;
    var marks = c ? (v.textIssues || []).map(function (issue, k) {
      return (issue.marks || []).map(function (rect) { return markHtml(c, rect, 'mark-overlap'); }).join('')
        + (issue.area ? markHtml(c, issue.area, 'mark-text', k + 1) : '');
    }).join('') : '';
    var style = c ? ' style="aspect-ratio:' + c.width + '/' + c.height + ';max-width:' + Math.round(maxHeight * c.width / c.height) + 'px"' : '';
    return '<div class="visual"' + style + '><img src="' + escapeHtml(v.imageUrl) + '" alt="' + escapeHtml(v.fileName) + '" data-index="' + index + '">'
      + marks + '</div>';
  }

  function render() {
    // The field being typed in keeps its focus and caret when the grid is drawn again (variants arrive while the user types)
    var active = document.activeElement && document.activeElement.classList.contains('change-request')
      ? { index: document.activeElement.getAttribute('data-index'), start: document.activeElement.selectionStart, end: document.activeElement.selectionEnd }
      : null;
    grid.innerHTML = variants.map(function (v, i) {
      if (v.pending) {
        return '<div class="card"><div class="rendering"><sp-progress-circle size="m" indeterminate label="Rendering"></sp-progress-circle>'
          + '<span class="subtle">Rendering...</span></div><div class="subtle card-name">' + escapeHtml(v.fileName) + '</div></div>';
      }
      if (v.error) {
        return '<div class="card"><div class="subtle card-name">' + escapeHtml(v.fileName) + '</div>'
          + '<div class="card-error">' + escapeHtml(v.error) + '</div></div>';
      }
      // Text problems measured on the generated file, numbered as their marks on the visual
      var problems = (v.textIssues || []).map(function (issue, k) {
        return '<div class="card-warning"><span class="issue-number">' + (k + 1) + '</span>'
          + escapeHtml('"' + issue.layerName + '" ' + issue.problems.join(', ')) + '</div>';
      }).join('')
        // Checks not done, and why: the user checks the visual
        + (v.textsUnchecked ? '<div class="subtle">' + escapeHtml((v.textIssues ? 'Texts partly checked, ' : 'Texts not checked, check the visual: ')
          + v.textsUnchecked) + '</div>' : '')
        + (v.checking ? '<sp-progress-bar size="s" label="Checking the texts" indeterminate></sp-progress-bar>' : '');
      // Pre-filled once the texts are checked
      if (requests[v.fileName] == null && !v.checking) requests[v.fileName] = recommendationOf(v);
      return '<div class="card">' + visualHtml(v, i, 320)
        + '<div class="subtle card-name">' + escapeHtml(v.fileName) + '</div>'
        + problems
        + '<textarea class="change-request" data-index="' + i + '" placeholder="What should change?">' + escapeHtml(requests[v.fileName] || '') + '</textarea>'
        + '<div class="downloads">' + downloadButtons(i, 'secondary') + '</div></div>';
    }).join('');
    if (active) {
      var field = grid.querySelector('.change-request[data-index="' + active.index + '"]');
      if (field) { field.focus(); field.setSelectionRange(active.start, active.end); }
    }
    var ok = variants.filter(function (v) { return !v.error && !v.pending; }).length;
    var rendering = variants.filter(function (v) { return v.pending; }).length;
    if (generating) setStatus('Generating: ' + ok + ' variant(s) ready, ' + rendering + ' rendering...', false, true);
    else setStatus(ok + '/' + variants.length + ' variant(s) generated — click a visual to enlarge it — links valid for 24 hours', ok === 0);
    document.getElementById('fix-actions').hidden = !ok;
    updateFixActions();
  }

  // Proposed fixes of the texts of a variant (a smaller font size), as pre-filled in its changes
  function recommendationOf(v) {
    return (v.textIssues || []).map(function (issue) {
      return 'Reduce the font size of "' + issue.layerName + '" to ' + Math.round(issue.fontScale * 100) + '%.'
        + (issue.shorten ? ' A shorter text may be needed.' : '');
    }).join('\\n');
  }

  // Changes of a variant, '' if none
  function requestOf(v) { return (requests[v.fileName] || '').trim(); }

  function updateFixActions() {
    var count = variants.filter(function (v) { return !v.error && requestOf(v); }).length;
    sendBtn.textContent = count ? 'Send changes (' + count + ')' : 'Send changes';
    // Changes are sent once the generation is done, so that the next one does not start meanwhile
    sendBtn.disabled = busy || generating || !count;
  }

  // Sends the changes of the variants to the model, which generates them again with create-variant. With the measured
  // problems of each text (layer id and proposed font scale), so that it can apply the proposed fixes the user kept.
  function sendChanges() {
    var toChange = variants.filter(function (v) { return !v.error && requestOf(v); });
    var changes = toChange.map(function (v) {
      return {
        fileName: v.fileName,
        change: requestOf(v),
        textIssues: (v.textIssues || []).map(function (issue) {
          return { layerId: issue.layerId, layerName: issue.layerName, problems: issue.problems, fontScale: issue.fontScale, shorten: issue.shorten };
        })
      };
    });
    var context = 'Changes requested by the user in the create-variant widget (they may include proposed font size fixes, kept or '
      + 'edited: textIssues gives the layer id of each text). Make each change, then call create-variant ONCE with these variants only, '
      + 'with the same file names and the same edits as before except the changes (a font size of N% is fontScale N/100). If a change '
      + 'is unclear, ask the user first.\\n' + JSON.stringify(changes);
    busy = true;
    updateFixActions();
    sendToModel(context, 'Please apply my changes to ' + changes.length + ' variant(s).', 'Changes sent.')
      .then(function () { toChange.forEach(function (v) { requests[v.fileName] = ''; }); render(); })
      .catch(function (error) { setStatus((error && error.message) || String(error), true); })
      .then(function () { busy = false; updateFixActions(); });
  }

  sendBtn.addEventListener('click', sendChanges);

  grid.addEventListener('input', function (e) {
    if (!e.target.classList.contains('change-request')) return;
    requests[variants[Number(e.target.getAttribute('data-index'))].fileName] = e.target.value;
    updateFixActions();
  });

  function generated() {
    return variants.map(function (v, i) { return i; }).filter(function (i) { return !variants[i].error && !variants[i].pending; });
  }

  // Enlarged view of one variant inside the widget; index -1 goes back to the grid.
  function showPreview(index) {
    current = index;
    var open = index >= 0;
    preview.classList.toggle('open', open);
    grid.style.display = open ? 'none' : '';
    if (open) {
      previewVisual.innerHTML = visualHtml(variants[index], index, 640);
      var list = generated();
      document.getElementById('preview-name').textContent = variants[index].fileName + ' (' + (list.indexOf(index) + 1) + '/' + list.length + ')';
      document.getElementById('preview-downloads').innerHTML = downloadButtons(index, 'accent');
    }
    reportSize();
  }

  function step(delta) {
    var list = generated();
    showPreview(list[(list.indexOf(current) + delta + list.length) % list.length]);
  }

  function download(button) {
    var file = filesOf(variants[Number(button.getAttribute('data-index'))])[Number(button.getAttribute('data-file'))];
    request('ui/open-link', { url: file.url }).catch(function () {
      setStatus('Could not open the download link.', true);
    });
  }

  grid.addEventListener('click', function (e) {
    var target = e.target.closest('img, sp-button');
    if (!target || !target.hasAttribute('data-index')) return;
    var index = Number(target.getAttribute('data-index'));
    if (target.tagName === 'IMG') showPreview(index);
    else download(target);
  });

  preview.addEventListener('click', function (e) {
    if (e.target.closest('.visual')) return showPreview(-1);
    var button = e.target.closest('sp-button');
    if (!button) return;
    var action = button.getAttribute('data-action');
    if (action === 'back') showPreview(-1);
    else if (action === 'prev') step(-1);
    else if (action === 'next') step(1);
    else if (action === 'download') download(button);
  });

  // load does not bubble: listened to in the capture phase
  preview.addEventListener('load', reportSize, true);
  document.addEventListener('keydown', function (e) {
    if (current < 0) return;
    if (e.key === 'Escape') showPreview(-1);
    else if (e.key === 'ArrowLeft') step(-1);
    else if (e.key === 'ArrowRight') step(1);
  });

  // The variants are generated in a task: shown as they are rendered, then checked; when all are done, the model is given
  // the result (failures, warnings, text problems).
  onToolResult(function (result) {
    var data = result.structuredContent || {};
    if (result.isError || (!data.taskId && !data.variants)) {
      setStatus(result.content && result.content[0] ? result.content[0].text : 'Error', true);
      return;
    }
    if (!data.taskId) {
      variants = data.variants;
      render();
      return;
    }
    generating = true;
    variants = (data.pending || []).map(function (fileName) { return { fileName: fileName, pending: true }; });
    render();
    waitForTask(data.taskId, function (partial) {
      variants = partial.variants || variants;
      render();
    })
      .then(function (generation) {
        generating = false;
        variants = generation.variants || variants;
        render();
        return request('ui/update-model-context', { content: [{ type: 'text', text: 'Result of create-variant: ' + generation.summary }] });
      })
      .catch(function (error) {
        generating = false;
        // Variants not rendered are marked as failed, the others are kept
        variants = variants.map(function (v) { return v.pending ? { fileName: v.fileName, error: (error && error.message) || String(error) } : v; });
        render();
      });
  });
`)
}

module.exports = { getStartViewHtml, getUploadViewHtml, getVariantImagesViewHtml, getLayersViewHtml, getTextsViewHtml, getVariantViewHtml }
