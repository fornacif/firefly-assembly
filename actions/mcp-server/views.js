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
  var _hostContextHandler = null;
  // Context given by the host (theme, display mode and the modes it offers), updated as it changes; the display modes of the
  // view, told to the host (a view shown full screen at times adds 'fullscreen')
  var hostContext = {};
  var appDisplayModes = ['inline'];
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
  function onHostContextChanged(handler) { _hostContextHandler = handler; }

  // Whether the host can show the view full screen (ui/request-display-mode)
  // Bottom inset of the host (safeAreaInsets), kept for the views shown full screen
  function applyInsets(context) {
    var bottom = context && context.safeAreaInsets && Number(context.safeAreaInsets.bottom);
    document.documentElement.style.setProperty('--host-bottom-inset', (bottom > 0 ? bottom : 0) + 'px');
  }
  function canFullscreen() { return (hostContext.availableDisplayModes || []).indexOf('fullscreen') >= 0; }

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
      hostContext = Object.assign({}, hostContext, msg.params);
      applyTheme(msg.params);
      applyInsets(hostContext);
      if (_hostContextHandler) _hostContextHandler(msg.params || {});
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
      // Full screen, the host sets the size of the view: none is told (it would make the host resize it while it changes mode)
      if (document.body.classList.contains('fullscreen')) return;
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
  // Sends a result to the model: kept by the server (with data, when given: the texts and images confirmed) under a short
  // reference that ends the user message; {{ref}} in the context is replaced with it
  function sendToModel(context, message, sentStatus, data) {
    return callTool('save-widget-result', data ? { text: context, data: data } : { text: context })
      .then(function (saved) { return saved.ref; })
      // Without a reference, Claude can still read the result in the model context
      .catch(function () { return null; })
      .then(function (ref) {
        context = context.split('{{ref}}').join(ref || '(none: pass the variants)');
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
      appCapabilities: { availableDisplayModes: appDisplayModes }
    }).then(function (result) {
      hostContext = result.hostContext || {};
      applyTheme(result.hostContext);
      applyInsets(hostContext);
      notification('ui/notifications/initialized');
      reportSize();
    }).catch(function () {}).then(_readyResolve);
  }
`

// Adobe logo, in the icon slot of the AEM buttons. Inline styles, because sp-button colors (fill and stroke) the icons
// of its slot with the text color, which SVG presentation attributes do not override.
const ADOBE_ICON = '<svg slot="icon" viewBox="0 10.22 16.86 14.94" width="18" height="16" aria-hidden="true" style="fill:#eb1000;stroke:none">' +
  '<path style="fill:#eb1000;stroke:none" d="M6.27,10.22h4.39l6.2,14.94h-4.64l-3.92-9.92-2.59,6.51h3.08l1.23,3.41H0l6.27-14.94"/></svg>'

// Keep in sync with MAX_VARIANTS, MAX_TEMPLATES and MAX_RENDERS in tools.js
const MAX_VARIANTS_UI = 50
const MAX_TEMPLATES_UI = 5
const MAX_RENDERS_UI = 100
// Languages offered in the start widget: ISO 639-1 code and name
const LANGUAGES = [['en', 'English'], ['fr', 'French'], ['it', 'Italian'], ['de', 'German'], ['es', 'Spanish'], ['pt', 'Portuguese'],
  ['nl', 'Dutch'], ['pl', 'Polish'], ['sv', 'Swedish'], ['da', 'Danish'], ['no', 'Norwegian'], ['fi', 'Finnish']]

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

  function pickAemAssets(multiple, what) {
    var pickId = ++aemPickId;
    return callTool('create-aem-picker-session', { multiple: multiple })
      .then(function (session) {
        return request('ui/open-link', { url: session.pickerUrl }).then(function (result) {
          if (result && result.isError) throw new Error('The AEM selector tab could not be opened.');
          setStatus('Choose ' + (what || (multiple ? 'the images' : 'the PSD template')) + ' in the AEM tab that opened, then come back here.');
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

// Shows in an element the APIs whose quota is used up (get-quota), e.g. until midnight UTC: the generations fail until then.
const QUOTA_SCRIPT = `
  function showQuota(element) {
    return callTool('get-quota').then(function (quota) {
      element.textContent = quota.usedUp.map(function (api) { return api.message; }).join(' ');
      element.hidden = !quota.usedUp.length;
      reportSize();
    }, function () {});
  }
`

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
  .field input.wide { width: 360px; max-width: 100%; }
  /* The picker of the languages, in place, then the languages chosen as tags that can be removed, wrapping next to it */
  .languages { display: flex; align-items: flex-start; gap: var(--spectrum-spacing-200); }
  .languages sp-picker { flex: 0 0 200px; width: 200px; }
  /* Each tag has a margin on all sides: taken back, so that the first row is aligned with the picker */
  .languages sp-tags { flex: 1; min-width: 0; margin: calc(-1 * var(--spectrum-spacing-75)); }
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
  /* Templates imported (one per format): a row each, with its size, its state and a button to remove it */
  .template-list { display: flex; flex-direction: column; gap: var(--spectrum-spacing-100); margin-top: var(--spectrum-spacing-200); }
  .template-row { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; align-items: center; gap: var(--spectrum-spacing-200);
    padding: var(--spectrum-spacing-100) var(--spectrum-spacing-200); background: var(--spectrum-background-layer-2-color);
    border: 1px solid var(--spectrum-gray-200); border-radius: var(--spectrum-corner-radius-200); }
  .template-row .template-name { font-weight: var(--spectrum-bold-font-weight); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .template-row .template-state { font-size: var(--spectrum-font-size-75); color: var(--spectrum-neutral-subdued-content-color-default); white-space: nowrap; }
  .template-row .template-state.negative { color: var(--spectrum-negative-content-color-default); white-space: normal; }
  .template-row sp-progress-bar { grid-column: 1 / -1; margin-top: 0; }
  .template-remove { width: 24px; height: 24px; padding: 0; font: inherit; font-size: 15px; line-height: 22px; color: var(--spectrum-neutral-content-color-default);
    background: transparent; border: 1px solid var(--spectrum-gray-400); border-radius: 50%; cursor: pointer; }
  .template-remove:hover { background: var(--spectrum-gray-200); }
  /* One tab per template in the layer step, with the number of layers picked in it */
  .template-tabs { display: flex; flex-wrap: wrap; gap: var(--spectrum-spacing-100); margin-bottom: var(--spectrum-spacing-300); }
  .template-tab { font: inherit; font-size: var(--spectrum-font-size-75); padding: var(--spectrum-spacing-75) var(--spectrum-spacing-200);
    color: var(--spectrum-neutral-content-color-default); background: transparent; border: 2px solid var(--spectrum-gray-300);
    border-radius: 16px; cursor: pointer; }
  .template-tab:hover { border-color: var(--spectrum-gray-500); }
  .template-tab.active { border-color: var(--spectrum-accent-background-color-default); color: var(--spectrum-accent-content-color-default); font-weight: var(--spectrum-bold-font-weight); }
  .linked { margin-top: var(--spectrum-spacing-200); font-size: var(--spectrum-font-size-75); }
  /* Fonts added, under the preview: tags that can be removed next to the button */
  .field.fonts { margin-top: var(--spectrum-spacing-300); }
  .ai-prompt { white-space: nowrap; }
  .fonts-row { display: flex; align-items: center; flex-wrap: wrap; gap: var(--spectrum-spacing-200); }
  #font-files { display: none; }
  /* Message under the fonts: a warning (missing fonts) has an icon, in the orange of Spectrum notices */
  .fonts-help { display: flex; align-items: flex-start; gap: var(--spectrum-spacing-75); margin-top: var(--spectrum-spacing-75);
    font-size: var(--spectrum-font-size-75); color: var(--spectrum-neutral-subdued-content-color-default); }
  .fonts-help svg { flex: none; margin-top: 1px; }
  .fonts-help.warning { color: var(--spectrum-orange-1000, #a54b00); }
  .fonts-help.warning svg { color: var(--spectrum-notice-visual-color, #e68619); }
  .fonts-help.negative { color: var(--spectrum-negative-content-color-default, #d31510); }
  /* Fonts added before (the library of the user): a chip each, to add it, with a button to remove it from the library */
  .font-library { display: flex; align-items: center; flex-wrap: wrap; gap: var(--spectrum-spacing-100); font-size: var(--spectrum-font-size-75); }
  .font-library .library-label { color: var(--spectrum-neutral-subdued-content-color-default); margin-right: var(--spectrum-spacing-75); }
  .font-chip { display: inline-flex; align-items: center; border: 1px solid var(--spectrum-gray-400); border-radius: 14px; overflow: hidden; }
  .font-chip button { font: inherit; color: var(--spectrum-neutral-content-color-default); background: transparent; border: none; cursor: pointer;
    padding: 3px 8px; }
  .font-chip button:hover { background: var(--spectrum-gray-200); }
  .font-chip.used { border-color: var(--spectrum-accent-background-color-default); background: var(--spectrum-accent-background-color-default); }
  .font-chip.used button { color: #ffffff; }
  .font-chip.used button:hover { background: rgba(0, 0, 0, 0.15); }
  .font-chip.used .font-forget { border-left-color: rgba(255, 255, 255, 0.4); color: #ffffff; }
  .font-chip .font-forget { padding: 3px 7px; border-left: 1px solid var(--spectrum-gray-300); color: var(--spectrum-neutral-subdued-content-color-default); }
${STEPS_CSS}
${LAYERS_CSS}
`, `
<h2 class="heading">Create variants</h2>
<ol class="steps" aria-label="Steps">
  <li data-for="1" class="current" role="button" tabindex="-1"><span class="step-kicker">Step 1</span><span class="step-title">Variants and template</span></li>
  <li data-for="2" role="button" tabindex="-1"><span class="step-kicker">Step 2</span><span class="step-title">Layers to vary</span></li>
</ol>
<div data-step="1">
<div class="subtle intro">Set the number of variants and their languages, and drop the layered PSD template, or one template per format.</div>
<div class="field">
  <label for="count">Number of variants per language</label>
  <input type="number" id="count" min="1" max="${MAX_VARIANTS_UI}" value="2">
</div>
<div class="field">
  <label>Languages</label>
  <div class="languages">
    <sp-picker id="add-language" label="Add a language"></sp-picker>
    <sp-tags id="languages"></sp-tags>
  </div>
  <sp-help-text id="total"></sp-help-text>
</div>
<div class="field">
  <label for="naming">File names</label>
  <input type="text" id="naming" class="wide" value="{template}_{variant}_{language}" spellcheck="false">
  <sp-help-text id="naming-help"></sp-help-text>
</div>
<sp-dropzone id="drop">
  <div class="message"><div id="message-heading">Drop your PSD templates</div><div class="subtle" id="message-description">Layered .psd files, one per format</div></div>
  <div class="browse">
    <sp-button variant="accent" treatment="outline" id="browse">Browse</sp-button>
    <sp-button variant="accent" treatment="outline" id="aem" hidden>${ADOBE_ICON}Choose from AEM</sp-button>
    <input type="file" id="file" accept=".psd,image/vnd.adobe.photoshop" multiple>
  </div>
</sp-dropzone>
<div class="template-list" id="template-list" hidden></div>
<sp-help-text id="estimate" hidden></sp-help-text>
</div>
<div data-step="2" hidden>
  <div class="subtle intro" id="layers-intro">Click the numbered zones of the template, or the list, to pick the layers to change in the variants.</div>
  <div class="template-tabs" id="template-tabs" role="tablist" hidden></div>
  ${LAYERS_HTML}
  <div class="subtle linked" id="linked" hidden></div>
<div class="field fonts">
  <label>Fonts</label>
  <div class="fonts-row">
    <sp-button variant="secondary" treatment="outline" id="add-fonts">Add fonts</sp-button>
    <input type="file" id="font-files" accept=".otf,.ttf,font/otf,font/ttf" multiple>
    <div class="font-library" id="font-library" hidden></div>
  </div>
  <div id="fonts-help" class="fonts-help" role="status"></div>
</div>
</div>
<sp-help-text id="quota" variant="negative" icon hidden></sp-help-text>
<div class="actions">
  <sp-button variant="secondary" treatment="outline" id="back" hidden>Back</sp-button>
  <sp-button variant="accent" id="next" disabled>Next</sp-button>
  <sp-button variant="accent" id="continue" hidden disabled>Continue</sp-button>
  <sp-help-text class="status" id="status"></sp-help-text>
</div>
`, `
${UPLOAD_SCRIPT}
${AEM_SCRIPT}
${QUOTA_SCRIPT}
${LAYERS_SCRIPT}
  // Layers picked in all the templates; while a template is shown again (another tab), its boxes are set without linking
  var layerCount = 0;
  var switching = false;
  function onLayersChange() {
    if (!switching) syncSelection();
    layerCount = templates.reduce(function (total, t) { return total + checkedIds(t).length; }, 0);
    renderAiPrompts();
    renderTabs();
    updateButton();
  }
  var LANGUAGE_NAMES = ${JSON.stringify(Object.fromEntries(LANGUAGES))};
  var countInput = document.getElementById('count');
  var input = document.getElementById('file');
  var drop = document.getElementById('drop');
  var templateList = document.getElementById('template-list');
  var templateTabs = document.getElementById('template-tabs');
  var linkedEl = document.getElementById('linked');
  var messageHeading = document.getElementById('message-heading');
  var messageDescription = document.getElementById('message-description');
  var continueBtn = document.getElementById('continue');
  var nextBtn = document.getElementById('next');
  var backBtn = document.getElementById('back');

  // Shows a step: 1, the variants and the template; 2, the layers of the template (read meanwhile, as soon as it is uploaded)
  function showStep(step) {
    Array.prototype.forEach.call(document.querySelectorAll('[data-step]'), function (el) { el.hidden = el.getAttribute('data-step') !== String(step); });
    Array.prototype.forEach.call(document.querySelectorAll('.steps li'), function (li) {
      var n = Number(li.getAttribute('data-for'));
      li.classList.toggle('current', n === step);
      li.classList.toggle('done', n < step);
    });
    backBtn.hidden = step !== 2;
    nextBtn.hidden = step !== 1;
    continueBtn.hidden = step !== 2;
    currentStep = step;
    updateSteps();
    reportSize();
  }

  // Which steps can be clicked: the first one from the second, the second one once the first is complete
  var currentStep = 1;
  function reachable(step) { return step !== currentStep && (step === 1 ? !backBtn.disabled : !nextBtn.disabled); }
  function updateSteps() {
    Array.prototype.forEach.call(document.querySelectorAll('.steps li'), function (li) {
      var ok = reachable(Number(li.getAttribute('data-for')));
      li.classList.toggle('reachable', ok);
      li.tabIndex = ok ? 0 : -1;
    });
  }
  document.querySelector('.steps').addEventListener('click', function (e) {
    var li = e.target.closest('li');
    if (li && reachable(Number(li.getAttribute('data-for')))) showStep(Number(li.getAttribute('data-for')));
  });
  document.querySelector('.steps').addEventListener('keydown', function (e) {
    var li = e.target.closest('li');
    if (li && (e.key === 'Enter' || e.key === ' ') && reachable(Number(li.getAttribute('data-for')))) { e.preventDefault(); showStep(Number(li.getAttribute('data-for'))); }
  });
  var aemBtn = document.getElementById('aem');
  var languageTags = document.getElementById('languages');
  var languagePicker = document.getElementById('add-language');
  // Codes of the languages chosen, in the order of LANGUAGE_NAMES
  var chosen = ['en'];
  var totalText = document.getElementById('total');
  var namingInput = document.getElementById('naming');
  var namingHelp = document.getElementById('naming-help');
  // Templates imported, one per format, in order: { name, url, status ('uploading', 'importing', 'reading', 'ready', 'error'),
  // progress, error, data (layers, document, preview), checked (ids of the layers picked), missingFonts, read (count of its
  // readings) }. The layer step shows one of them (active), with a tab per template. The layers of the same name and type are
  // linked: picking one picks them in the other templates, and they get the same texts and images.
  var templates = [];
  var active = 0;
  var MAX_TEMPLATES = ${MAX_TEMPLATES_UI};
  // Templates read together share the API calls of the report
  var batch = 'b' + Date.now().toString(36);
  function readyTemplates() { return templates.filter(function (t) { return t.status === 'ready'; }); }
  function allRead() { return templates.length > 0 && templates.every(function (t) { return t.status === 'ready'; }); }
  function checkedIds(t) { return Object.keys(t.checked || {}).filter(function (id) { return t.checked[id]; }).map(Number); }

  // Option per smart object layer, in the last column of the list, enabled when the layer is picked (by name: the layers of the
  // same name are linked across templates): the assistant writes a Firefly prompt for each image of the layers checked
  var aiChecked = {};
  document.getElementById('layers').classList.add('with-ai');
  function layerExtraCell(l, i) {
    return l.type === 'smart_object_layer'
      ? '<sp-checkbox size="s" class="ai-prompt" data-index="' + i + '" data-name="' + escapeHtml(l.name) + '" disabled'
        + ' title="The assistant writes a prompt to generate the image of each variant with Firefly">Generate Firefly prompt by variant</sp-checkbox>'
      : '<span></span>';
  }
  function imageLayerNames() {
    var names = [];
    templates.forEach(function (t) {
      if (t.data) (t.data.layers || []).forEach(function (l) {
        if (l.type === 'smart_object_layer' && t.checked && t.checked[l.id] && names.indexOf(l.name) < 0) names.push(l.name);
      });
    });
    return names;
  }
  function aiPromptLayers() { return imageLayerNames().filter(function (name) { return aiChecked[name]; }); }
  function renderAiPrompts() {
    Array.prototype.forEach.call(document.querySelectorAll('#layers .ai-prompt'), function (box) {
      var picked = document.getElementById('layer-' + box.getAttribute('data-index')).checked;
      box.disabled = !picked;
      box.checked = picked && Boolean(aiChecked[box.getAttribute('data-name')]);
    });
  }
  document.getElementById('layers').addEventListener('change', function (e) {
    var box = e.target.closest('.ai-prompt');
    if (!box) return;
    e.stopPropagation();
    aiChecked[box.getAttribute('data-name')] = box.checked;
  }, true);

  // Fonts added by the user ({ name, url }), given to the reading of the template and to the generation, and the fonts of the
  // template missing for the render (null until the template is read). fontsVersion counts the changes: an older reading is
  // ignored.
  var fonts = [];
  var missingFonts = null;
  var fontsUploading = 0;
  var fontsVersion = 0;
  var fontsHelp = document.getElementById('fonts-help');
  var fontInput = document.getElementById('font-files');

  // Alert icon (a triangle with an exclamation mark), in the color of the message
  var WARNING_ICON = '<svg viewBox="0 0 18 18" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M8.56 1.29.2 16.26a.5.5 0 0 0 .44.74h16.72a.5.5 0 0 0 .44-.74L9.44 1.29a.5.5 0 0 0-.88 0ZM10 14.75a.25.25 0 0 1-.25.25h-1.5a.25.25 0 0 1-.25-.25v-1.5a.25.25 0 0 1 .25-.25h1.5a.25.25 0 0 1 .25.25Zm0-3a.25.25 0 0 1-.25.25h-1.5a.25.25 0 0 1-.25-.25v-6a.25.25 0 0 1 .25-.25h1.5a.25.25 0 0 1 .25.25Z"/></svg>';

  // Message under the fonts: kind is 'warning' (with the icon), 'negative' (an error) or neutral
  function setFontsHelp(text, kind) {
    fontsHelp.className = 'fonts-help' + (kind ? ' ' + kind : '');
    fontsHelp.innerHTML = (kind === 'warning' ? WARNING_ICON : '') + '<span>' + escapeHtml(text) + '</span>';
    reportSize();
  }

  function fontUrls() { return fonts.length ? fonts.map(function (f) { return f.url; }) : undefined; }

  // Fonts missing in any template, null until all are read
  function allMissingFonts() {
    if (!templates.length || templates.some(function (t) { return t.status !== 'error' && !t.missingFonts; })) return null;
    var list = [];
    templates.forEach(function (t) { (t.missingFonts || []).forEach(function (f) { if (list.indexOf(f) < 0) list.push(f); }); });
    return list;
  }

  // Fonts the user added before (list-fonts): { id, fileName, postScriptName, fullName, family, url }, offered to add in one
  // click, and added by themselves when a template misses them (once per font name)
  var library = [];
  var autoTried = {};
  var autoAdded = [];
  var libraryEl = document.getElementById('font-library');
  function inUse(font) { return fonts.some(function (f) { return f.libraryId === font.id || f.url === font.url; }); }
  // Names of the fonts the templates need (missing without the fonts added), for the order of the fonts
  var neededFonts = {};
  function fontKey(name) { return String(name || '').toLowerCase().replace(/[\\s_-]/g, ''); }
  function isNeeded(font) { return [font.postScriptName, font.fullName].some(function (n) { return n && neededFonts[fontKey(n)]; }); }

  // The fonts, next to Add fonts: those of the library, and those added and not yet in it (local); the ones used for the
  // render checked (a click removes them from it), the others to add. The fonts the templates need first, then those used.
  function renderLibrary() {
    var local = fonts.filter(function (f) { return !library.some(function (font) { return f.libraryId === font.id || f.url === font.url; }); })
      .map(function (f) { return { id: 'local:' + fonts.indexOf(f), fileName: f.name, url: f.url, local: true }; });
    var items = library.concat(local).map(function (font, i) { return { font: font, used: font.local || inUse(font), needed: isNeeded(font), i: i }; });
    items.sort(function (a, b) { return (b.needed - a.needed) || (b.used - a.used) || (a.i - b.i); });
    libraryEl.hidden = !items.length;
    libraryEl.innerHTML = '<span class="library-label">Your fonts (' + items.length + '):</span>' + items.map(function (item) {
      var font = item.font;
      var title = (font.postScriptName || font.fileName) + (font.fullName && font.fullName !== font.postScriptName ? ' (' + font.fullName + ')' : '')
        + (item.needed ? ', needed by the template' : '');
      return '<span class="font-chip' + (item.used ? ' used' : '') + '"><button type="button" class="font-use" data-id="' + escapeHtml(font.id) + '" aria-pressed="' + item.used + '"'
        + ' title="' + (item.used ? 'Used for the render, click to remove it: ' : 'Add ') + escapeHtml(title) + '">' + (item.used ? '✓ ' : '+ ') + escapeHtml(font.fileName) + '</button>'
        + (font.local ? '' : '<button type="button" class="font-forget" data-id="' + escapeHtml(font.id) + '" aria-label="Remove ' + escapeHtml(font.fileName) + ' from your fonts" title="Remove from your fonts">&times;</button>')
        + '</span>';
    }).join('');
    reportSize();
  }
  // Fonts of the library that a template uses, given to its preview by the server: used for the other renders too (checked),
  // without rendering again
  function useFontsFromRead(list) {
    (list || []).forEach(function (font) {
      neededFonts[fontKey(font.postScriptName)] = true;
      var known = library.filter(function (f) { return f.id === font.id; })[0];
      if (known) known.url = font.url;
      if (fonts.some(function (f) { return f.libraryId === font.id; })) return;
      fonts.push({ name: font.fileName, url: font.url, libraryId: font.id });
      if (autoAdded.indexOf(font.fileName) < 0) autoAdded.push(font.fileName);
    });
    if (!list || !list.length) return;
    renderLibrary();
    // The templates already read without these fonts, which they miss, are read again with them
    templates.forEach(function (t) { if (t.status === 'ready' && !t.previewPending) rereadWithFontsUsed(t); });
  }
  // A template read without a font it misses, which is used for the render meanwhile (picked, or given by the reading of
  // another template): read again with it, once per font
  function rereadWithFontsUsed(t) {
    var missed = (t.missingFonts || []).filter(function (name) {
      var font = library.filter(function (f) { return [f.postScriptName, f.fullName].some(function (n) { return n && fontKey(n) === fontKey(name); }); })[0];
      var used = font && fonts.filter(function (f) { return f.libraryId === font.id || f.url === font.url; })[0];
      return used && (t.readFonts || []).indexOf(used.url) < 0 && !(t.rereadFor || {})[name];
    });
    if (!missed.length) return false;
    t.rereadFor = t.rereadFor || {};
    missed.forEach(function (name) { t.rereadFor[name] = true; });
    t.previewPending = true;
    if (t === templates[active] && currentStep === 2) showPreviewLoader(t.data && t.data.document);
    readTemplateOf(t);
    return true;
  }
  function useLibraryFont(font) {
    if (inUse(font)) return;
    fonts.push({ name: font.fileName, url: font.url, libraryId: font.id });
    renderLibrary();
  }
  libraryEl.addEventListener('click', function (e) {
    var button = e.target.closest('button');
    if (!button) return;
    var id = button.getAttribute('data-id');
    // A font added and not yet in the library: removed from the render
    if (id.indexOf('local:') === 0) {
      fonts.splice(Number(id.slice(6)), 1);
      renderLibrary();
      renderFonts();
      checkFonts();
      return;
    }
    var font = library.filter(function (f) { return f.id === id; })[0];
    if (!font) return;
    if (button.classList.contains('font-use')) {
      if (inUse(font)) fonts = fonts.filter(function (f) { return f.libraryId !== font.id && f.url !== font.url; });
      else useLibraryFont(font);
      renderLibrary();
      renderFonts();
      checkFonts();
    } else {
      // Removed from the library and from the render at once
      var used = inUse(font);
      library = library.filter(function (f) { return f.id !== id; });
      fonts = fonts.filter(function (f) { return f.libraryId !== font.id && f.url !== font.url; });
      renderLibrary();
      if (used) { renderFonts(); checkFonts(); }
      callTool('remove-font', { id: id }).catch(function () {});
    }
  });
  callTool('list-fonts').then(function (result) {
    library = result.fonts || [];
    renderLibrary();
    renderFonts();
  }, function () {});

  // The fonts missing in the templates that the library has (same PostScript or full name) are added at once, and the
  // templates rendered again with them
  function addMissingFromLibrary() {
    if (!missingFonts || !missingFonts.length || fontsUploading) return false;
    var key = fontKey;
    var added = [];
    missingFonts.forEach(function (name) {
      if (autoTried[name]) return;
      autoTried[name] = true;
      var font = library.filter(function (f) { return [f.postScriptName, f.fullName].some(function (n) { return n && key(n) === key(name); }); })[0];
      if (font && !inUse(font)) { useLibraryFont(font); added.push(font.fileName); autoAdded.push(font.fileName); }
    });
    if (!added.length) return false;
    checkFonts();
    setFontsHelp('Added from your fonts: ' + added.join(', ') + '. Rendering the preview again with them...');
    return true;
  }

  function renderFonts() {
    missingFonts = allMissingFonts();
    (missingFonts || []).forEach(function (name) { neededFonts[fontKey(name)] = true; });
    var added = addMissingFromLibrary();
    renderLibrary();
    if (added) return;
    var missing = missingFonts && missingFonts.length;
    setFontsHelp(fontsUploading ? 'Uploading ' + fontsUploading + ' font file(s)...'
      : missing ? 'Fonts of the template not available: ' + missingFonts.join(', ') + '. Add their files, otherwise they are '
        + 'replaced by a default font.'
      : missingFonts ? 'All the fonts of the template are available'
        + (autoAdded.length ? ' (' + autoAdded.join(', ') + ' added from your fonts)' : '') + '. The preview is rendered again when a font is added or removed.'
      : 'Optional: the .otf or .ttf files of fonts of the template that Photoshop does not have. The preview is rendered again with them.',
      missing && !fontsUploading ? 'warning' : '');
  }

  // The fonts changed after the templates were read: each is rendered again with them, for its preview and the fonts missing
  function checkFonts() {
    var version = ++fontsVersion;
    var list = readyTemplates();
    if (!list.length) return;
    list.forEach(function (t) { t.missingFonts = null; });
    setFontsHelp('Rendering the preview' + (list.length > 1 ? 's' : '') + ' again with the fonts...');
    if (templates[active] && templates[active].status === 'ready' && document.getElementById('preview-img').getAttribute('src')) showPreviewLoader();
    reportSize();
    list.forEach(function (t) {
      var read = t.read;
      var shownAgain = function () {
        if (t !== templates[active]) return;
        // Without a new preview, the previous one is shown again
        document.getElementById('preview-loader').hidden = true;
        document.getElementById('stage').hidden = false;
      };
      t.readFonts = (fontUrls() || []).slice();
      callTool('read-psd-template', { url: t.url, fonts: fontUrls(), batch: batch })
        .then(function (started) { return waitForTask(started.taskId); })
        .then(function (result) {
          if (version !== fontsVersion || read !== t.read) return;
          if (result.previewUrl) t.data.previewUrl = result.previewUrl;
          t.missingFonts = result.missingFonts || [];
          if (rereadWithFontsUsed(t)) return;
          if (t === templates[active] && result.previewUrl) showLatePreview(result.previewUrl, result.document || {});
          shownAgain();
          renderFonts();
        })
        .catch(function (error) {
          if (version !== fontsVersion) return;
          t.missingFonts = t.missingFonts || [];
          shownAgain();
          setFontsHelp('Preview not rendered again: ' + ((error && error.message) || String(error)), 'negative');
          reportSize();
        });
    });
  }

  function addFonts(files) {
    var list = Array.prototype.filter.call(files || [], function (file) { return /\\.(otf|ttf)$/i.test(file.name); });
    if (!list.length) { setFontsHelp('Choose .otf or .ttf font files.', 'negative'); return; }
    list = list.slice(0, Math.max(0, 20 - fonts.length));
    fontsUploading += list.length;
    renderFonts();
    updateButton();
    Promise.all(list.map(function (file) {
      return uploadOne(file, function () {}).then(function (uploaded) {
        var font = { name: uploaded.name, url: uploaded.url };
        fonts.push(font);
        // Kept in the library of the user (in place of a font of the same name), to be offered again later
        callTool('save-font', { url: uploaded.url }).then(function (result) {
          font.libraryId = result.font.id;
          library = [result.font].concat(library.filter(function (f) { return f.id !== result.font.id && f.postScriptName !== result.font.postScriptName; }));
          renderLibrary();
        }, function () {});
      }, function () { return file.name; });
    })).then(function (failed) {
      fontsUploading -= list.length;
      failed = failed.filter(Boolean);
      updateButton();
      renderFonts();
      if (failed.length) setFontsHelp('Not uploaded: ' + failed.join(', '), 'negative');
      if (failed.length < list.length) checkFonts();
    });
  }

  document.getElementById('add-fonts').addEventListener('click', function () { fontInput.value = ''; fontInput.click(); });
  fontInput.addEventListener('change', function () { addFonts(fontInput.files); });
  renderFonts();

  // File name of a part of the name: the characters that files do not allow replaced, spaces as dashes
  function safeName(text) {
    return String(text).trim().replace(/\\s+/g, '-').replace(/[\\\\/:*?"<>|]+/g, '_');
  }

  // Names of the templates in the file names: their file names without extension, made unique
  function templateNames() {
    var used = {};
    return templates.map(function (t) {
      var base = safeName(t.name.replace(/\\.psd$/i, '')) || 'template', name = base;
      for (var n = 2; used[name]; n++) name = base + '-' + n;
      used[name] = true;
      return name;
    });
  }

  // Model of the file names, with {date} replaced, and {template} with a single template: {variant}, {language} (and
  // {template} with several templates) are replaced by create-variant
  function fileNamePattern() {
    var now = new Date();
    var date = now.getFullYear() + '-' + ('0' + (now.getMonth() + 1)).slice(-2) + '-' + ('0' + now.getDate()).slice(-2);
    var pattern = namingInput.value.trim().split('{date}').join(date);
    return templates.length > 1 ? pattern : pattern.split('{template}').join(templates.length ? templateNames()[0] : 'template');
  }

  // The model is valid when it names each variant apart: with {variant}, with {language} for several languages, and with
  // {template} for several templates
  function namingError() {
    var value = namingInput.value;
    if (value.indexOf('{variant}') < 0) return 'Add {variant}, so that each variant has its own file.';
    if (languages().length > 1 && value.indexOf('{language}') < 0) return 'Add {language}, so that each language has its own file.';
    if (templates.length > 1 && value.indexOf('{template}') < 0) return 'Add {template}, so that each format has its own file.';
    return '';
  }

  function updateNaming() {
    var error = namingError();
    namingHelp.textContent = error || '{template}, {variant}, {language} and {date}, e.g. '
      + fileNamePattern().split('{template}').join(templateNames()[0] || 'template').split('{variant}').join('Winter-sale')
        .split('{language}').join(languages()[0] || 'en') + '.jpg';
    namingHelp.variant = error ? 'negative' : 'neutral';
  }

  function count() {
    var n = Math.round(Number(countInput.value));
    return n >= 1 && n <= ${MAX_VARIANTS_UI} ? n : null;
  }

  function languages() {
    return Object.keys(LANGUAGE_NAMES).filter(function (code) { return chosen.indexOf(code) >= 0; });
  }

  // The tags of the languages chosen, and the other languages in the picker
  function renderLanguages() {
    languageTags.innerHTML = languages().map(function (code) {
      return '<sp-tag deletable data-code="' + code + '">' + escapeHtml(LANGUAGE_NAMES[code]) + '</sp-tag>';
    }).join('');
    languagePicker.innerHTML = Object.keys(LANGUAGE_NAMES).filter(function (code) { return chosen.indexOf(code) < 0; }).map(function (code) {
      return '<sp-menu-item value="' + code + '">' + escapeHtml(LANGUAGE_NAMES[code]) + '</sp-menu-item>';
    }).join('');
    languagePicker.disabled = chosen.length === Object.keys(LANGUAGE_NAMES).length;
    updateButton();
    reportSize();
  }

  // Each variant is created in each language: the total is at most ${MAX_VARIANTS_UI}, and each is rendered in each template
  // (at most ${MAX_RENDERS_UI} files)
  function total() { return (count() || 0) * languages().length; }
  function files() { return total() * Math.max(1, templates.length); }
  function tooMany() { return total() > ${MAX_VARIANTS_UI} || files() > ${MAX_RENDERS_UI}; }

  function updateButton() {
    var n = total();
    var formats = templates.length > 1 ? ' in ' + templates.length + ' formats, ' + files() + ' files' : '';
    totalText.textContent = !languages().length ? 'Choose at least one language.'
      : n > ${MAX_VARIANTS_UI} ? n + ' variants in total: at most ${MAX_VARIANTS_UI}.'
        : files() > ${MAX_RENDERS_UI} ? n + ' variants' + formats + ': at most ${MAX_RENDERS_UI} files.'
          : n + ' variant' + (n > 1 ? 's' : '') + ' in total' + formats + '.';
    totalText.variant = tooMany() || !languages().length ? 'negative' : 'neutral';
    updateNaming();
    nextBtn.disabled = !templates.length || templates.some(function (t) { return t.status === 'uploading' || t.status === 'importing' || t.status === 'error'; })
      || !count() || !n || tooMany() || !!namingError() || fontsUploading > 0;
    continueBtn.disabled = nextBtn.disabled || !allRead() || !layerCount;
    if (typeof updateSteps === 'function') updateSteps();
    updateEstimate();
  }

  // Estimate of the generation, shown with the number of variants: one render per variant, and when the template has image
  // layers, for each image if they vary (the languages of a variant share its images) a crop suggestion in the grid and a crop.
  // Its time is that of the jobs run at once by the generation, from the average times of the calls (get-generation-estimate).
  var estimate = null;
  callTool('get-generation-estimate').then(function (result) { estimate = result; updateEstimate(); }, function () {});
  function duration(ms) {
    var s = Math.max(1, Math.round(ms / 1000));
    return 'about ' + (s < 60 ? s + ' s' : Math.round(s / 60) + ' min');
  }
  function plural(n, word) { return n + ' ' + word + (n > 1 ? 's' : ''); }
  function updateEstimate() {
    var estimateText = document.getElementById('estimate');
    var n = files();
    estimateText.hidden = !estimate || !n || tooMany();
    if (estimateText.hidden) return reportSize();
    var avg = function (operation) { return estimate.averages[operation].averageMs; };
    var waitMs = function (images) {
      var crop = images ? avg('Image crop (Photoshop)') : 0;
      return Math.max(avg('Variant render') + crop, (n * avg('Variant render') + images * avg('Image crop (Photoshop)')) / estimate.parallelJobs);
    };
    // Image layers of the same name share their image, framed once per ratio of their frames
    var imageLinks = {};
    readyTemplates().forEach(function (t) {
      (t.data.layers || []).forEach(function (l) {
        if (l.type !== 'smart_object_layer') return;
        var ratios = imageLinks[l.name] = imageLinks[l.name] || [];
        var ratio = l.frame && l.frame.width && l.frame.height ? Math.round(l.frame.width / l.frame.height * 100) : 0;
        if (ratios.indexOf(ratio) < 0) ratios.push(ratio);
      });
    });
    var imageLayers = Object.keys(imageLinks).length;
    var images = (count() || 0) * Object.keys(imageLinks).reduce(function (total, name) { return total + imageLinks[name].length; }, 0);
    var sources = Object.keys(estimate.averages).map(function (operation) { return estimate.averages[operation].source; });
    var basis = sources.indexOf('default') >= 0 ? 'typical times' : sources.indexOf('all') >= 0 ? 'the average times of the service' : 'your average times';
    estimateText.textContent = 'Estimate: ' + plural(n, 'Photoshop render') + ', ' + duration(waitMs(0))
      + (images ? '; if ' + (imageLayers > 1 ? 'the ' + imageLayers + ' image layers of the template' + (templates.length > 1 ? 's' : '') + ' vary'
        : 'the image layer of the template' + (templates.length > 1 ? 's' : '') + ' varies') + ', ' + plural(images, 'image crop')
        + ' and ' + plural(images, 'crop suggestion') + ' more, ' + duration(waitMs(images)) + ' in all' : '')
      + ' (from ' + basis + ').';
    reportSize();
  }

  onToolInput(function (args) {
    if (args.variantCount) countInput.value = args.variantCount;
    if (args.languages && args.languages.length) {
      chosen = args.languages.filter(function (code) { return LANGUAGE_NAMES[code]; });
      renderLanguages();
    }
    updateButton();
  });

  // Each template file is transferred (uploaded, or imported from AEM), then read at once: its layers, then its preview
  function addTemplate(name, status, transfer) {
    if (templates.length >= MAX_TEMPLATES) {
      setStatus('At most ' + MAX_TEMPLATES + ' templates: ' + name + ' not added.', true);
      return;
    }
    var t = { name: name, status: status, progress: 0, checked: {}, read: 0 };
    templates.push(t);
    setStatus('');
    renderTemplates();
    transfer(t)
      .then(function (file) {
        if (templates.indexOf(t) < 0) return;
        t.url = file.url;
        t.name = file.name || t.name;
        readTemplateOf(t);
      })
      .catch(function (error) {
        if (templates.indexOf(t) < 0) return;
        t.status = 'error';
        t.error = (error && error.message) || String(error);
        renderTemplates();
      });
  }

  // Reads a template (read-psd-template): its layers as soon as they are known, then its preview and the fonts missing
  function readTemplateOf(t) {
    var read = ++t.read;
    var isCurrent = function () { return templates.indexOf(t) >= 0 && read === t.read; };
    t.status = 'reading';
    t.missingFonts = null;
    t.readFonts = (fontUrls() || []).slice();
    renderTemplates();
    callTool('read-psd-template', { url: t.url, fonts: fontUrls(), batch: batch })
      .then(function (started) {
        return waitForTask(started.taskId, function (partial) {
          if (!isCurrent() || !partial.layers || (t.data && t.data.layers)) return;
          t.data = partial;
          t.status = 'ready';
          t.previewPending = true;
          templateRead(t, false);
        });
      })
      .then(function (result) {
        if (!isCurrent()) return;
        var hadLayers = Boolean(t.data && t.data.layers);
        // The layers already shown (and picked) stay the same objects
        if (hadLayers) result.layers = t.data.layers;
        t.data = result;
        t.status = 'ready';
        t.previewPending = false;
        t.missingFonts = result.missingFonts || [];
        (result.libraryFonts || []).forEach(function (f) { t.readFonts.push(f.url); });
        useFontsFromRead(result.libraryFonts);
        if (rereadWithFontsUsed(t)) return;
        templateRead(t, hadLayers);
      })
      .catch(function (error) {
        if (!isCurrent()) return;
        t.status = 'error';
        t.error = (error && error.message) || String(error);
        renderTemplates();
      });
  }

  // A template was read (its layers, or then its preview): its layers are linked to those picked in the other templates, and
  // it is shown when it is the one of the layer step
  function templateRead(t, previewOnly) {
    if (!previewOnly) linkTemplate(t);
    renderTemplates();
    renderFonts();
    if (t !== templates[active]) return;
    if (previewOnly && t.data.previewUrl) showLatePreview(t.data.previewUrl, t.data.document || {});
    else showActive();
    if (!t.data.previewUrl && t.data.previewError) setStatus('Preview not available: ' + t.data.previewError);
  }

  // Size of a template, once read
  function sizeOf(t) {
    var doc = t.data && t.data.document;
    return doc && doc.width && doc.height ? doc.width + ' x ' + doc.height : '';
  }

  var STATE_LABELS = { uploading: 'Uploading', importing: 'Importing from AEM', reading: 'Reading the layers' };

  // The templates of step 1, one row each, and the drop zone, which takes more
  function renderTemplates() {
    templateList.hidden = !templates.length;
    templateList.innerHTML = templates.map(function (t, i) {
      var state = t.status === 'error' ? t.error : t.status === 'ready' ? sizeOf(t) : STATE_LABELS[t.status] + '...';
      return '<div class="template-row"><span class="template-name" title="' + escapeHtml(t.name) + '">' + escapeHtml(t.name) + '</span>'
        + '<span class="template-state' + (t.status === 'error' ? ' negative' : '') + '">' + escapeHtml(state || '') + '</span>'
        + '<button type="button" class="template-remove" data-index="' + i + '" aria-label="Remove ' + escapeHtml(t.name) + '" title="Remove">&times;</button>'
        + (t.status === 'uploading' ? '<sp-progress-bar size="s" label="Uploading" progress="' + t.progress + '"></sp-progress-bar>'
          : t.status === 'importing' || t.status === 'reading' ? '<sp-progress-bar size="s" label="' + STATE_LABELS[t.status] + '" indeterminate></sp-progress-bar>' : '')
        + '</div>';
    }).join('');
    messageHeading.textContent = templates.length ? templates.length + ' template' + (templates.length > 1 ? 's' : '') : 'Drop your PSD templates';
    messageDescription.textContent = templates.length
      ? (templates.length < MAX_TEMPLATES ? 'Drop or choose more files to add formats' : 'At most ' + MAX_TEMPLATES + ' templates')
      : 'Layered .psd files, one per format';
    if (active >= templates.length) active = Math.max(0, templates.length - 1);
    renderTabs();
    updateButton();
    reportSize();
  }

  templateList.addEventListener('click', function (e) {
    var button = e.target.closest('.template-remove');
    if (!button) return;
    var index = Number(button.getAttribute('data-index'));
    var removed = templates.splice(index, 1)[0];
    removed.read++;
    if (active > index || active >= templates.length) active = Math.max(0, active - 1);
    renderTemplates();
    renderFonts();
    if (currentStep === 2) showActive();
  });

  function upload(fileList) {
    var list = Array.prototype.filter.call(fileList || [], function (file) { return /\\.psd$/i.test(file.name) || file.type === 'image/vnd.adobe.photoshop'; });
    if (!list.length) return setStatus('Choose layered .psd files.', true);
    list.forEach(function (file) {
      addTemplate(file.name, 'uploading', function (t) {
        return uploadOne(file, function (bytes) {
          t.progress = Math.round(bytes / (file.size || 1) * 100);
          var bar = templateList.querySelectorAll('.template-row')[templates.indexOf(t)];
          bar = bar && bar.querySelector('sp-progress-bar');
          if (bar) bar.progress = t.progress;
        });
      });
    });
  }

  // The PSDs picked in AEM are copied to storage by the server, like uploads.
  aemBtn.addEventListener('click', function () {
    pickAemAssets(true, 'the PSD templates')
      .then(function (assets) {
        assets.forEach(function (asset) {
          if (!/\.psd$/i.test(asset['repo:name'])) return setStatus(asset['repo:name'] + ' is not a PSD file.', true);
          addTemplate(asset['repo:name'], 'importing', function () { return importAemAsset(asset); });
        });
      })
      .catch(function (error) { setStatus((error && error.message) || String(error), true); });
  });
  loadAemConfig().then(function (config) { aemBtn.hidden = !config; reportSize(); });

  // Tabs of the layer step, one per template, with the number of layers picked in it
  function renderTabs() {
    templateTabs.hidden = templates.length < 2;
    templateTabs.innerHTML = templates.length < 2 ? '' : templates.map(function (t, i) {
      var picked = checkedIds(t).length;
      return '<button type="button" role="tab" class="template-tab' + (i === active ? ' active' : '') + '" data-index="' + i + '" aria-selected="' + (i === active) + '">'
        + escapeHtml(t.name.replace(/\\.psd$/i, '')) + (sizeOf(t) ? ' · ' + sizeOf(t) : '') + (picked ? ' (' + picked + ')' : '') + '</button>';
    }).join('');
    renderLinked();
  }

  templateTabs.addEventListener('click', function (e) {
    var tab = e.target.closest('.template-tab');
    if (!tab) return;
    active = Number(tab.getAttribute('data-index'));
    showActive();
  });

  // Shows the template of the layer step, with the layers picked in it
  function showActive() {
    var t = templates[active];
    switching = true;
    clearTemplate();
    if (t && t.data && t.data.layers) {
      render(t.data);
      layers.forEach(function (l, i) { document.getElementById('layer-' + i).checked = Boolean(t.checked[l.id]); });
      if (layers.length) updateSelection();
      if (!t.data.previewUrl && t.previewPending) showPreviewLoader(t.data.document);
    } else if (t) {
      setStatus(t.status === 'error' ? t.error : 'Reading the template...', t.status === 'error', t.status !== 'error');
    }
    switching = false;
    renderTabs();
    updateButton();
    reportSize();
  }

  // Key of the layers linked between the templates: the same name and type
  function linkKey(l) { return l.type + '|' + l.name; }

  // The layers picked in the template shown, kept with it; a layer picked or left links the layers of the same name and type
  // in the other templates
  function syncSelection() {
    var t = templates[active];
    if (!t || !t.data || t.data.layers !== layers) return;
    var changed = {};
    layers.forEach(function (l, i) {
      var box = document.getElementById('layer-' + i);
      if (!box) return;
      if (Boolean(t.checked[l.id]) !== box.checked) changed[linkKey(l)] = box.checked;
      t.checked[l.id] = box.checked;
    });
    templates.forEach(function (other) {
      if (other === t || !other.data || !other.data.layers) return;
      other.data.layers.forEach(function (l) { if (changed[linkKey(l)] !== undefined) other.checked[l.id] = changed[linkKey(l)]; });
    });
  }

  // A template read after layers were picked in others gets the layers of the same name and type picked
  function linkTemplate(t) {
    var picked = {};
    templates.forEach(function (other) {
      if (other === t || !other.data || !other.data.layers) return;
      other.data.layers.forEach(function (l) { if (other.checked[l.id]) picked[linkKey(l)] = true; });
    });
    (t.data.layers || []).forEach(function (l) { if (picked[linkKey(l)]) t.checked[l.id] = true; });
  }

  // Layers picked in all the templates, those of the same name and type linked: [{ id, name, type, members: [{ t, layer }] }]
  function linkedLayers() {
    var links = [];
    templates.forEach(function (t, ti) {
      ((t.data && t.data.layers) || []).forEach(function (l) {
        if (!t.checked[l.id]) return;
        var link = links.filter(function (k) { return k.key === linkKey(l); })[0];
        if (!link) links.push(link = { id: links.length + 1, key: linkKey(l), name: l.name, type: l.type, members: [] });
        link.members.push({ t: ti, layer: l });
      });
    });
    return links;
  }

  // With several templates: the layers picked, and in which templates each is
  function renderLinked() {
    if (templates.length < 2) { linkedEl.hidden = true; return; }
    var links = linkedLayers();
    linkedEl.hidden = !links.length;
    linkedEl.textContent = 'Layers of the same name and type are linked: they get the same text or image in every template. Picked: '
      + links.map(function (k) { return k.name + ' (' + k.members.length + '/' + templates.length + ')'; }).join(', ') + '.';
  }

  showQuota(document.getElementById('quota'));

  countInput.addEventListener('input', updateButton);
  namingInput.addEventListener('input', updateButton);
  languagePicker.addEventListener('change', function () {
    var code = languagePicker.value;
    if (code && chosen.indexOf(code) < 0) chosen.push(code);
    // The picker offers to add another one
    languagePicker.value = '';
    renderLanguages();
  });
  languageTags.addEventListener('delete', function (e) {
    var code = e.target.getAttribute('data-code');
    chosen = chosen.filter(function (c) { return c !== code; });
    renderLanguages();
  });
  renderLanguages();
  document.getElementById('browse').addEventListener('click', function () { input.value = ''; input.click(); });
  input.addEventListener('change', function () { upload(input.files); });
  drop.addEventListener('sp-dropzone-should-accept', function (e) { e.detail.dataTransfer.dropEffect = 'copy'; });
  drop.addEventListener('sp-dropzone-drop', function (e) { upload(e.detail.dataTransfer.files); });

  nextBtn.addEventListener('click', function () { showStep(2); showActive(); });
  backBtn.addEventListener('click', function () { showStep(1); });

  continueBtn.addEventListener('click', function () {
    var n = count();
    var codes = languages();
    var names = codes.map(function (code) { return LANGUAGE_NAMES[code]; });
    continueBtn.disabled = true;
    backBtn.disabled = true;
    updateSteps();
    var intro = 'Variant creation started. Number of variants per language: ' + n + '. Languages: '
      + codes.map(function (code, i) { return names[i] + ' (' + code + ')'; }).join(', ') + '. Total: ' + n * codes.length
      + ' variants, each of the ' + n + ' variants in each language. ';
    var fontsText = fonts.length ? ' Fonts added by the user: pass fonts ' + JSON.stringify(fontUrls()) + ' to every create-variant call.' : '';
    if (imageLayerNames().length) {
      var promptLayers = aiPromptLayers();
      fontsText += promptLayers.length
        ? ' Images: the user wants the images of the smart object layers ' + promptLayers.map(function (n) { return '"' + n + '"'; }).join(', ')
          + ' generated with Firefly from prompts you write. In step 4 (the image grid), pass prompts for these layers only: one per '
          + 'variant and layer, in English, written from the brief and the texts of the variant (what the image shows, setting, mood, '
          + 'light, a composition suited to the frame and leaving room for the texts, no text or logo in the image). No prompts for the '
          + 'other layers (the user adds their images).'
        : ' Images: do not write prompts for Firefly (the user adds the images).';
    }
    var context, picked, title;
    if (templates.length === 1) {
      var t = templates[0];
      var chosen = t.data.layers.filter(function (l) { return t.checked[l.id]; }).map(function (l) {
        var layer = {};
        Object.keys(l).forEach(function (key) { if (key !== 'area') layer[key] = l[key]; });
        return layer;
      });
      title = t.name;
      picked = chosen.map(function (l) { return l.name; }).join(', ');
      context = intro + 'PSD template: ' + t.name + ', URL (valid 24 hours): ' + t.url + '. File names: pass fileNamePattern "' + fileNamePattern()
        + '" to every create-variant call. Layers selected by the user in the template (with their original texts and frames; '
        + 'do not call get-psd-manifest): ' + JSON.stringify(chosen) + '. Next step: step 3 (texts) if text layers were '
        + 'selected, otherwise step 4 (images).' + fontsText;
    } else {
      var tNames = templateNames();
      var links = linkedLayers();
      var forModel = links.map(function (k) {
        var first = k.members[0].layer;
        var layer = { id: k.id, name: k.name, type: k.type, templates: k.members.map(function (m) { return tNames[m.t]; }) };
        if (k.type === 'text_layer') {
          layer.text = first.text;
          var texts = {};
          k.members.forEach(function (m) { if (m.layer.text !== first.text) texts[tNames[m.t]] = m.layer.text; });
          if (Object.keys(texts).length) {
            layer.textsByTemplate = {};
            k.members.forEach(function (m) { layer.textsByTemplate[tNames[m.t]] = m.layer.text; });
          }
        } else {
          var frames = [];
          k.members.forEach(function (m) {
            var f = m.layer.frame;
            if (f && f.width && f.height && !frames.some(function (g) { return Math.abs(g.width / g.height - f.width / f.height) < 0.01; })) frames.push({ width: f.width, height: f.height });
          });
          if (frames[0]) { layer.frame = frames[0]; layer.frames = frames; }
        }
        return layer;
      });
      var templatesJson = templates.map(function (t, ti) {
        var linked = [];
        links.forEach(function (k) { k.members.forEach(function (m) { if (m.t === ti) linked.push({ id: k.id, layerId: m.layer.id }); }); });
        return { name: tNames[ti], url: t.url, layers: linked };
      });
      var images = forModel.filter(function (l) { return l.type === 'smart_object_layer'; });
      title = tNames.join(', ');
      picked = forModel.map(function (l) { return l.name; }).join(', ');
      context = intro + templates.length + ' PSD templates, one per format, each variant being created in each of them: '
        + templates.map(function (t, ti) { return tNames[ti] + ' (' + sizeOf(t) + ')'; }).join(', ') + '. '
        + 'For every create-variant call, pass templates (instead of templateUrl) exactly as this JSON (URLs valid 24 hours): '
        + JSON.stringify(templatesJson) + ' and fileNamePattern "' + fileNamePattern() + '". '
        + 'Layers selected by the user, those of the same name and type in several templates linked as one (do not call get-psd-manifest; '
        + 'use these ids everywhere: in edit-variant-texts, upload-variant-images and the edits of create-variant): ' + JSON.stringify(forModel) + '. '
        + 'Each text goes to its layer in every template listed for it: where the templates break its original text differently '
        + '(textsByTemplate), write the text without line breaks, unless the user asks for them, so that each template spreads it over its own lines. '
        + (images.length ? 'For the image grid, pass these layers as is (with their frames: the user frames each image for each ratio): '
          + JSON.stringify(images.map(function (l) { return { id: l.id, name: l.name, width: l.frame && l.frame.width, height: l.frame && l.frame.height, frames: l.frames }; }))
          + ', and pass the crops of each image (crops) to create-variant as given by the grid. ' : '')
        + 'To change a variant in some templates only (e.g. a text too long in one format), pass the names of these templates in its templates. '
        + 'Next step: step 3 (texts) if text layers were selected, otherwise step 4 (images).' + fontsText;
    }
    sendToModel(context, 'I want ' + n + ' variant(s) of ' + title + ' in ' + names.join(', ') + ', changing ' + picked + ', continue.', 'Template' + (templates.length > 1 ? 's' : '') + ' sent.')
      .catch(function (error) {
        backBtn.disabled = false;
        updateButton();
        updateSteps();
        setStatus((error && error.message) || String(error), true);
      });
  });
`)
}

// Grid of the images of the variants (one per variant and smart object layer, from the computer, AEM or Firefly, cropped to
// its frame), shared by the images and texts views, in its own scope: imagesPicker.init(args), imagesPicker.result() (the
// context for the model) and imagesPicker.onChange(handler(done, total)).
const IMAGES_CSS = `
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
  /* Prompt of an image generated by Firefly, in its slot */
  .prompt { width: 100%; min-height: 64px; font: inherit; font-size: var(--spectrum-font-size-75); padding: var(--spectrum-spacing-75) var(--spectrum-spacing-100);
    color: var(--spectrum-neutral-content-color-default); background: var(--spectrum-gray-50); border: 1px solid var(--spectrum-gray-400);
    border-radius: var(--spectrum-corner-radius-100); resize: vertical; field-sizing: content; max-height: 220px; line-height: 1.4; }
  .prompt:hover { border-color: var(--spectrum-gray-500); }
  .prompt:focus { outline: none; border-color: var(--spectrum-accent-background-color-default); }
  .slot-buttons { display: flex; flex-wrap: wrap; gap: var(--spectrum-spacing-100); justify-content: center; }
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
  .frame-label { width: 100%; font-size: var(--spectrum-font-size-75); text-align: left; }
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
`

const IMAGES_HTML = `<div class="library">
  <div class="library-header">
    <sp-button size="s" variant="secondary" treatment="outline" id="browse">Add images from your computer</sp-button>
    <sp-button size="s" variant="secondary" treatment="outline" id="aem" hidden>${ADOBE_ICON}Add images from AEM</sp-button>
    <span class="subtle" id="library-hint"></span>
  </div>
  <div class="library-items" id="library-items" hidden></div>
</div>
<div class="grid" id="grid"></div>
<input type="file" id="file" accept="image/*" multiple>
`

const IMAGES_SCRIPT = `
  var imagesPicker = (function () {
  // onChange(done, total) is called when the images of the slots change
  var onChange = null;
  var CROP_MAX_HEIGHT = 160;
  var CROP_MULTI_HEIGHT = 110;
  var MAX_ZOOM = 4;
  var grid = document.getElementById('grid');
  var input = document.getElementById('file');
  var variants = [];
  var layers = [];
  var slots = [];
  var BUSY_LABELS = { uploading: 'Uploading', framing: 'Framing the subject', generating: 'Generating with Firefly' };
  // Prompts of the images to generate with Firefly, by slot: proposed by the model, edited by the user
  var prompts = {};
  // Slots for which the assistant wrote a prompt (generated by the main button); the others open an empty prompt
  var prompted = {};
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
  // Frames of the layer of a slot: one, or one per ratio when the layer is in templates of different formats (frames), each
  // with its own crop of the image (slot.crops, in the order of the frames)
  function framesOf(index) {
    var l = layerOf(index);
    if (l.frames && l.frames.length > 1) return l.frames;
    return l.width && l.height ? [{ width: l.width, height: l.height }] : [];
  }
  function ratioOf(index, k) { var f = framesOf(index)[k || 0]; return f ? f.width / f.height : null; }

  // Largest crop at the frame ratio that fits in the image (zoom 1).
  function maxCropSize(slot, ratio) {
    var width = Math.min(slot.image.width, slot.image.height * ratio);
    return { width: width, height: width / ratio };
  }

  function clampCrop(slot, k, ratio) {
    var c = slot.crops[k];
    var width = c.right - c.left;
    var height = width / ratio;
    var left = Math.min(Math.max(c.left, 0), slot.image.width - width);
    var top = Math.min(Math.max(c.top, 0), slot.image.height - height);
    slot.crops[k] = { left: left, top: top, right: left + width, bottom: top + height };
  }

  // Crops of an image suggested for each frame of a slot, framed on its subject: the size of the image and the crops
  function suggestCrops(index, url) {
    return Promise.all(framesOf(index).map(function (f) { return suggestCrop(url, f.width / f.height); }))
      .then(function (list) { return { image: list[0].image, crops: list.map(function (x) { return x.crop; }) }; });
  }

  function cellHtml(slot, index) {
    var ratio = ratioOf(index);
    var layer = layerOf(index);
    // Grouped by variant with several layers, so the card only names the layer
    var label = layers.length > 1 ? layer.name : variants[Math.floor(index / layers.length)];
    var html = '<sp-dropzone data-index="' + index + '">'
      + '<div class="slot-label">' + escapeHtml(label) + '</div>';
    if (slot.status === 'done') {
      var frames = framesOf(index);
      if (ratio && slot.crops && slot.crops.length === frames.length) {
        // The whole image is shown, with the crop frame on top: once per frame ratio (several templates), smaller
        var imageRatio = slot.image.width / slot.image.height;
        var height = frames.length > 1 ? CROP_MULTI_HEIGHT : CROP_MAX_HEIGHT;
        frames.forEach(function (f, k) {
          var zoom = maxCropSize(slot, f.width / f.height).width / (slot.crops[k].right - slot.crops[k].left);
          html += (frames.length > 1 ? '<div class="subtle frame-label">Frame ' + f.width + ' x ' + f.height + '</div>' : '')
            + '<div class="crop" data-index="' + index + '" data-frame="' + k + '" style="width:' + Math.round(height * imageRatio) + 'px;aspect-ratio:' + imageRatio + '">'
            + '<img src="' + escapeHtml(slot.url) + '" alt="' + escapeHtml(slot.name) + '"><div class="shade"></div><div class="shade"></div><div class="shade"></div><div class="shade"></div><div class="frame"></div></div>'
            + '<label class="zoom">Zoom <input type="range" data-index="' + index + '" data-frame="' + k + '" min="1" max="' + MAX_ZOOM + '" step="0.01" value="' + zoom + '"></label>';
        });
      } else {
        html += '<img class="thumb" src="' + escapeHtml(slot.url) + '" alt="' + escapeHtml(slot.name) + '">';
      }
      html += '<div class="subtle file-name">' + escapeHtml(slot.name) + '</div>'
        + '<sp-button size="s" variant="secondary" treatment="outline" data-action="remove" data-index="' + index + '">Remove</sp-button>';
    } else if (BUSY_LABELS[slot.status]) {
      html += '<div class="subtle file-name">' + escapeHtml(slot.name) + '</div>'
        + '<sp-progress-bar size="s" label="' + BUSY_LABELS[slot.status] + '"'
        + (slot.status === 'uploading' ? ' progress="' + slot.progress + '"' : ' indeterminate') + '></sp-progress-bar>';
    } else if (slot.status === 'prompt') {
      html += '<textarea class="prompt" data-index="' + index + '" placeholder="Describe the image to generate">' + escapeHtml(prompts[index] || '') + '</textarea>'
        + '<div class="slot-buttons"><sp-button size="s" variant="accent" data-action="generate" data-index="' + index + '">Generate</sp-button>'
        + '<sp-button size="s" variant="secondary" treatment="outline" data-action="cancel-prompt" data-index="' + index + '">Cancel</sp-button></div>';
    } else {
      html += '<div class="subtle slot-empty">Drop an image</div>'
        + '<sp-button size="s" variant="secondary" treatment="quiet" data-action="prompt" data-index="' + index + '">Generate with Firefly</sp-button>'
        + (slot.error ? '<div class="cell-error">' + escapeHtml(slot.error) + '</div>' : '');
    }
    return html + '</sp-dropzone>';
  }

  // Positions the crop frame over the image. Percentages of the image keep it independent of when the layout is computed.
  function positionFrame(index) {
    (slots[index].crops || []).forEach(function (crop, k) { positionCrop(index, k); });
  }
  function positionCrop(index, k) {
    var slot = slots[index];
    var box = grid.querySelector('.crop[data-index="' + index + '"][data-frame="' + k + '"]');
    var crop = slot.crops && slot.crops[k];
    if (!box || !crop) return;
    var l = crop.left / slot.image.width * 100;
    var t = crop.top / slot.image.height * 100;
    var r = crop.right / slot.image.width * 100;
    var b = crop.bottom / slot.image.height * 100;
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
    // The prompt being typed keeps its focus and caret when the grid is drawn again (other slots change meanwhile)
    var active = document.activeElement && document.activeElement.classList.contains('prompt')
      ? { index: document.activeElement.getAttribute('data-index'), start: document.activeElement.selectionStart, end: document.activeElement.selectionEnd }
      : null;
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
    if (active) {
      var field = grid.querySelector('.prompt[data-index="' + active.index + '"]');
      if (field) { field.focus(); field.setSelectionRange(active.start, active.end); }
    }
    Array.prototype.forEach.call(grid.querySelectorAll('.prompt'), fitPrompt);
    updateStatus();
  }

  // Slots waiting for their image to be generated from their prompt (written by the assistant, maybe edited): with the prompt
  // shown, or empty with a prompt from the assistant
  function pendingPrompts() {
    return slots.map(function (s, i) {
      return (s.status === 'prompt' || (s.status === 'empty' && prompted[i])) && String(prompts[i] || '').trim() ? i : -1;
    })
      .filter(function (i) { return i >= 0; });
  }
  function generateAll() { pendingPrompts().forEach(generateToSlot); }

  // Height of a prompt field fitted to its text (browsers without CSS field-sizing)
  var PROMPT_FITS = Boolean(window.CSS && CSS.supports('field-sizing', 'content'));
  function fitPrompt(field) {
    if (PROMPT_FITS) return;
    field.style.height = 'auto';
    field.style.height = Math.min(field.scrollHeight + 2, 220) + 'px';
  }

  function updateStatus() {
    var done = slots.filter(function (s) { return s.status === 'done'; }).length;
    var busy = slots.some(function (s) { return BUSY_LABELS[s.status]; });
    if (onChange) onChange(done, slots.length);
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
        if (!ratioOf(index)) return null;
        slot.status = 'framing';
        render();
        return suggestCrops(index, uploaded.url).then(function (suggestion) {
          slot.image = suggestion.image;
          slot.crops = suggestion.crops;
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

  // Generates the image of a slot with Firefly from its prompt, at the ratio of its frame, then frames it like an upload
  function generateToSlot(index) {
    var prompt = (prompts[index] || '').trim();
    if (!prompt) return setStatus('Describe the image to generate.', true);
    var layer = layerOf(index);
    fillSlot(index, 'Firefly image', 'generating', function (slot) {
      return callTool('generate-image', { prompt: prompt, width: layer.width, height: layer.height })
        .then(function (started) { return waitForTask(started.taskId); })
        .then(function (image) { slot.name = image.name; return image; });
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
    var frames = framesOf(index);
    // The crop given for each frame: from crops (by ratio), or crop for a single frame
    var given = frames.map(function (f, k) {
      var match = (image.crops || []).filter(function (c) { return c.crop && Math.abs(c.width / c.height - f.width / f.height) < 0.01; })[0];
      return match ? match.crop : k === 0 && image.crop ? image.crop : null;
    });
    var slot = slots[index] = { status: 'done', url: image.url, name: image.fileName || 'image', crops: given };
    if (image.width && image.height) slot.image = { width: image.width, height: image.height };
    if (!frames.length || (slot.image && given.every(Boolean))) return;
    slot.status = 'framing';
    suggestCrops(index, image.url)
      .then(function (suggestion) {
        slot.image = suggestion.image;
        slot.crops = given.map(function (crop, k) { return crop || suggestion.crops[k]; });
        slot.status = 'done';
      })
      .catch(function (error) {
        slots[index] = { status: 'empty', error: 'Image no longer available, upload it again (' + ((error && error.message) || error) + ')' };
      })
      .then(render);
  }

  // Shows the grid of the variants and layers given ({ variants, layers, images, prompts }, as upload-variant-images gets them)
  function init(args) {
    variants = (args.variants || []).map(String);
    layers = (args.layers && args.layers.length) ? args.layers : [{ name: 'Image' }];
    slots = [];
    for (var i = 0; i < variants.length * layers.length; i++) slots.push({ status: 'empty' });
    // Row of a variant label, also given with its language code (e.g. "Winter sale FR" for the row "Winter sale")
    function rowOf(label) {
      var index = variants.indexOf(label);
      return index >= 0 ? index : variants.indexOf(String(label).replace(/[\\s_-]+\\(?[A-Z]{2}\\)?$/, '').trim());
    }
    prompts = {};
    prompted = {};
    (args.prompts || []).forEach(function (p) {
      var layerIndex = layers.findIndex(function (l) { return l.id === p.layerId; });
      var variantIndex = typeof p.variant === 'string' ? rowOf(p.variant) : p.variant;
      if (layerIndex < 0 || variantIndex < 0 || variantIndex >= variants.length) return;
      // The slot offers to generate its image (Generate with Firefly shows its prompt, to edit); an image can still be dropped on it
      prompts[variantIndex * layers.length + layerIndex] = p.prompt;
      prompted[variantIndex * layers.length + layerIndex] = true;
    });
    (args.images || []).forEach(function (image) {
      var layerIndex = layers.findIndex(function (l) { return l.id === image.layerId; });
      // The variant is given by label (preferred) or by 0-based index
      var variantIndex = typeof image.variant === 'string' ? rowOf(image.variant) : image.variant;
      if (layerIndex < 0 || variantIndex < 0 || variantIndex >= variants.length) return;
      prefillSlot(variantIndex * layers.length + layerIndex, image);
    });
    render();
  }
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
    if (armed < 0 || e.target.closest('sp-button, .crop, .zoom, .prompt')) return;
    var zone = e.target.closest('sp-dropzone');
    if (zone) useLibraryImage(Number(zone.getAttribute('data-index')), library[armed]);
  });

  grid.addEventListener('click', function (e) {
    var button = e.target.closest('sp-button');
    if (!button) return;
    var index = Number(button.getAttribute('data-index'));
    var action = button.getAttribute('data-action');
    if (action === 'remove' || action === 'cancel-prompt') {
      slots[index] = { status: 'empty' };
      render();
    } else if (action === 'prompt') {
      slots[index] = { status: 'prompt' };
      render();
      var field = grid.querySelector('.prompt[data-index="' + index + '"]');
      if (field) field.focus();
    } else if (action === 'generate') {
      generateToSlot(index);
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
    var k = Number(box.getAttribute('data-frame'));
    var slot = slots[index];
    drag = { index: index, k: k, box: box, x: e.clientX, y: e.clientY, crop: slot.crops[k],
      scale: box.clientWidth / slot.image.width };
    box.classList.add('dragging');
    box.setPointerCapture(e.pointerId);
  });
  grid.addEventListener('pointermove', function (e) {
    if (!drag) return;
    var slot = slots[drag.index];
    var dx = (e.clientX - drag.x) / drag.scale;
    var dy = (e.clientY - drag.y) / drag.scale;
    slot.crops[drag.k] = { left: drag.crop.left + dx, top: drag.crop.top + dy, right: drag.crop.right + dx, bottom: drag.crop.bottom + dy };
    clampCrop(slot, drag.k, ratioOf(drag.index, drag.k));
    positionCrop(drag.index, drag.k);
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
    if (e.target.classList.contains('prompt')) {
      prompts[Number(e.target.getAttribute('data-index'))] = e.target.value;
      fitPrompt(e.target);
      if (onChange) onChange(slots.filter(function (s) { return s.status === 'done'; }).length, slots.length);
      return;
    }
    if (e.target.type !== 'range') return;
    var index = Number(e.target.getAttribute('data-index'));
    var k = Number(e.target.getAttribute('data-frame'));
    var slot = slots[index];
    var ratio = ratioOf(index, k);
    var size = maxCropSize(slot, ratio);
    var width = size.width / Number(e.target.value);
    var crop = slot.crops[k];
    var cx = (crop.left + crop.right) / 2;
    var cy = (crop.top + crop.bottom) / 2;
    slot.crops[k] = { left: cx - width / 2, top: cy - width / ratio / 2, right: cx + width / 2, bottom: cy + width / ratio / 2 };
    clampCrop(slot, k, ratio);
    positionCrop(index, k);
  });

  // The images chosen, for the model: what each variant and layer gets, and the JSON to pass again to re-crop them
  function result() {
    var rounded = function (c) { return c && { left: Math.round(c.left), top: Math.round(c.top), right: Math.round(c.right), bottom: Math.round(c.bottom) }; };
    var multiFrame = false;
    var mapping = slots.map(function (slot, i) {
      var layer = layerOf(i);
      var frames = framesOf(i);
      var crops = (slot.crops || []).map(rounded);
      if (frames.length > 1) multiFrame = true;
      return { variant: variants[Math.floor(i / layers.length)], layerId: layer.id, layerName: layer.name,
        fileName: slot.name, url: slot.url, crop: crops[0],
        crops: frames.length > 1 && crops.length === frames.length ? frames.map(function (f, k) { return { width: f.width, height: f.height, crop: crops[k] }; }) : null,
        size: slot.image };
    });
    // Ready-to-use JSON, so that the mapping between variants and images is copied rather than rebuilt
    var images = mapping.map(function (m) {
      var image = { variant: m.variant, layerId: m.layerId, url: m.url, fileName: m.fileName };
      if (m.crop) image.crop = m.crop;
      if (m.crops) image.crops = m.crops;
      if (m.size) { image.width = m.size.width; image.height = m.size.height; }
      return image;
    });
    var context = 'Images chosen by the user for each variant and smart object layer (URLs valid 24 hours):\\n'
      + mapping.map(function (m) { return '- variant "' + m.variant + '", layer "' + m.layerName + '": ' + m.fileName; }).join('\\n')
      + '\\nFor create-variant, use for each variant exactly the entries below whose "variant" is its label '
      + '(smart_object_layer edit = { id: layerId, type: "smart_object_layer", imageUrl: url, crop' + (multiFrame ? ', crops' : '') + ' }'
      + (multiFrame ? ': crops has the crop of the image for each frame ratio of the templates, pass it as is' : '') + '). '
      + 'To re-crop later, pass this "images" array as is to upload-variant-images:\\n'
      + JSON.stringify({ images: images });
    return context;
  }

  // The images chosen, as data for the server (create-variant with widgetRef)
  function data() {
    var rounded = function (c) { return c && { left: Math.round(c.left), top: Math.round(c.top), right: Math.round(c.right), bottom: Math.round(c.bottom) }; };
    return slots.map(function (slot, i) {
      var layer = layerOf(i);
      var frames = framesOf(i);
      var crops = (slot.crops || []).map(rounded);
      var image = { variant: variants[Math.floor(i / layers.length)], layerId: layer.id, url: slot.url, fileName: slot.name };
      if (crops[0]) image.crop = crops[0];
      if (frames.length > 1 && crops.length === frames.length) image.crops = frames.map(function (f, k) { return { width: f.width, height: f.height, crop: crops[k] }; });
      if (slot.image) { image.width = slot.image.width; image.height = slot.image.height; }
      return image;
    });
  }

  return { init: init, onChange: function (handler) { onChange = handler; }, result: result, data: data, count: function () { return variants.length; },
    pendingPrompts: function () { return pendingPrompts().length; }, generateAll: generateAll };
  })();
`

function getVariantImagesViewHtml (scriptUrl) {
  return page(scriptUrl, 'Variant Images', `
${IMAGES_CSS}
${STEPS_CSS}
  .steps.single { grid-template-columns: 1fr; }
`, `
<h2 class="heading" id="title">Drop one image per variant</h2>
<ol class="steps single" aria-label="Step"><li data-for="4" class="current"><span class="step-kicker">Step 4</span><span class="step-title">Images</span></li></ol>
<div class="subtle intro">Add images, then drag each one onto the slots that use it (or drop a file on a slot). The bright area is what the banner shows: drag it to reposition the crop, use Zoom to resize it.</div>
${IMAGES_HTML}<div class="actions">
  <sp-button variant="accent" id="confirm" disabled>Confirm images</sp-button>
  <sp-help-text class="status" id="status"></sp-help-text>
</div>
`, `
${UPLOAD_SCRIPT}
${AEM_SCRIPT}
${IMAGES_SCRIPT}
  var confirmBtn = document.getElementById('confirm');
  // With slots waiting for their prompt to be generated, the button generates them all with Firefly
  imagesPicker.onChange(function (done, total) {
    var pending = imagesPicker.pendingPrompts();
    confirmBtn.disabled = !pending && (done !== total || !total);
    confirmBtn.textContent = pending ? 'Generate with Firefly (' + pending + ')' : 'Confirm images (' + done + '/' + total + ')';
  });

  onToolInput(function (args) {
    if (args.title) document.getElementById('title').textContent = args.title;
    imagesPicker.init(args);
  });

  confirmBtn.addEventListener('click', function () {
    if (imagesPicker.pendingPrompts()) return imagesPicker.generateAll();
    confirmBtn.disabled = true;
    sendToModel('To generate the variants with these images, call create-variant with widgetRef "{{ref}}" (with the reference of the '
      + 'texts too, if they were confirmed apart, and languages for the languages of the start widget when there are no texts) instead of '
      + 'copying the images: the server builds the variants from them.\\n' + imagesPicker.result(),
      'I added and framed the images for the ' + imagesPicker.count() + ' variant(s), continue.', 'Images sent.', { images: imagesPicker.data() })
      .catch(function (error) {
        confirmBtn.disabled = false;
        setStatus((error && error.message) || String(error), true);
      });
  });
`)
}

// Steps of a view (start, texts and images), as segments of a progress bar: <ol class="steps"> of <li data-for="N"> with a
// .step-kicker and a .step-title; the view marks them current, done and reachable, and shows the element [data-step="N"].
const STEPS_CSS = `
  /* Two steps, as segments of a progress bar: the bar of the current and done steps in the accent color, with the number and
     the name of each step below it */
  .steps { display: grid; grid-template-columns: 1fr 1fr; gap: var(--spectrum-spacing-200); margin: var(--spectrum-spacing-300) 0 var(--spectrum-spacing-400); padding: 0; list-style: none; }
  .steps li { display: flex; flex-direction: column; gap: 2px; padding-top: var(--spectrum-spacing-100); border-top: 4px solid var(--spectrum-gray-200); border-radius: 2px 2px 0 0; transition: border-color 0.15s; }
  .step-kicker { font-size: var(--spectrum-font-size-50, 11px); font-weight: var(--spectrum-bold-font-weight); letter-spacing: 0.04em; text-transform: uppercase; color: var(--spectrum-neutral-subdued-content-color-default); }
  .step-title { color: var(--spectrum-neutral-subdued-content-color-default); }
  .steps li.current, .steps li.done { border-top-color: var(--spectrum-accent-background-color-default); }
  .steps li.current .step-kicker { color: var(--spectrum-accent-content-color-default); }
  .steps li.current .step-title { color: var(--spectrum-neutral-content-color-default); font-weight: var(--spectrum-bold-font-weight); }
  .steps li.done .step-kicker::after { content: ' \\2713'; }
  [data-step][hidden] { display: none; }
  /* A step that can be gone to (the done one, or the next one once the current one is complete), on hover like the current one */
  .steps li.reachable { cursor: pointer; }
  .steps li.reachable:hover { border-top-color: var(--spectrum-accent-background-color-hover, var(--spectrum-accent-background-color-default)); }
  .steps li.reachable:hover .step-title { color: var(--spectrum-neutral-content-color-default); }
`

// Picker of the layers of a template (preview with numbered zones, and list), shared by the start and layers views:
// showTemplate(data) shows the layers and the preview of a template read in a task (get-psd-manifest, read-psd-template),
// selectedForModel() gives the layers picked; the view defines onLayersChange(count).
const LAYERS_CSS = `
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
  #layers { display: grid; grid-template-columns: auto auto minmax(0, 1fr); }
  #layers .row { display: grid; grid-column: 1 / -1; grid-template-columns: subgrid; cursor: default; }
  /* Start widget: a last column to have the assistant write Firefly prompts for a smart object layer */
  #layers.with-ai { grid-template-columns: auto auto minmax(0, 1fr) auto; }
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
  /* Without a preview (no numbers), a dot of the color of the type */
  .row .num:empty { min-width: 10px; width: 10px; height: 10px; padding: 0; }
  /* Legend of the colors of the layer types, in the head of the list */
  .row.head { justify-content: space-between; flex-wrap: wrap; }
  .legend { display: flex; gap: var(--spectrum-spacing-200); font-size: var(--spectrum-font-size-75); color: var(--spectrum-neutral-subdued-content-color-default); }
  .legend span { display: inline-flex; align-items: center; gap: var(--spectrum-spacing-75); }
  .legend i { width: 10px; height: 10px; border-radius: 50%; }
  .legend i.text { background: var(--spectrum-informative-background-color-default); }
  .legend i.image { background: var(--spectrum-seafoam-background-color-default); }
`

const LAYERS_HTML = `<div class="picker">
  <div class="preview" id="preview" hidden>
    <div class="preview-loader" id="preview-loader" hidden><sp-progress-circle size="l" indeterminate label="Rendering the preview"></sp-progress-circle><span class="subtle">Rendering the preview...</span></div>
    <div class="stage" id="stage"><img id="preview-img" alt="Template preview"><div id="zones"></div></div>
  </div>
  <div class="list" id="list">
    <div class="row head"><sp-checkbox id="select-all">Select all</sp-checkbox>
      <div class="legend" aria-hidden="true"><span><i class="text"></i>Text</span><span><i class="image"></i>Smart object</span></div></div>
    <div id="layers"></div>
  </div>
</div>
`

const LAYERS_SCRIPT = `
  var layers = [];
  // Size of the document shown, for the place of the spinner
  var previewDoc = null;
  // Number of each layer shown on the preview (1, 2...), in the order of the list; none for layers without a zone
  var numbers = [];
  var listEl = document.getElementById('layers');
  var zonesEl = document.getElementById('zones');
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
    onLayersChange(count);
  }

  function render(data) {
    layers = data.layers || [];
    var titleEl = document.getElementById('title');
    if (titleEl && data.document && data.document.title) titleEl.textContent = data.document.title;
    if (!layers.length) {
      setStatus('No unlocked text or smart object layer in this file.');
      return;
    }
    var doc = data.document || {};
    previewDoc = doc;
    var hasPreview = Boolean(data.previewUrl && doc.width && doc.height && layers.some(function (l) { return l.area; }));
    var next = 0;
    numbers = layers.map(function (l) { return hasPreview && l.area ? ++next : null; });
    listEl.innerHTML = layers.map(function (l, i) {
      var isText = l.type === 'text_layer';
      return '<div class="row" data-index="' + i + '"><sp-checkbox id="layer-' + i + '" aria-label="' + escapeHtml(l.name) + ', ' + (isText ? 'text' : 'smart object') + '"></sp-checkbox>'
        + '<span class="num ' + (isText ? 'text' : 'image') + '">' + (numbers[i] || '') + '</span>'
        + '<span class="layer-name" title="' + escapeHtml(l.name) + ' (' + (isText ? 'text' : 'smart object') + ')">' + escapeHtml(l.name) + '</span>'
        + (typeof layerExtraCell === 'function' ? layerExtraCell(l, i) : '')
        + '</div>';
    }).join('');
    document.getElementById('list').style.display = 'block';
    if (hasPreview) renderPreview(data.previewUrl, doc);
    setStatus(layers.length + ' editable layer(s).');
  }

  // Spinner in place of the preview while it renders; hidePreviewLoader when it cannot be shown.
  // With the size of the document, the spinner takes the place the preview will take (same ratio, same largest height), so
  // that the layout does not change when it appears
  function showPreviewLoader(doc) {
    var loader = document.getElementById('preview-loader');
    doc = doc || previewDoc;
    if (doc && doc.width && doc.height) {
      loader.style.aspectRatio = doc.width + ' / ' + doc.height;
      loader.style.width = Math.round(460 * doc.width / doc.height) + 'px';
      loader.style.height = 'auto';
    }
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
    // The spinner stays until the image is loaded
    showPreviewLoader(doc);
    var shown = function () {
      if (img.getAttribute('src') !== previewUrl) return;
      document.getElementById('preview-loader').hidden = true;
      document.getElementById('stage').hidden = false;
      reportSize();
    };
    img.onload = shown;
    img.onerror = shown;
    img.src = previewUrl;
    var introEl = document.getElementById('intro');
    if (introEl) introEl.textContent = 'Click the numbered zones of the template, or the list, to pick the layers to use for the variants.';
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
  // isCurrent(), when given, tells whether the template is still the one shown (another one may be dropped meanwhile).
  // onMissingFonts(list), when given, gets the fonts of the template missing for the render.
  function showTemplate(data, isCurrent, onMissingFonts) {
    var current = isCurrent || function () { return true; };
    if (data.layers) render(data);
    if (!data.taskId || data.previewUrl) return;
    setStatus(layers.length ? layers.length + ' editable layer(s). Rendering the preview of the template...' : 'Reading the template...', false, true);
    showPreviewLoader();
    return waitForTask(data.taskId, function (partial) {
      if (!current() || layers.length || !partial.layers) return;
      render(partial);
      setStatus(layers.length + ' editable layer(s). Rendering the preview of the template...', false, true);
      showPreviewLoader();
    })
      .then(function (template) {
        if (!current()) return;
        if (!layers.length) render(template);
        else if (template.previewUrl) showLatePreview(template.previewUrl, template.document || {});
        if (!template.previewUrl) hidePreviewLoader();
        if (onMissingFonts && template.missingFonts) onMissingFonts(template.missingFonts);
        setStatus(layers.length + ' editable layer(s).' + (template.previewUrl ? '' : ' Preview not available: ' + (template.previewError || 'no preview')));
      })
      .catch(function (error) {
        if (!current()) return;
        var reason = (error && error.message) || String(error);
        hidePreviewLoader();
        setStatus(layers.length ? layers.length + ' editable layer(s). Preview not available: ' + reason : reason, !layers.length);
      });
  }

  // Empties the picker, before another template is read
  function clearTemplate() {
    layers = [];
    numbers = [];
    listEl.innerHTML = '';
    zonesEl.innerHTML = '';
    document.getElementById('list').style.display = 'none';
    document.getElementById('preview').hidden = true;
    onLayersChange(0);
  }

  // The selected layers as the model needs them: without their areas on the preview
  function selectedForModel() {
    return selected().map(function (l) {
      var layer = {};
      Object.keys(l).forEach(function (key) { if (key !== 'area') layer[key] = l[key]; });
      return layer;
    });
  }

`

function getLayersViewHtml (scriptUrl) {
  return page(scriptUrl, 'PSD Layers', `
  .subtle.intro { margin-bottom: var(--spectrum-spacing-200); }
${LAYERS_CSS}
`, `
<h2 class="heading" id="title">Editable layers</h2>
<div class="subtle intro" id="intro">Pick the layers to use for the variants.</div>
${LAYERS_HTML}<div class="actions"><sp-button variant="accent" id="confirm" disabled>Use these layers</sp-button></div>
<sp-help-text class="status" id="status"></sp-help-text>
`, `
  setStatus('Reading the template...', false, true);
${LAYERS_SCRIPT}
  var confirmBtn = document.getElementById('confirm');
  function onLayersChange(count) { confirmBtn.disabled = !count; }

  // The template is read in a task: the layers come with the tool result when read in time, otherwise from the task, then
  // the preview from the task.
  onToolResult(function (result) {
    if (result.isError) {
      setStatus(result.content && result.content[0] ? result.content[0].text : 'Error', true);
      return;
    }
    showTemplate(result.structuredContent || {});
  });

  confirmBtn.addEventListener('click', function () {
    var chosen = selected();
    if (!chosen.length) return;
    confirmBtn.disabled = true;
    var images = chosen.filter(function (l) { return l.type === 'smart_object_layer'; });
    var context = 'Layers selected by the user for the variants: ' + JSON.stringify(chosen.map(function (l) {
      return { id: l.id, name: l.name, type: l.type };
    })) + '. Next: if text layers were selected, get the texts of each variant (from the user, or written from a brief), each as long as '
      + 'the original text of its layer, give each variant a short label, then call edit-variant-texts'
      + (images.length
        ? (chosen.length > images.length ? ' with images (the grid of these smart object layers, as a second step)' : '')
          + '; with smart object layers only, call upload-variant-images ONCE with all variant labels and layers ' + JSON.stringify(images.map(function (l) { return { id: l.id, name: l.name, width: l.frame && l.frame.width, height: l.frame && l.frame.height }; }))
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
  /* Import and export of the table as an Excel file, above it */
  .sheet { display: flex; flex-wrap: wrap; align-items: center; gap: var(--spectrum-spacing-200); margin-bottom: var(--spectrum-spacing-200); }
  #sheet-file { display: none; }
  /* With images too: a second step, the grid of the images */
${STEPS_CSS}
  .steps[hidden] { display: none; }
${IMAGES_CSS}
`, `
<h2 class="heading" id="title">Texts per variant</h2>
<ol class="steps" aria-label="Steps" hidden>
  <li data-for="1" class="current" role="button" tabindex="-1"><span class="step-kicker">Step 3</span><span class="step-title">Texts</span></li>
  <li data-for="2" role="button" tabindex="-1"><span class="step-kicker">Step 4</span><span class="step-title">Images</span></li>
</ol>
<div data-step="1">
<div class="subtle intro">Click a text to edit it, then confirm. Keep each text about as long as the original, so that it fits the layout.
You can also paste cells copied from a spreadsheet, or import an Excel file (.xlsx) with a column per layer (download this table to get one).</div>
<div class="sheet">
  <sp-button size="s" variant="secondary" treatment="outline" id="import">Import Excel</sp-button>
  <sp-button size="s" variant="secondary" treatment="outline" id="export">Download Excel</sp-button>
  <input type="file" id="sheet-file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet">
  <sp-help-text id="sheet-status"></sp-help-text>
</div>
<div class="table-wrap"><table class="texts" id="table"></table></div>
</div>
<div data-step="2" hidden>
  <div class="subtle intro">Add images, then drag each one onto the slots that use it (or drop a file on a slot, or generate it with Firefly). The bright area is what the banner shows: drag it to reposition the crop, use Zoom to resize it.</div>
  ${IMAGES_HTML}
</div>
<div class="actions">
  <sp-button variant="secondary" treatment="outline" id="back" hidden>Back</sp-button>
  <sp-button variant="accent" id="confirm" disabled>Use these texts</sp-button>
  <sp-help-text class="status" id="status"></sp-help-text>
</div>
`, `
${UPLOAD_SCRIPT}
${AEM_SCRIPT}
${IMAGES_SCRIPT}
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
    updateConfirm();
  }

  // Rows of cells copied from a spreadsheet: tab-separated, cells in quotes may hold tabs, quotes doubled and line breaks
  function parseSheet(text) {
    var sep = '\\t';
    var rows = [], row = [], cell = '', quoted = false;
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      if (quoted) {
        if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
        else if (ch === '"') quoted = false;
        else cell += ch;
      } else if (ch === '"' && cell === '') quoted = true;
      else if (ch === sep) { row.push(cell); cell = ''; }
      else if (ch === '\\n' || ch === '\\r') {
        if (ch === '\\r' && text[i + 1] === '\\n') i++;
        row.push(cell); rows.push(row); row = []; cell = '';
      } else cell += ch;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows.filter(function (r) { return r.some(function (c) { return c.trim(); }); });
  }

  var normalize = function (text) { return String(text).trim().toLowerCase(); };

  // Fills the table from rows of a spreadsheet with a header: the first column names the variants, the others the layers (by
  // name, or by id). The rows are matched to the variants by label, or in order when no label matches.
  function importRows(rows) {
    if (rows.length < 2) throw new Error('The file needs a header row (Variant, then the layer names) and a row per variant.');
    var columns = rows[0].slice(1).map(function (name) {
      return layers.findIndex(function (l) { return normalize(l.name) === normalize(name) || String(l.id) === name.trim(); });
    });
    if (columns.every(function (c) { return c < 0; })) {
      throw new Error('No column matches a layer: name them ' + layers.map(function (l) { return '"' + l.name + '"'; }).join(', ') + '.');
    }
    var body = rows.slice(1);
    var byLabel = body.some(function (r) { return variants.some(function (v) { return normalize(v.label) === normalize(r[0]); }); });
    var fields = inputs();
    var filled = 0, unmatched = [];
    body.forEach(function (r, i) {
      var index = byLabel ? variants.findIndex(function (v) { return normalize(v.label) === normalize(r[0]); }) : i;
      if (index < 0 || index >= variants.length) { unmatched.push(r[0] || 'row ' + (i + 2)); return; }
      columns.forEach(function (c, k) { if (c >= 0 && r[k + 1] != null) fields[index * layers.length + c].value = r[k + 1]; });
      filled++;
    });
    fit(fields);
    var ignored = rows[0].slice(1).filter(function (name, k) { return columns[k] < 0 && String(name).trim(); });
    return filled + ' variant(s) filled' + (unmatched.length ? '; rows not matched to a variant: ' + unmatched.join(', ') : '')
      + (ignored.length ? '; columns ignored: ' + ignored.join(', ') : '') + '.';
  }

  function sheetStatus(text, negative) {
    var status = document.getElementById('sheet-status');
    status.textContent = text;
    status.variant = negative ? 'negative' : 'neutral';
    reportSize();
  }

  // Excel workbooks (.xlsx), read and written in the view: a ZIP archive of XML files. The first sheet is read, its cells as
  // text; the table is written as a sheet with a header row, a column per layer and the line breaks of the texts kept.
  function zipEntries(buffer) {
    var view = new DataView(buffer);
    var end = buffer.byteLength - 22;
    while (end >= 0 && view.getUint32(end, true) !== 0x06054b50) end--;
    if (end < 0) throw new Error('This file is not an Excel workbook (.xlsx).');
    var count = view.getUint16(end + 10, true), offset = view.getUint32(end + 16, true);
    var entries = {};
    for (var i = 0; i < count; i++) {
      var nameLength = view.getUint16(offset + 28, true);
      var name = new TextDecoder().decode(new Uint8Array(buffer, offset + 46, nameLength));
      entries[name] = { method: view.getUint16(offset + 10, true), size: view.getUint32(offset + 20, true), local: view.getUint32(offset + 42, true) };
      offset += 46 + nameLength + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
    }
    return entries;
  }

  function zipText(buffer, entries, name) {
    var entry = entries[name];
    if (!entry) return Promise.resolve(null);
    var view = new DataView(buffer);
    var start = entry.local + 30 + view.getUint16(entry.local + 26, true) + view.getUint16(entry.local + 28, true);
    var data = new Uint8Array(buffer, start, entry.size);
    if (entry.method === 0) return Promise.resolve(new TextDecoder().decode(data));
    var stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Response(stream).text();
  }

  function xmlOf(text) { return new DOMParser().parseFromString(text, 'application/xml'); }
  function children(node, name) { return Array.prototype.filter.call(node.childNodes, function (c) { return c.localName === name; }); }
  // Text of a string item: its runs, without their phonetic guides
  function itemText(node) {
    return Array.prototype.filter.call(node.getElementsByTagNameNS('*', 't'), function (t) {
      return !(t.parentNode && t.parentNode.localName === 'rPh');
    }).map(function (t) { return t.textContent; }).join('');
  }
  function columnIndex(ref) {
    var letters = String(ref || '').replace(/[0-9]/g, ''), index = 0;
    for (var i = 0; i < letters.length; i++) index = index * 26 + letters.charCodeAt(i) - 64;
    return index - 1;
  }

  // Rows of the first sheet of a workbook, as arrays of texts
  function readWorkbook(file) {
    return file.arrayBuffer().then(function (buffer) {
      var entries = zipEntries(buffer);
      return Promise.all([zipText(buffer, entries, 'xl/workbook.xml'), zipText(buffer, entries, 'xl/_rels/workbook.xml.rels'),
        zipText(buffer, entries, 'xl/sharedStrings.xml')]).then(function (parts) {
        if (!parts[0]) throw new Error('This file is not an Excel workbook (.xlsx).');
        var sheet = xmlOf(parts[0]).getElementsByTagNameNS('*', 'sheet')[0];
        var relId = sheet && Array.prototype.filter.call(sheet.attributes, function (a) { return a.localName === 'id'; })[0];
        var path = 'xl/worksheets/sheet1.xml';
        if (relId && parts[1]) {
          Array.prototype.forEach.call(xmlOf(parts[1]).getElementsByTagNameNS('*', 'Relationship'), function (r) {
            if (r.getAttribute('Id') !== relId.value) return;
            var target = r.getAttribute('Target');
            path = target.charAt(0) === '/' ? target.slice(1) : 'xl/' + target;
          });
        }
        var strings = parts[2] ? Array.prototype.map.call(xmlOf(parts[2]).getElementsByTagNameNS('*', 'si'), itemText) : [];
        return zipText(buffer, entries, path).then(function (text) {
          if (!text) throw new Error('The first sheet of the workbook was not found.');
          var rows = [];
          Array.prototype.forEach.call(xmlOf(text).getElementsByTagNameNS('*', 'row'), function (row) {
            var cells = [];
            children(row, 'c').forEach(function (c, k) {
              var type = c.getAttribute('t'), v = children(c, 'v')[0], value;
              if (type === 'inlineStr') value = children(c, 'is')[0] ? itemText(children(c, 'is')[0]) : '';
              else if (type === 's') value = v ? strings[Number(v.textContent)] || '' : '';
              else value = v ? v.textContent : '';
              var index = c.getAttribute('r') ? columnIndex(c.getAttribute('r')) : k;
              while (cells.length < index) cells.push('');
              cells[index] = value;
            });
            var number = Number(row.getAttribute('r')) || rows.length + 1;
            while (rows.length < number - 1) rows.push([]);
            rows.push(cells);
          });
          return rows.filter(function (r) { return r.some(function (c) { return String(c).trim(); }); });
        });
      });
    });
  }

  var CRC_TABLE = (function () {
    var table = [];
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table.push(c >>> 0);
    }
    return table;
  })();
  function crc32(bytes) {
    var c = 0xffffffff;
    for (var i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  // ZIP archive of the files ({ name: text }), stored without compression
  function zipFiles(files) {
    var encoder = new TextEncoder(), parts = [], central = [], offset = 0;
    Object.keys(files).forEach(function (name) {
      var nameBytes = encoder.encode(name), data = encoder.encode(files[name]), crc = crc32(data);
      var local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(8, 0, true);
      local.setUint32(14, crc, true); local.setUint32(18, data.length, true); local.setUint32(22, data.length, true);
      local.setUint16(26, nameBytes.length, true);
      var entry = new DataView(new ArrayBuffer(46));
      entry.setUint32(0, 0x02014b50, true); entry.setUint16(4, 20, true); entry.setUint16(6, 20, true);
      entry.setUint32(16, crc, true); entry.setUint32(20, data.length, true); entry.setUint32(24, data.length, true);
      entry.setUint16(28, nameBytes.length, true); entry.setUint32(42, offset, true);
      parts.push(local.buffer, nameBytes, data);
      central.push(entry.buffer, nameBytes);
      offset += 30 + nameBytes.length + data.length;
    });
    var size = central.reduce(function (sum, part) { return sum + part.byteLength; }, 0);
    var end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, Object.keys(files).length, true); end.setUint16(10, Object.keys(files).length, true);
    end.setUint32(12, size, true); end.setUint32(16, offset, true);
    return new Blob(parts.concat(central, [end.buffer]));
  }

  function xmlText(text) {
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f]/g, '');
  }
  function columnName(index) {
    var name = '';
    for (index++; index > 0; index = Math.floor((index - 1) / 26)) name = String.fromCharCode(65 + (index - 1) % 26) + name;
    return name;
  }

  // Workbook of rows of texts, laid out: a header row in white on blue, frozen with the variant column, thin
  // borders, the texts wrapped on their lines at the top of their cells, and each column about as wide as its longest line.
  // Styles (cellXfs): 0 default, 1 text, 2 header, 3 variant label.
  function workbook(rows) {
    var NS = 'http://schemas.openxmlformats.org/';
    var widths = rows[0].map(function (name, c) {
      var longest = 0;
      rows.forEach(function (cells) {
        String(cells[c] == null ? '' : cells[c]).split('\\n').forEach(function (line) { longest = Math.max(longest, line.length); });
      });
      return Math.min(60, Math.max(c ? 20 : 16, longest + 4));
    });
    var sheetRows = rows.map(function (cells, r) {
      return '<row r="' + (r + 1) + '"' + (r ? '' : ' ht="24" customHeight="1"') + '>' + cells.map(function (text, c) {
        return '<c r="' + columnName(c) + (r + 1) + '" t="inlineStr" s="' + (r ? (c ? 1 : 3) : 2) + '"><is><t xml:space="preserve">'
          + xmlText(text) + '</t></is></c>';
      }).join('') + '</row>';
    }).join('');
    var thin = '<left style="thin"><color rgb="FFD5D5D5"/></left><right style="thin"><color rgb="FFD5D5D5"/></right>'
      + '<top style="thin"><color rgb="FFD5D5D5"/></top><bottom style="thin"><color rgb="FFD5D5D5"/></bottom><diagonal/>';
    var head = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
    return zipFiles({
      '[Content_Types].xml': head + '<Types xmlns="' + NS + 'package/2006/content-types">'
        + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        + '<Default Extension="xml" ContentType="application/xml"/>'
        + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
        + '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
        + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>',
      '_rels/.rels': head + '<Relationships xmlns="' + NS + 'package/2006/relationships">'
        + '<Relationship Id="rId1" Type="' + NS + 'officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
      'xl/workbook.xml': head + '<workbook xmlns="' + NS + 'spreadsheetml/2006/main" xmlns:r="' + NS + 'officeDocument/2006/relationships">'
        + '<sheets><sheet name="Texts" sheetId="1" r:id="rId1"/></sheets></workbook>',
      'xl/_rels/workbook.xml.rels': head + '<Relationships xmlns="' + NS + 'package/2006/relationships">'
        + '<Relationship Id="rId1" Type="' + NS + 'officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
        + '<Relationship Id="rId2" Type="' + NS + 'officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
      'xl/styles.xml': head + '<styleSheet xmlns="' + NS + 'spreadsheetml/2006/main">'
        + '<fonts count="3"><font><sz val="11"/><name val="Calibri"/></font>'
        + '<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>'
        + '<font><b/><sz val="11"/><name val="Calibri"/></font></fonts>'
        + '<fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>'
        + '<fill><patternFill patternType="solid"><fgColor rgb="FF1473E6"/><bgColor indexed="64"/></patternFill></fill>'
        + '<fill><patternFill patternType="solid"><fgColor rgb="FFF3F3F3"/><bgColor indexed="64"/></patternFill></fill></fills>'
        + '<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border>' + thin + '</border></borders>'
        + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
        + '<cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
        + '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf>'
        + '<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">'
        + '<alignment vertical="center"/></xf>'
        + '<xf numFmtId="0" fontId="2" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">'
        + '<alignment wrapText="1" vertical="top"/></xf></cellXfs></styleSheet>',
      'xl/worksheets/sheet1.xml': head + '<worksheet xmlns="' + NS + 'spreadsheetml/2006/main">'
        + '<sheetViews><sheetView workbookViewId="0"><pane xSplit="1" ySplit="1" topLeftCell="B2" activePane="bottomRight" state="frozen"/>'
        + '<selection pane="bottomRight" activeCell="B2" sqref="B2"/></sheetView></sheetViews>'
        + '<cols>' + widths.map(function (width, c) {
          return '<col min="' + (c + 1) + '" max="' + (c + 1) + '" width="' + width + '" customWidth="1"/>';
        }).join('') + '</cols>'
        + '<sheetData>' + sheetRows + '</sheetData></worksheet>'
    });
  }

  var sheetInput = document.getElementById('sheet-file');
  document.getElementById('import').addEventListener('click', function () { sheetInput.value = ''; sheetInput.click(); });
  sheetInput.addEventListener('change', function () {
    var file = sheetInput.files[0];
    if (!file) return;
    readWorkbook(file)
      .then(function (rows) { sheetStatus(file.name + ': ' + importRows(rows)); })
      .catch(function (error) { sheetStatus((error && error.message) || String(error), true); });
  });

  // Cells copied from a spreadsheet (tab-separated) and pasted in a text fill the table from this text, to the right and down
  table.addEventListener('paste', function (e) {
    var field = e.target;
    var text = e.clipboardData && e.clipboardData.getData('text/plain');
    if (!field.classList.contains('text-input') || !text || text.indexOf('\\t') < 0) return;
    e.preventDefault();
    var fields = inputs();
    var start = fields.indexOf(field);
    var row = Math.floor(start / layers.length), column = start % layers.length;
    parseSheet(text).forEach(function (cells, r) {
      cells.forEach(function (cell, c) {
        if (row + r < variants.length && column + c < layers.length) fields[(row + r) * layers.length + column + c].value = cell;
      });
    });
    fit(fields);
  });

  // The table as an Excel file, opened through a temporary link, as the views cannot download files themselves
  document.getElementById('export').addEventListener('click', function () {
    var rows = [['Variant'].concat(layers.map(function (l) { return l.name; }))].concat(currentTexts().map(function (v) {
      return [v.label].concat(v.texts.map(function (t) { return t.text; }));
    }));
    sheetStatus('Preparing the file...');
    uploadOne(new File([workbook(rows)], 'texts.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), function () {})
      .then(function (file) { sheetStatus(''); return request('ui/open-link', { url: file.url }); })
      .catch(function (error) { sheetStatus((error && error.message) || String(error), true); });
  });

  // With smart object layers too (args.images), the images are chosen in a second step, then sent with the texts
  var backBtn = document.getElementById('back');
  var withImages = false;
  var step = 1;
  var imagesDone = false;
  imagesPicker.onChange(function (done, total) { imagesDone = done === total && total > 0; updateConfirm(); });

  function updateConfirm() {
    if (!withImages) { confirmBtn.disabled = !variants.length; return; }
    var pending = step === 2 && imagesPicker.pendingPrompts();
    confirmBtn.textContent = step === 1 ? 'Next' : pending ? 'Generate with Firefly (' + pending + ')' : 'Use these texts and images';
    confirmBtn.disabled = !variants.length || (step === 2 && !pending && !imagesDone);
    Array.prototype.forEach.call(document.querySelectorAll('.steps li'), function (li) {
      var n = Number(li.getAttribute('data-for'));
      li.classList.toggle('current', n === step);
      li.classList.toggle('done', n < step);
      var ok = n !== step && !confirmBtn.hasAttribute('data-sending') && variants.length > 0;
      li.classList.toggle('reachable', ok);
      li.tabIndex = ok ? 0 : -1;
    });
  }

  function showStep(n) {
    step = n;
    Array.prototype.forEach.call(document.querySelectorAll('[data-step]'), function (el) { el.hidden = el.getAttribute('data-step') !== String(n); });
    backBtn.hidden = n !== 2;
    updateConfirm();
    reportSize();
  }

  backBtn.addEventListener('click', function () { showStep(1); });
  document.querySelector('.steps').addEventListener('click', function (e) {
    var li = e.target.closest('li.reachable');
    if (li) showStep(Number(li.getAttribute('data-for')));
  });
  document.querySelector('.steps').addEventListener('keydown', function (e) {
    var li = e.target.closest('li.reachable');
    if (li && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); showStep(Number(li.getAttribute('data-for'))); }
  });

  // Rows of the image grid when the model does not give them: the labels of the variants without their language code at the
  // end (e.g. "Winter sale" for "Winter sale FR"), each once, in order
  function groupLabels(list) {
    var groups = [];
    list.forEach(function (v) {
      var label = String(v.label).replace(/[\\s_-]+\\(?[A-Z]{2}\\)?$/, '').trim() || v.label;
      if (groups.indexOf(label) < 0) groups.push(label);
    });
    return groups;
  }

  onToolInput(function (args) {
    layers = args.layers || [];
    variants = args.variants || [];
    withImages = Boolean(args.images && args.images.layers && args.images.layers.length);
    document.querySelector('.steps').hidden = !withImages;
    document.getElementById('title').textContent = args.title || (withImages ? 'Texts and images per variant' : 'Texts per variant');
    render();
    if (withImages) imagesPicker.init(args.images.variants && args.images.variants.length ? args.images
      : Object.assign({}, args.images, { variants: groupLabels(variants) }));
    showStep(1);
  });

  confirmBtn.addEventListener('click', function () {
    if (withImages && step === 1) return showStep(2);
    if (withImages && imagesPicker.pendingPrompts()) return imagesPicker.generateAll();
    confirmBtn.disabled = true;
    confirmBtn.setAttribute('data-sending', '');
    updateConfirm();
    var confirmed = currentTexts();
    var context = 'Texts confirmed by the user for each variant'
      + (withImages ? ', and their images (below)' : '') + '. To generate them, call create-variant with widgetRef "{{ref}}" '
      + 'instead of variants: the server builds every variant from what the user confirmed (texts, font scales, '
      + (withImages ? 'images and crops, ' : '') + 'groups and languages from the labels). Do not copy the texts'
      + (withImages ? ', image URLs or crops' : '') + ' into the call. Texts, for reference:\\n' + JSON.stringify({ variants: confirmed })
      + (withImages ? '\\n\\n' + imagesPicker.result() + '\\nThe images are chosen: do not call upload-variant-images, call create-variant now (with widgetRef).' : '');
    var message = withImages
      ? 'I confirmed the texts and the images of the ' + confirmed.length + ' variant(s), continue.'
      : 'I confirmed the texts of the ' + confirmed.length + ' variant(s), continue.';
    sendToModel(context, message, withImages ? 'Texts and images sent.' : 'Texts sent.',
      { variants: confirmed, images: withImages ? imagesPicker.data() : undefined })
      .catch(function (error) {
        confirmBtn.removeAttribute('data-sending');
        updateConfirm();
        setStatus((error && error.message) || String(error), true);
      });
  });
`)
}

// Dashboards (report of a generation, usage history): tiles, then bar charts and tables
const REPORT_CSS = `
  .report {
    display: flex; flex-direction: column; gap: var(--spectrum-spacing-300);
    margin-top: var(--spectrum-spacing-400); padding: var(--spectrum-spacing-300);
    background: var(--spectrum-background-layer-2-color); border: 1px solid var(--spectrum-gray-200); border-radius: var(--spectrum-corner-radius-500);
  }
  .report[hidden] { display: none; }
  .report-title { font-weight: var(--spectrum-bold-font-weight); }
  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); gap: var(--spectrum-spacing-200); }
  .tile { display: flex; flex-direction: column; gap: 2px; padding: var(--spectrum-spacing-200); background: var(--spectrum-background-base-color); border-radius: var(--spectrum-corner-radius-200); }
  .tile-label, .chart-title { font-size: var(--spectrum-font-size-50, 11px); font-weight: var(--spectrum-bold-font-weight); letter-spacing: 0.04em; text-transform: uppercase; color: var(--spectrum-neutral-subdued-content-color-default); }
  .tile-value { font-size: var(--spectrum-font-size-500, 22px); font-weight: var(--spectrum-bold-font-weight); font-variant-numeric: tabular-nums; }
  .tile-note { font-size: var(--spectrum-font-size-75); color: var(--spectrum-neutral-subdued-content-color-default); }
  .charts { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: var(--spectrum-spacing-300); }
  .chart { display: flex; flex-direction: column; gap: var(--spectrum-spacing-200); min-width: 0; }
  .chart-note { font-size: var(--spectrum-font-size-75); color: var(--spectrum-neutral-subdued-content-color-default); }
  /* Execution time by kind of call: the bar is the average, the thin line the range from the fastest to the slowest */
  .op { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 2px var(--spectrum-spacing-200); font-size: var(--spectrum-font-size-75); }
  .op-label { display: flex; align-items: center; gap: var(--spectrum-spacing-100); min-width: 0; }
  .op-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  /* Number of calls, as a pill next to the name */
  .op-count { flex: none; padding: 1px 8px; border-radius: 999px; background: var(--spectrum-gray-200); color: var(--spectrum-neutral-content-color-default); font-weight: var(--spectrum-bold-font-weight); font-variant-numeric: tabular-nums; }
  /* 429 answers of a kind of call, in the orange of Spectrum notices */
  .op-count.op-429 { background: var(--spectrum-notice-background-color-default, #e68619); color: #ffffff; }
  .op-value { color: var(--spectrum-neutral-subdued-content-color-default); font-variant-numeric: tabular-nums; text-align: right; }
  .op-track { grid-column: 1 / -1; position: relative; height: 10px; }
  .op-range { position: absolute; top: 4px; height: 2px; background: var(--spectrum-gray-400); border-radius: 1px; }
  .op-bar { position: absolute; top: 0; left: 0; height: 10px; min-width: 2px; background: var(--spectrum-accent-background-color-default); border-radius: 0 4px 4px 0; }
  .op:hover .op-bar { background: var(--spectrum-accent-background-color-hover, var(--spectrum-accent-background-color-default)); }
  .day-bars { position: relative; display: flex; align-items: flex-end; gap: 2px; height: 120px; border-bottom: 1px solid var(--spectrum-gray-300); }
  .day-bar { flex: 1; min-width: 2px; max-width: 24px; display: flex; flex-direction: column-reverse; height: 100%; }
  .day-bar span { display: block; background: var(--spectrum-accent-background-color-default); border-radius: 4px 4px 0 0; min-height: 0; }
  .day-bar span.failed { background: var(--spectrum-gray-400); border-radius: 4px 4px 0 0; margin-bottom: 2px; }
  .day-bar span.failed + span { border-radius: 0; }
  .day-bar:hover span:not(.failed) { background: var(--spectrum-accent-background-color-hover, var(--spectrum-accent-background-color-default)); }
  .axis { display: flex; justify-content: space-between; font-size: var(--spectrum-font-size-50, 11px); color: var(--spectrum-neutral-subdued-content-color-default); }
  .legend { display: flex; gap: var(--spectrum-spacing-300); font-size: var(--spectrum-font-size-75); color: var(--spectrum-neutral-subdued-content-color-default); }
  .legend i { display: inline-block; width: 10px; height: 10px; margin-right: 4px; border-radius: 2px; vertical-align: -1px; background: var(--spectrum-accent-background-color-default); }
  .legend i.failed { background: var(--spectrum-gray-400); }
  .table { width: 100%; border-collapse: collapse; font-size: var(--spectrum-font-size-75); font-variant-numeric: tabular-nums; }
  /* Rows of a fixed height: the table shows 10 rows at most, then scrolls under its header */
  .table th { position: sticky; top: 0; background: var(--spectrum-background-layer-2-color); text-align: left; font-weight: var(--spectrum-bold-font-weight); color: var(--spectrum-neutral-subdued-content-color-default); border-bottom: 1px solid var(--spectrum-gray-300); padding: 4px 8px 4px 0; line-height: 20px; }
  .table td { border-bottom: 1px solid var(--spectrum-gray-200); padding: 6px 8px 6px 0; vertical-align: top; line-height: 20px; }
  .table .n { text-align: right; }
  .table-wrap { overflow: auto; max-height: calc(29px + 10 * 33px); }
  .env-badge { margin-left: var(--spectrum-spacing-100); padding: 0 6px; border-radius: 4px; background: var(--spectrum-gray-200); font-size: 11px; font-weight: bold; line-height: 18px; text-transform: uppercase; vertical-align: middle; }
`

// Helpers of the dashboards: durations, averages and stat tiles
const REPORT_SCRIPT = `
  // Name of a kind of call with the number of calls in a pill
  function opLabel(name, count, rateLimited) {
    return '<span class="op-label"><span class="op-name">' + escapeHtml(name) + '</span><span class="op-count">' + count + (count > 1 ? ' calls' : ' call') + '</span>'
      + (rateLimited ? '<span class="op-count op-429" title="Answers 429 (rate limit)">' + rateLimited + ' × 429</span>' : '') + '</span>';
  }
  function seconds(ms) {
    var s = ms / 1000;
    if (s < 60) return (s < 10 ? s.toFixed(1) : Math.round(s)) + ' s';
    return Math.floor(s / 60) + ' min ' + Math.round(s % 60) + ' s';
  }

  function average(list) {
    return list.length ? list.reduce(function (total, ms) { return total + ms; }, 0) / list.length : 0;
  }

  // 429 answers of the API (rate limit) and the delay they caused (the time during which calls waited, those waiting at once
  // counted once), with the sum of the waits of the calls; records without the delay give the sum only
  function rateLimitTile(count, waitMs, delayMs) {
    if (!count && !waitMs) return tileHtml('Rate limit (429)', '0', 'no request refused');
    return tileHtml('Rate limit (429)', String(count || 0), delayMs != null
      ? seconds(delayMs) + ' of delay (' + seconds(waitMs || 0) + ' waited by the calls in all)'
      : seconds(waitMs || 0) + ' waited by the calls in all');
  }
  // Delay caused by the rate limit: the periods of wait of the calls ([start, end]) joined
  function rateLimitDelay(calls) {
    var periods = [];
    calls.forEach(function (c) { (c.waits || []).forEach(function (p) { periods.push(p); }); });
    periods.sort(function (a, b) { return a[0] - b[0]; });
    var total = 0, end = -Infinity;
    periods.forEach(function (p) {
      if (p[1] <= end) return;
      total += p[1] - Math.max(p[0], end);
      end = p[1];
    });
    return total;
  }
  // Same, in the tooltip of a kind of call
  function rateLimitTip(count, waitMs) {
    return count || waitMs ? ', ' + (count || 0) + ' answer(s) 429, ' + seconds(waitMs || 0) + ' waited for the rate limit' : '';
  }

  function tileHtml(label, value, note) {
    return '<div class="tile"><span class="tile-label">' + escapeHtml(label) + '</span><span class="tile-value">' + escapeHtml(value)
      + '</span>' + (note ? '<span class="tile-note">' + escapeHtml(note) + '</span>' : '') + '</div>';
  }

`

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
  .card-name { overflow-wrap: anywhere; }
  /* Languages of a variant side by side: one row per variant, one column per language, scrolled when they do not fit */
  .groups { display: flex; flex-direction: column; gap: var(--spectrum-spacing-400); }
  .group-name { font-weight: var(--spectrum-bold-font-weight); margin-bottom: var(--spectrum-spacing-100); }
  .group-row { display: grid; grid-auto-flow: column; grid-auto-columns: minmax(180px, 1fr); gap: var(--spectrum-spacing-300); overflow-x: auto; padding-bottom: var(--spectrum-spacing-100); }
  /* The name on its own line, the badges (unchanged, template, language) on the line below */
  .card-head { display: flex; flex-wrap: wrap; align-items: center; gap: var(--spectrum-spacing-75) var(--spectrum-spacing-100); min-width: 0; }
  .card-head .card-name { flex: 1 1 100%; min-width: 0; }
  .language { flex: none; padding: 0 6px; border-radius: 4px; background: var(--spectrum-gray-200); font-size: 11px; font-weight: bold; line-height: 18px; text-transform: uppercase; }
  .language.format { flex: 0 1 auto; min-width: 0; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-transform: none; }
  /* A variant of the earlier generation, not generated again */
  /* State of a variant after changes were sent: generated again (Changed) or kept from the earlier generation (Unchanged) */
  .state { flex: none; padding: 0 8px; border-radius: 9px; font-size: 11px; font-weight: bold; line-height: 18px; color: #ffffff; }
  .state.unchanged { background: var(--spectrum-gray-600); }
  .state.changed { background: var(--spectrum-accent-background-color-default); }
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
  /* Texts being checked: a small spinner and a subdued label */
  .checking { display: flex; align-items: center; gap: var(--spectrum-spacing-100); font-size: var(--spectrum-font-size-75);
    color: var(--spectrum-neutral-subdued-content-color-default); }
  .card-warning { color: var(--spectrum-notice-content-color-default, var(--spectrum-negative-content-color-default)); font-size: var(--spectrum-font-size-75); word-break: break-word; }
  /* The enlarged view is drawn over the grid, at the height of the card clicked (the widget is as high as its content, the page
     of the host scrolls): it opens where the user looks, and the card is there again when it closes */
  .stage { position: relative; }
  /* The grid keeps its place under the enlarged view (opacity: the Spectrum buttons do not follow visibility) */
  .stage.enlarged .grid, .stage.enlarged .groups { opacity: 0; pointer-events: none; }
  /* With a host that shows the view full screen, the enlarged view is a modal over the whole screen */
  /* Full screen, the view stops above the message field of the host: the visual is fitted so that the bar, the visual and
     the hint under it fit in its height without scrolling (plus the bottom safe area inset of the host, if any) */
  body.fullscreen .preview.open { position: fixed; inset: 0; top: 0 !important; overflow: auto; padding: var(--spectrum-spacing-400);
    padding-bottom: calc(var(--spectrum-spacing-400) + var(--host-bottom-inset, 0px)); }
  body.fullscreen .preview .visual img { max-height: calc(100vh - 120px - var(--host-bottom-inset, 0px)); }
  body.fullscreen .preview .visual { max-width: calc((100vh - 120px - var(--host-bottom-inset, 0px)) * var(--ratio, 1)) !important; }
  body.fullscreen #edit-hint { text-align: center; }
  body.fullscreen.settling .preview.open { opacity: 0; }
  .preview { display: none; }
  .preview.open { display: block; position: absolute; left: 0; right: 0; z-index: 1; background: var(--spectrum-background-base-color); }
  .preview-bar { display: flex; align-items: center; gap: var(--spectrum-spacing-200); margin-bottom: var(--spectrum-spacing-200); }
  .preview-name { flex: 1; min-width: 0; font-weight: var(--spectrum-bold-font-weight); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .preview .visual img { max-height: 640px; cursor: zoom-out; }
${STEPS_CSS}
  .steps.single { grid-template-columns: 1fr; }
  /* Texts of the variant on its enlarged visual, to click to write a change for them */
  .edit-zone { position: absolute; box-sizing: border-box; border: 1px dashed transparent; border-radius: 2px; cursor: text; }
  .edit-zone:hover { border-color: var(--spectrum-accent-background-color-default); background: rgba(20, 115, 230, 0.08); }
  .card-warning[data-layer] { cursor: pointer; }
  .card-warning[data-layer]:hover { text-decoration: underline; }
${REPORT_CSS}`, `
<h2 class="heading">Generated variants</h2>
<ol class="steps single" aria-label="Step"><li data-for="5" class="current"><span class="step-kicker">Step 5</span><span class="step-title">Review and download</span></li></ol>
<div class="stage" id="stage">
<div class="preview" id="preview">
  <div class="preview-bar">
    <sp-button size="s" variant="secondary" treatment="outline" data-action="back">All variants</sp-button>
    <span class="preview-name" id="preview-name"></span>
    <sp-button size="s" variant="secondary" treatment="outline" data-action="prev">Previous</sp-button>
    <sp-button size="s" variant="secondary" treatment="outline" data-action="next">Next</sp-button>
    <span class="downloads" id="preview-downloads"></span>
  </div>
  <div id="preview-visual"></div>
  <div class="subtle" id="edit-hint" hidden>Click a text on the visual to write a change for it.</div>
</div>
<div class="grid" id="grid"></div>
</div>
<div class="actions" id="fix-actions" hidden>
  <sp-button variant="accent" id="send-changes" disabled>Send changes</sp-button>
  <sp-button variant="secondary" treatment="outline" id="download-all" hidden disabled>Download all</sp-button>
  <sp-button variant="secondary" treatment="outline" id="fullscreen" hidden>Full screen</sp-button>
</div>
<sp-help-text class="status" id="status"></sp-help-text>
<section class="report" id="report" hidden aria-label="Generation report"></section>
`, `
${REPORT_SCRIPT}
  setStatus('Generating variants...', false, true);
  var grid = document.getElementById('grid');
  var preview = document.getElementById('preview');
  var previewVisual = document.getElementById('preview-visual');
  var stage = document.getElementById('stage');
  // Full screen, when the host can show the view so (ui/request-display-mode): the whole widget with the Full screen button, or
  // the enlarged view alone (back inline when it closes, unless the widget was already full screen). Leaving full screen from
  // the host closes the enlarged view.
  appDisplayModes = ['inline', 'fullscreen'];
  var fullscreenBtn = document.getElementById('fullscreen');
  var previewFullscreen = false;
  function isFullscreen() { return document.body.classList.contains('fullscreen'); }
  function setFullscreen(mode) {
    document.body.classList.toggle('fullscreen', mode === 'fullscreen');
    fullscreenBtn.textContent = mode === 'fullscreen' ? 'Exit full screen' : 'Full screen';
    if (mode !== 'fullscreen') { previewFullscreen = false; reportSize(); }
  }
  // While the host changes the size of the view (its animation to full screen), the enlarged view is hidden, shown again (without
  // fading in) as soon as the size no longer changes: the visual, fitted to the height of the view, would be redrawn at each step
  var settleTimer = null;
  function settle() {
    document.body.classList.add('settling');
    clearTimeout(settleTimer);
    settleTimer = setTimeout(function () { document.body.classList.remove('settling'); }, 60);
  }
  window.addEventListener('resize', function () { if (isFullscreen()) settle(); });
  // Full screen is set at once (not inline first, then full screen when the host answers), back as before if the host refuses
  function requestDisplayMode(mode) {
    var before = isFullscreen() ? 'fullscreen' : 'inline';
    if (mode === 'fullscreen') { setFullscreen('fullscreen'); settle(); fitStage(); }
    return request('ui/request-display-mode', { mode: mode })
      .then(function (result) { setFullscreen((result && result.mode) || mode); fitStage(); },
        function () { setFullscreen(before); fitStage(); });
  }
  onHostContextChanged(function (context) {
    if (!context.displayMode) return;
    setFullscreen(context.displayMode);
    if (context.displayMode !== 'fullscreen' && current >= 0) showPreview(-1);
  });
  fullscreenBtn.addEventListener('click', function () { requestDisplayMode(isFullscreen() ? 'inline' : 'fullscreen'); });
  var variants = [];
  var current = -1;
  // Changes of each variant, by file name: pre-filled with the proposed fixes, edited by the user
  var requests = {};
  var busy = false;
  // While the variants of the tool call are generated
  var generating = false;
  var sendBtn = document.getElementById('send-changes');
  var downloadAllBtn = document.getElementById('download-all');
  // Task of the generation, whose files are zipped by Download all
  var generationTaskId = null;
  var zipping = false;
  // Text layers of the template of each variant generated ({ fileName: [{ id, name, area, text, alignment }] }: each template
  // has its own, with several templates), from the review data of the generation, and the texts sent for each variant
  // ({ fileName: [{ layerId, text, fontScale }] }): where to click a text on the visuals
  var textLayersByFile = {};
  var sentTexts = {};
  function textLayersOf(index) { return (variants[index] && textLayersByFile[variants[index].fileName]) || []; }
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
    var style = c ? ' style="aspect-ratio:' + c.width + '/' + c.height + ';--ratio:' + (c.width / c.height).toFixed(4)
      + ';max-width:' + Math.round(maxHeight * c.width / c.height) + 'px"' : '';
    return '<div class="visual"' + style + '><img src="' + escapeHtml(v.imageUrl) + '" alt="' + escapeHtml(v.fileName) + '" data-index="' + index + '">'
      + marks + '</div>';
  }

  // Name of a variant, with its language
  // Changes were sent: the variants of the earlier generation not generated again are shown too
  function hasKept() { return variants.some(function (v) { return v.kept; }); }

  function cardHead(v) {
    return '<div class="card-head"><span class="subtle card-name">' + escapeHtml(v.fileName) + '</span>'
      + (v.kept ? '<span class="state unchanged" title="Not generated again: as in the earlier generation">Unchanged</span>'
        : hasKept() && !v.error ? '<span class="state changed" title="Generated again with the changes sent">Changed</span>' : '')
      + (v.template ? '<span class="language format" title="Template">' + escapeHtml(v.template) + '</span>' : '')
      + (v.language ? '<span class="language">' + escapeHtml(v.language) + '</span>' : '') + '</div>';
  }

  // Card of a variant: being rendered, failed, or its visual with its text problems, its changes and its downloads
  function cardHtml(v, i) {
    if (v.pending) {
      return '<div class="card"><div class="rendering"><sp-progress-circle size="m" indeterminate label="Rendering"></sp-progress-circle>'
        + '<span class="subtle">Rendering...</span></div>' + cardHead(v) + '</div>';
    }
    if (v.error) return '<div class="card">' + cardHead(v) + '<div class="card-error">' + escapeHtml(v.error) + '</div></div>';
    // Text problems found on the generated file, numbered as their marks on the visual
    var problems = (v.textIssues || []).map(function (issue, k) {
      return '<div class="card-warning"' + (clickable(i, issue.layerId) ? ' data-index="' + i + '" data-layer="' + issue.layerId + '" title="Write a change for this text"' : '')
        + '><span class="issue-number">' + (k + 1) + '</span>'
        + escapeHtml('"' + issue.layerName + '" ' + issue.problems.join(', ')) + '</div>';
    }).join('')
      + (v.checking ? '<div class="checking"><sp-progress-circle size="s" indeterminate label="Checking the texts"></sp-progress-circle><span>Checking the texts...</span></div>' : '');
    // Pre-filled once the texts are checked
    if (requests[v.fileName] == null && !v.checking) requests[v.fileName] = v.kept ? '' : recommendationOf(v);
    return '<div class="card">' + visualHtml(v, i, 320)
      + cardHead(v)
      + problems
      + '<textarea class="change-request" data-index="' + i + '" placeholder="What should change?">' + escapeHtml(requests[v.fileName] || '') + '</textarea>'
      + '<div class="downloads">' + downloadButtons(i, 'secondary') + '</div></div>';
  }

  function render() {
    // The field being typed in keeps its focus and caret when the grid is drawn again (variants arrive while the user types)
    var active = document.activeElement && document.activeElement.classList.contains('change-request')
      ? { index: document.activeElement.getAttribute('data-index'), start: document.activeElement.selectionStart, end: document.activeElement.selectionEnd }
      : null;
    // The languages and formats (templates) of each variant side by side, when there are several
    var groups = [];
    variants.forEach(function (v, i) {
      var name = v.group || v.fileName;
      var group = groups.filter(function (g) { return g.name === name; })[0];
      if (!group) groups.push(group = { name: name, indexes: [] });
      group.indexes.push(i);
    });
    var sideBySide = groups.some(function (g) { return g.indexes.length > 1; });
    grid.className = sideBySide ? 'groups' : 'grid';
    grid.innerHTML = sideBySide
      ? groups.map(function (g) {
        return '<div><div class="group-name">' + escapeHtml(g.name) + '</div><div class="group-row">'
          + g.indexes.map(function (i) { return cardHtml(variants[i], i); }).join('') + '</div></div>';
      }).join('')
      : variants.map(cardHtml).join('');
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

  // Fixes proposed by the assistant for the texts of a variant, as pre-filled in its changes
  function recommendationOf(v) {
    return (v.textIssues || []).map(function (issue) { return issue.fix || ''; }).filter(Boolean).join('\\n');
  }

  // Changes of a variant, '' if none
  function requestOf(v) { return (requests[v.fileName] || '').trim(); }

  function updateFixActions() {
    var count = variants.filter(function (v) { return !v.error && requestOf(v); }).length;
    sendBtn.textContent = count ? 'Send changes (' + count + ')' : 'Send changes';
    // Changes are sent once the generation is done, so that the next one does not start meanwhile
    sendBtn.disabled = busy || generating || !count;
    // All the files of the generation in one ZIP archive, once it is done
    var files = generated().reduce(function (total, i) { return total + filesOf(variants[i]).length; }, 0);
    downloadAllBtn.hidden = !generationTaskId || files < 2;
    downloadAllBtn.disabled = generating || zipping;
    fullscreenBtn.hidden = !canFullscreen();
  }

  function downloadAll() {
    zipping = true;
    updateFixActions();
    setStatus('Preparing the ZIP archive...', false, true);
    callTool('create-variants-zip', { taskId: generationTaskId })
      .then(function (started) { return waitForTask(started.taskId); })
      .then(function (zip) {
        render();
        return request('ui/open-link', { url: zip.url });
      })
      .catch(function (error) { setStatus((error && error.message) || String(error), true); })
      .then(function () { zipping = false; updateFixActions(); });
  }

  downloadAllBtn.addEventListener('click', downloadAll);

  // Sends the changes of the variants to the model, which generates them again with create-variant. With the problems found
  // in each text (layer id and name), so that it finds the layers named in the changes.
  function sendChanges() {
    // Claude answers in the conversation, with a new widget: shown once out of full screen
    if (isFullscreen()) {
      if (current >= 0) showPreview(-1);
      if (isFullscreen()) { setFullscreen('inline'); request('ui/request-display-mode', { mode: 'inline' }).catch(function () {}); }
    }
    var toChange = variants.filter(function (v) { return !v.error && requestOf(v); });
    var changes = toChange.map(function (v) {
      return {
        fileName: v.fileName,
        change: requestOf(v),
        // To find the layer of each text named in the change; the fixes proposed are in the change only if the user kept them
        texts: (v.textIssues || []).map(function (issue) { return { layerId: issue.layerId, layerName: issue.layerName, problems: issue.problems }; })
      };
    });
    var context = 'Changes requested by the user in the create-variant widget, one per variant. Make exactly the changes written in '
      + '"change", nothing else: change the font size of a text only when the change asks for it ("Reduce the font size of X to N%" is '
      + 'fontScale N/100); to change the words of a text (shorter, longer, other words), rewrite it as asked and keep its fontScale as '
      + 'before. "texts" gives the layer id of the texts by name. Then call create-variant ONCE with these variants only, with the same '
      + 'file names and the same edits as before except the changes, and previousTaskId "' + generationTaskId + '" (its widget also shows '
      + 'the other variants, unchanged). If a change is unclear, ask the user first.\\n' + JSON.stringify(changes);
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

  // Enlarged view of one variant inside the widget, over the grid at the height of its card (kept while going to the previous
  // or next one); index -1 goes back to the grid.
  function showPreview(index) {
    var wasOpen = current >= 0;
    current = index;
    var open = index >= 0;
    if (open && !wasOpen) {
      var image = grid.querySelector('img[data-index="' + index + '"]');
      var card = image && image.closest('.card');
      preview.style.top = Math.max(0, card ? card.getBoundingClientRect().top - stage.getBoundingClientRect().top : 0) + 'px';
      if (canFullscreen() && !isFullscreen()) {
        previewFullscreen = true;
        requestDisplayMode('fullscreen');
      }
    }
    if (!open && wasOpen && previewFullscreen && isFullscreen()) {
      setFullscreen('inline');
      request('ui/request-display-mode', { mode: 'inline' }).catch(function () {});
    }
    preview.classList.toggle('open', open);
    stage.classList.toggle('enlarged', open);
    if (!open) stage.style.minHeight = '';
    if (open) {
      previewVisual.innerHTML = visualHtml(variants[index], index, 640);
      addEditZones(index);
      var list = generated();
      document.getElementById('preview-name').textContent = variants[index].fileName + ' (' + (list.indexOf(index) + 1) + '/' + list.length + ')';
      document.getElementById('preview-downloads').innerHTML = downloadButtons(index, 'accent');
      fitStage();
    }
    reportSize();
  }

  // The widget as high as the enlarged view, when it goes past the grid
  function fitStage() {
    if (current < 0 || document.body.classList.contains('fullscreen')) { stage.style.minHeight = ''; return; }
    stage.style.minHeight = (parseFloat(preview.style.top) + preview.offsetHeight) + 'px';
    reportSize();
  }

  // Text sent for a layer of a variant ({ layerId, text, fontScale }), undefined for a text left as in the template or a variant
  // unchanged from an earlier generation
  function sentText(index, layerId) {
    return (sentTexts[variants[index].fileName] || []).filter(function (t) { return t.layerId === layerId; })[0];
  }

  // A text of a variant can be clicked, to write a change for it, when the layer is known and the variant shown
  function clickable(index, layerId) {
    var v = variants[index];
    return Boolean(v && !v.pending && !v.error && v.canvas && textLayersOf(index).some(function (l) { return l.id === layerId; }));
  }

  function linesOf(text) { return String(text || '').split(/\\r\\n|\\r|\\n/); }
  function longestLine(lines) { return Math.max.apply(null, lines.map(function (line) { return line.trim().length; })); }

  // Where the text of a variant is drawn, estimated from the layer in the template: a point text grows from its alignment,
  // as wide as its longest line and as high as its lines, at its font scale. A text without line breaks for a template text
  // on several lines is spread over as many lines. Joined with the box of the text found by the review, and never smaller
  // than the layer in the template.
  function textArea(v, layer, edit) {
    var a = layer.area, c = v.canvas;
    var left = a.left, top = a.top, right = a.left + a.width, bottom = a.top + a.height;
    var before = linesOf(layer.text), after = linesOf(edit ? edit.text : layer.text);
    if (layer.text != null && longestLine(before) > 0) {
      var lineCount = after.length === 1 && before.length > 1 ? before.length : after.length;
      var longest = after.length === 1 && before.length > 1 ? Math.ceil(after[0].trim().length / before.length) : longestLine(after);
      var scale = (edit && edit.fontScale) || 1;
      var width = Math.max(a.width, a.width * longest / longestLine(before) * scale);
      var height = Math.max(a.height, a.height * lineCount / before.length * scale);
      var align = String(layer.alignment || 'left');
      left = align === 'center' ? a.left + (a.width - width) / 2 : align === 'right' ? a.left + a.width - width : a.left;
      right = left + width;
      bottom = top + height;
    }
    (v.textIssues || []).forEach(function (issue) {
      if (String(issue.layerId) !== String(layer.id) || !issue.area) return;
      left = Math.min(left, issue.area.left);
      top = Math.min(top, issue.area.top);
      right = Math.max(right, issue.area.left + issue.area.width);
      bottom = Math.max(bottom, issue.area.top + issue.area.height);
    });
    left = Math.max(0, left); top = Math.max(0, top);
    right = Math.min(c.width, right); bottom = Math.min(c.height, bottom);
    return { left: left, top: top, width: right - left, height: bottom - top };
  }

  // The texts of the variant, as zones over its enlarged visual (where the text is drawn, estimated), to click to write a change
  function addEditZones(index) {
    var v = variants[index];
    var box = previewVisual.querySelector('.visual');
    var zones = textLayersOf(index).filter(function (l) { return l.area && clickable(index, l.id); });
    document.getElementById('edit-hint').hidden = !zones.length;
    if (!box) return;
    zones.forEach(function (l) {
      var a = textArea(v, l, sentText(index, l.id)), c = v.canvas;
      var zone = document.createElement('div');
      zone.className = 'edit-zone';
      zone.setAttribute('data-layer', l.id);
      zone.title = 'Write a change for "' + l.name + '"';
      zone.style.cssText = 'left:' + a.left / c.width * 100 + '%;top:' + a.top / c.height * 100 + '%;width:'
        + a.width / c.width * 100 + '%;height:' + a.height / c.height * 100 + '%';
      box.appendChild(zone);
    });
  }

  // Shortcut to write a change for a text: back to the grid, in the changes of its variant, on a line starting with the name of
  // its layer (added unless there already), the caret after it
  function writeChange(index, layerId) {
    var v = variants[index];
    var layer = textLayersOf(index).filter(function (l) { return l.id === layerId; })[0];
    if (!v || !layer) return;
    showPreview(-1);
    var prefix = '"' + layer.name + '": ';
    var text = requests[v.fileName] != null ? requests[v.fileName] : (v.kept ? '' : recommendationOf(v));
    if (text.indexOf(prefix) < 0) text = (text.replace(/\\s+$/, '') ? text.replace(/\\s+$/, '') + '\\n' : '') + prefix;
    requests[v.fileName] = text;
    render();
    var field = grid.querySelector('.change-request[data-index="' + index + '"]');
    if (!field) return;
    var caret = text.indexOf(prefix) + prefix.length;
    field.focus();
    field.setSelectionRange(caret, caret);
    field.scrollIntoView({ block: 'center' });
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
    var issue = e.target.closest('.card-warning[data-layer]');
    if (issue) return writeChange(Number(issue.getAttribute('data-index')), Number(issue.getAttribute('data-layer')));
    var target = e.target.closest('img, sp-button');
    if (!target || !target.hasAttribute('data-index')) return;
    var index = Number(target.getAttribute('data-index'));
    if (target.tagName === 'IMG') showPreview(index);
    else download(target);
  });

  preview.addEventListener('click', function (e) {
    var zone = e.target.closest('.edit-zone');
    if (zone) return writeChange(current, Number(zone.getAttribute('data-layer')));
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
  preview.addEventListener('load', fitStage, true);
  // Escape closes the enlarged view, or else leaves full screen
  document.addEventListener('keydown', function (e) {
    if (current < 0) {
      if (e.key === 'Escape' && isFullscreen()) requestDisplayMode('inline');
      return;
    }
    if (e.key === 'Escape') showPreview(-1);
    else if (e.key === 'ArrowLeft') step(-1);
    else if (e.key === 'ArrowRight') step(1);
  });


  // Report of the last generation (its task result): variants generated, and the API calls since the template
  // was imported, with their execution times by kind
  var reportEl = document.getElementById('report');

  function showReport(report) {
    if (!report) return;
    var calls = report.calls || [];
    var isRender = function (c) { return c.operation === 'Variant render'; };
    var allRenders = calls.filter(function (c) { return isRender(c) && c.ok; }).map(function (c) { return c.ms; });
    var ownRenders = calls.filter(function (c) { return c.generation && isRender(c) && c.ok; }).map(function (c) { return c.ms; });
    var requests = calls.reduce(function (total, c) { return total + (c.requests || 0); }, 0);
    var rateLimited = calls.reduce(function (total, c) { return total + (c.rateLimited || 0); }, 0);
    var waitMs = calls.reduce(function (total, c) { return total + (c.waitMs || 0); }, 0);
    var since = report.sinceImport ? 'since the template was imported' : 'of this generation';

    // Kinds of calls, in the order of their first call
    var kinds = [];
    calls.forEach(function (c) {
      var kind = kinds.filter(function (k) { return k.name === c.operation; })[0];
      if (!kind) kinds.push(kind = { name: c.operation, api: c.api, times: [], failed: 0, rateLimited: 0, waitMs: 0 });
      if (c.ok) kind.times.push(c.ms); else kind.failed++;
      kind.rateLimited += c.rateLimited || 0;
      kind.waitMs += c.waitMs || 0;
    });
    var longest = Math.max.apply(null, [1].concat(calls.map(function (c) { return c.ms || 0; })));
    var opsHtml = kinds.map(function (k) {
      var count = k.times.length + k.failed;
      var min = k.times.length ? Math.min.apply(null, k.times) : 0, max = k.times.length ? Math.max.apply(null, k.times) : 0;
      var tip = k.api + ': ' + count + ' call(s), average ' + seconds(average(k.times)) + ', from ' + seconds(min) + ' to ' + seconds(max)
        + (k.failed ? ', ' + k.failed + ' failed' : '') + rateLimitTip(k.rateLimited, k.waitMs);
      return '<div class="op" title="' + escapeHtml(tip) + '">' + opLabel(k.name, count, k.rateLimited)
        + '<span class="op-value">' + (k.times.length ? 'avg ' + seconds(average(k.times)) : 'failed') + '</span>'
        + '<div class="op-track"><span class="op-range" style="left:' + (min / longest * 100) + '%;width:' + ((max - min) / longest * 100) + '%"></span>'
        + '<span class="op-bar" style="width:' + (average(k.times) / longest * 100) + '%"></span></div></div>';
    }).join('');

    reportEl.innerHTML = '<div class="report-title">Report of the last generation</div><div class="tiles">'
      + tileHtml('Variants generated', String(report.variants), report.failed ? report.failed + ' failed' : '')
      + tileHtml('API calls', String(calls.length), since + ', ' + requests + ' requests with the status checks')
      + (ownRenders.length ? tileHtml('Average render', seconds(average(ownRenders)), seconds(average(allRenders)) + ' ' + since) : '')
      + rateLimitTile(rateLimited, waitMs, calls.some(function (c) { return c.waits; }) ? rateLimitDelay(calls) : null)
      + '</div>'
      + (calls.length ? '<div class="charts"><div class="chart"><span class="chart-title">Execution time by call</span>' + opsHtml
        + '<span class="chart-note">Bar: average time; line: from the fastest to the slowest call</span></div></div>' : '');
    reportEl.hidden = false;
  }

  // Texts checked by the assistant (review-variants, report-variant-issues), which create-variant tells to do it in the same
  // turn: once the generation is done, the widget waits for the problems it reports (get-variant-review) and shows them
  var REVIEW_POLL_MS = 3000;
  var REVIEW_WAIT_MS = 5 * 60 * 1000;
  // A generation done longer ago than this (e.g. the conversation opened again) is not waited for: its review will not come
  var REVIEW_WAIT_WITHIN_MS = 2 * 60 * 1000;
  var polling = false;

  function setChecking(checking) {
    variants = variants.map(function (v) { return v.error || v.pending || v.kept ? v : Object.assign({}, v, { checking: checking }); });
    render();
  }

  // Applies the problems reported so far; true when every variant generated has been reviewed
  function applyReview(issues) {
    var done = true;
    variants = variants.map(function (v) {
      if (v.error || v.pending || v.kept) return v;
      if (!issues[v.fileName]) { done = false; return v; }
      // Pre-filled again with the fixes proposed, unless the user has written changes
      if (!requestOf(v)) delete requests[v.fileName];
      return Object.assign({}, v, { checking: false, textIssues: issues[v.fileName] });
    });
    render();
    return done;
  }

  function waitForReview(taskId) {
    if (polling) return;
    polling = true;
    setChecking(true);
    var started = Date.now();
    function poll() {
      callTool('get-variant-review', { taskId: taskId }).then(function (review) {
        if (review.reviewed && applyReview(review.issues)) { polling = false; return; }
        if (Date.now() - started > REVIEW_WAIT_MS) {
          polling = false;
          setChecking(false);
          return setStatus('The texts were not checked: look at the visuals.', true);
        }
        setTimeout(poll, REVIEW_POLL_MS);
      }, function () {
        if (Date.now() - started > REVIEW_WAIT_MS) { polling = false; setChecking(false); return; }
        setTimeout(poll, REVIEW_POLL_MS);
      });
    }
    poll();
  }

  function startReview(generation) {
    return callTool('get-variant-review', { taskId: generationTaskId }).then(function (review) {
      if (review.reviewed && applyReview(review.issues)) return;
      if (Date.now() - (generation.doneAt || 0) < REVIEW_WAIT_WITHIN_MS) waitForReview(generationTaskId);
    }, function () {});
  }

  // The variants are generated in a task: shown as they are rendered, then checked; when all are done, the model is given
  // the result (failures, warnings), and the texts are checked.
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
    generationTaskId = data.taskId;
    // Variants of the earlier generation not generated again, in its order with the new ones
    var kept = data.kept || [];
    var withKept = function (list) {
      if (!kept.length) return list;
      var all = kept.concat(list);
      var at = function (v) { var i = (data.order || []).indexOf(v.fileName); return i < 0 ? all.length : i; };
      return all.slice().sort(function (a, b) { return at(a) - at(b); });
    };
    variants = withKept((data.pending || []).map(function (fileName, i) {
      return Object.assign({ fileName: fileName, pending: true }, (data.labels || [])[i]);
    }));
    render();
    waitForTask(data.taskId, function (partial) {
      if (partial.variants) variants = withKept(partial.variants);
      render();
    })
      .then(function (generation) {
        generating = false;
        variants = generation.variants ? withKept(generation.variants) : variants;
        var review = generation.review || {};
        var isText = function (l) { return l.type === 'text_layer'; };
        textLayersByFile = {};
        sentTexts = {};
        (generation.variants || []).forEach(function (v, i) {
          var set = review.layerSets ? review.layerSets[review.layerSet[i]] : review.layers;
          textLayersByFile[v.fileName] = (set || []).filter(isText);
          sentTexts[v.fileName] = (review.texts || [])[i] || [];
        });
        render();
        showReport(generation.report);
        if (generation.review) return startReview(generation);
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

// Dashboard of the usage of the service (get-usage-history for the user, get-usage-report for all the users): totals, the
// variants per day, the execution time by kind of API call, and the latest generations or the users.
function getUsageViewHtml (scriptUrl) {
  return page(scriptUrl, 'Usage', `
${REPORT_CSS}
  .report { margin-top: var(--spectrum-spacing-200); }
`, `
<h2 class="heading" id="title">Usage</h2>
<div class="subtle" id="period"></div>
<div class="subtle" id="user-id" hidden></div>
<section class="report" id="report" hidden aria-label="Usage"></section>
<sp-help-text class="status" id="status"></sp-help-text>
`, `
${REPORT_SCRIPT}
  setStatus('Loading the usage...', false, true);
  var reportEl = document.getElementById('report');
  var DAY_MS = 86400000;

  function dateTime(iso) {
    return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  }

  function dayLabel(day) {
    return new Date(day + 'T00:00:00Z').toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' });
  }

  // Bars of the variants per day, from the first day of the period (or of the activity) to today; per month beyond 120 days
  function perDayHtml(data) {
    var byDay = {};
    (data.perDay || []).forEach(function (d) { byDay[d.day] = d; });
    var today = new Date().toISOString().slice(0, 10);
    var first = data.days ? new Date(Date.now() - (data.days - 1) * DAY_MS).toISOString().slice(0, 10) : ((data.perDay || [])[0] || {}).day;
    if (!first) return '';
    var buckets = [];
    for (var t = Date.parse(first + 'T00:00:00Z'); t <= Date.parse(today + 'T00:00:00Z'); t += DAY_MS) {
      var day = new Date(t).toISOString().slice(0, 10);
      buckets.push({ key: day, label: dayLabel(day), d: byDay[day] });
    }
    var monthly = buckets.length > 120;
    if (monthly) {
      var months = {};
      buckets.forEach(function (b) {
        var key = b.key.slice(0, 7);
        var m = months[key] = months[key] || { key: key, label: new Date(key + '-01T00:00:00Z').toLocaleDateString(undefined, { month: 'short', year: 'numeric', timeZone: 'UTC' }), d: { variants: 0, failed: 0, generations: 0 } };
        if (b.d) { m.d.variants += b.d.variants; m.d.failed += b.d.failed; m.d.generations += b.d.generations; }
      });
      buckets = Object.keys(months).sort().map(function (key) { return months[key]; });
    }
    var top = Math.max.apply(null, [1].concat(buckets.map(function (b) { return b.d ? b.d.variants + b.d.failed : 0; })));
    var anyFailed = buckets.some(function (b) { return b.d && b.d.failed; });
    var bars = buckets.map(function (b) {
      var ok = b.d ? b.d.variants : 0, failed = b.d ? b.d.failed : 0, generations = b.d ? b.d.generations : 0;
      var tip = b.label + ': ' + ok + ' variant(s)' + (failed ? ', ' + failed + ' failed' : '') + ', ' + generations + ' generation(s)';
      return '<div class="day-bar" title="' + escapeHtml(tip) + '">'
        + (ok ? '<span style="height:' + (ok / top * 100) + '%"></span>' : '')
        + (failed ? '<span class="failed" style="height:' + (failed / top * 100) + '%"></span>' : '') + '</div>';
    }).join('');
    return '<div class="chart"><span class="chart-title">Variants per ' + (monthly ? 'month' : 'day') + '</span>'
      + '<div class="day-bars">' + bars + '</div>'
      + '<div class="axis"><span>' + escapeHtml(buckets[0].label) + '</span>'
      + (buckets.length > 1 ? '<span>' + escapeHtml(buckets[buckets.length - 1].label) + '</span>' : '') + '</div>'
      + (anyFailed ? '<div class="legend"><span><i></i>Generated</span><span><i class="failed"></i>Failed</span></div>' : '')
      + '</div>';
  }

  // Average execution time of each kind of API call
  function operationsHtml(apiCalls) {
    if (!apiCalls || !apiCalls.length) return '';
    var longest = Math.max.apply(null, [1].concat(apiCalls.map(function (op) { return op.averageMs || 0; })));
    return '<div class="chart"><span class="chart-title">Execution time by call</span>' + apiCalls.map(function (op) {
      var tip = op.api + ': ' + op.count + ' call(s)' + (op.failed ? ', ' + op.failed + ' failed' : '') + ', ' + op.requests + ' requests with the status checks' + rateLimitTip(op.rateLimited, op.waitMs);
      return '<div class="op" title="' + escapeHtml(tip) + '">' + opLabel(op.operation, op.count, op.rateLimited)
        + '<span class="op-value">' + (op.averageMs != null ? 'avg ' + seconds(op.averageMs) : 'failed') + '</span>'
        + '<div class="op-track"><span class="op-bar" style="width:' + ((op.averageMs || 0) / longest * 100) + '%"></span></div></div>';
    }).join('') + '<span class="chart-note">Bar: average time of a call</span></div>';
  }

  // 429 answers of a row, with the time waited
  function rateLimitCell(row) {
    return row.rateLimited ? row.rateLimited + ' (' + seconds(row.rateLimitDelayMs || row.waitMs || 0) + ')' : '0';
  }

  function tableHtml(title, head, rows) {
    if (!rows.length) return '';
    return '<div class="chart"><span class="chart-title">' + escapeHtml(title) + '</span><div class="table-wrap"><table class="table"><thead><tr>'
      + head.map(function (h) { return '<th' + (h.n ? ' class="n"' : '') + '>' + escapeHtml(h.label) + '</th>'; }).join('')
      + '</tr></thead><tbody>' + rows.map(function (row) {
        return '<tr>' + row.map(function (cell, i) { return '<td' + (head[i].n ? ' class="n"' : '') + '>' + escapeHtml(cell == null ? '' : String(cell)) + '</td>'; }).join('') + '</tr>';
      }).join('') + '</tbody></table></div></div>';
  }

  function show(data) {
    var all = data.scope === 'all';
    var totals = data.totals || {};
    document.getElementById('title').innerHTML = escapeHtml(all ? 'Usage of all the users' : 'My usage')
      + (data.env ? '<span class="env-badge">' + escapeHtml(data.env) + '</span>' : '');
    var firstDay = ((data.perDay || [])[0] || {}).day;
    if (data.userId) {
      var userIdEl = document.getElementById('user-id');
      userIdEl.textContent = 'IMS user id: ' + data.userId;
      userIdEl.hidden = false;
    }
    document.getElementById('period').textContent = data.days ? 'Last ' + data.days + ' days' : 'Whole history' + (firstDay ? ', since ' + dayLabel(firstDay) : '');
    if (!totals.generations && !totals.apiCalls) {
      setStatus('No activity over this period.');
      return;
    }
    var table = all
      ? tableHtml('Users', [{ label: 'User' }, { label: 'Generations', n: true }, { label: 'Variants', n: true }, { label: 'Failed', n: true }, { label: 'API calls', n: true }, { label: '429', n: true }, { label: 'Avg render', n: true }, { label: 'Last activity' }],
        (data.users || []).map(function (u) {
          return [u.user, u.generations, u.variants, u.failed, u.apiCalls, rateLimitCell(u), u.averageRenderMs != null ? seconds(u.averageRenderMs) : '', dateTime(u.lastActivity)];
        }))
      : tableHtml('Latest generations', [{ label: 'Date' }, { label: 'Template' }, { label: 'Variants', n: true }, { label: 'Failed', n: true }, { label: '429', n: true }, { label: 'Avg render', n: true }, { label: 'Formats' }, { label: 'Languages' }],
        (data.generations || []).map(function (g) {
          return [dateTime(g.at), g.template || '', g.variants, g.failed, rateLimitCell(g), g.averageRenderMs != null ? seconds(g.averageRenderMs) : '',
            (g.formats || []).join(', ').toUpperCase(), (g.languages || []).join(', ').toUpperCase()];
        }));
    reportEl.innerHTML = '<div class="tiles">'
      + (all ? tileHtml('Users', String(totals.users), '') : '')
      + tileHtml('Generations', String(totals.generations), '')
      + tileHtml('Variants generated', String(totals.variants), totals.failed ? totals.failed + ' failed' : '')
      + tileHtml('API calls', String(totals.apiCalls), totals.requests + ' requests with the status checks')
      + (totals.averageRenderMs != null ? tileHtml('Average render', seconds(totals.averageRenderMs), '') : '')
      + rateLimitTile(totals.rateLimited, totals.waitMs, totals.rateLimitDelayMs || null)
      + '</div>' + perDayHtml(data) + operationsHtml(data.apiCalls) + table;
    reportEl.hidden = false;
    setStatus('');
  }

  onToolResult(function (result) {
    if (result.isError) {
      setStatus(result.content && result.content[0] ? result.content[0].text : 'Error', true);
      return;
    }
    show(result.structuredContent || {});
  });
`)
}

module.exports = { getStartViewHtml, getUploadViewHtml, getVariantImagesViewHtml, getLayersViewHtml, getTextsViewHtml, getVariantViewHtml, getUsageViewHtml }
