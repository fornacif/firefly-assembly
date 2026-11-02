# Firefly Assembly

MCP server, deployed as an Adobe I/O Runtime (App Builder) action, that creates variants of a Photoshop PSD template with the Photoshop API: versions, adaptations or localizations of a banner, ad, visual or social post. The workflow runs in Claude or ChatGPT through interactive widgets (MCP Apps).

## Workflow

1. **Start** (`start-variant-creation`): number of variants (up to 10) and PSD template, uploaded from the computer or picked in AEM Assets.
2. **Layers** (`get-psd-manifest`): the template preview with its editable layers (text and smart object layers); the user picks the ones to change.
3. **Texts** (`review-variant-texts`): an editable table with the texts of each variant.
4. **Images** (`upload-variant-images`): a grid with one image per variant and smart object layer, from the computer or AEM, with crops framed on the subject.
5. **Generation** (`create-variant`): the variants are rendered in parallel, as JPEG (default), PNG and/or layered PSD files.
6. **Review**: the widget checks the texts of each variant (see below) and marks their problems on the visual, numbered, with a proposed fix (a smaller font size). Each variant has a "What should change?" field, pre-filled with the proposed fixes; the user edits it and sends the changes to the assistant, which generates again only these variants. Each generation shows only its own variants.

Widgets return what the user confirmed through a short reference that the assistant reads with `get-widget-result`. The other tools (`save-widget-result`, `suggest-crop`, `create-upload-url`, AEM picker tools…) are used by the widgets. `upload-file` uploads a single file outside the workflow.

## Long operations

Adobe I/O Runtime ends a web request after about 60 seconds, and Photoshop jobs on large files can take longer. The operations that run Photoshop jobs (reading a template and rendering its preview, framing an image, generating variants) run as tasks: the tool starts an activation of the same action without waiting for it (5 minutes, the action timeout), signed with a secret of the action, and answers at once with a task id. The task writes its progress and result in App Builder state; the widgets poll `get-task` and show what is ready: the layers then the preview, each variant as soon as it is rendered then its text checks. `get-psd-manifest` still waits up to 50 seconds for the layers, as the assistant needs them.

## Text checks

Each edited text of a generated variant is checked once rendered, one check per cause:

| Check | How | Finds |
|---|---|---|
| Edges | Bounds of the text in the manifest of the rendered PSD | A text past an edge of the canvas |
| Overlaps | Bounds of the text and of the other visible layers, compared with the template | A text overlapping an element (logo, button, other text) more than in the template. Backgrounds and the elements the text lies on in the template are by design and not reported |
| Words (OCR) | The text area of the rendered visual read with Tesseract (`actions/mcp-server/ocr.js`) as one block of text, and compared with the text sent | Words missing (cut, hidden, unreadable), or broken across two lines by a paragraph box too narrow for them |

The visual is read first, on the area of each text in the template: when every text is read whole inside its area, the texts have not grown, so they cannot pass an edge or overlap an element, and the rendered PSD is not read (one Photoshop job less per variant). Otherwise its manifest gives the exact cause, the area to mark and the font scale. The OCR is only reported for a text without an edge or overlap problem, as missing words are then a consequence of it. It reads the Latin script only (English model, accents and case ignored): texts in other scripts are not read. Its model is downloaded once per container from the jsDelivr CDN; if it cannot be, the variants are generated without this check.

Every check is best effort: a generation answers within about 50 seconds (Adobe I/O Runtime ends web requests after about 60 seconds), and checks not done by then are skipped.

## Best practices for templates

- **Use point text, not paragraph text**, for the texts to vary. A paragraph text keeps its box: a longer text is hidden past its last line or has its words broken across lines. A point text only breaks lines where its text does, and grows from its anchor, which the edge and overlap checks measure.
- **Align the texts from the side they should grow from**: centered texts grow on both sides, left-aligned texts to the right.
- **Leave room around the texts** that will be translated or rewritten: localized texts are often longer.
- **Keep each element in its own layer** (logo, button, badge), not merged into a background: the overlap check compares layers.
- **Use smart object layers for the images to replace**, with the frame of the image at the size it should fill: images are cropped to the ratio of their frame.
- **Do not lock the layers to vary**: locked layers are not offered in the layer picker.
- **Name the layers** (e.g. "headline", "cta"): the names are shown to the user and to the assistant.
- **Break the lines of the original texts where they should be**: the assistant writes the new texts with the same number of lines and about the same number of characters per line. A new text written without any line break is spread over as many lines as the original text, of balanced lengths, without breaking words; a text with line breaks is kept as written.
- **Avoid texts on busy areas of an image**: they are hard to read, and the OCR reports them as such.

## Authentication

- **Users** sign in with Adobe IMS. The action serves the OAuth protected resource metadata (RFC 9728) at `/.well-known/oauth-protected-resource` and validates the bearer token of each MCP request against IMS (`actions/mcp-server/validator.js`). The MCP client (Claude, ChatGPT) registers its own OAuth client with IMS, so no client ID is needed in the connector settings.
- **Photoshop API** calls use Firefly Services server-to-server credentials.

## Project structure

| Path | Content |
|---|---|
| `actions/mcp-server/index.js` | Action entry point: HTTP routing, OAuth metadata, MCP transport |
| `actions/mcp-server/tools.js` | MCP tools, resources and prompt, Photoshop API and storage calls |
| `actions/mcp-server/views.js` | HTML of the widgets |
| `actions/mcp-server/ocr.js` | Reading of the texts of the rendered visuals (Tesseract, WebAssembly) |
| `actions/mcp-server/aem-picker.js` | Sessions of the AEM Asset Selector page |
| `actions/mcp-server/validator.js` | IMS token validation |
| `ui/` | Build of the Spectrum Web Components bundle used by the widgets |
| `web-src/` | Static files served by App Builder (AEM picker page, Spectrum bundle) |
| `app.config.yaml` | App Builder configuration: action, inputs, static hosting |

## Configuration

Create a `.env` file at the root (it is not committed):

```sh
## Adobe I/O Runtime credentials
AIO_runtime_auth=
AIO_runtime_namespace=
AIO_runtime_apihost=
## Firefly Services server-to-server credentials used to call the Photoshop API
FIREFLY_SERVICES_API_CLIENT_ID=
FIREFLY_SERVICES_API_CLIENT_SECRET=
FIREFLY_SERVICES_API_SCOPES=
## AEM Assets (optional) - repository browsed with the Asset Selector
# One repository (e.g. author-p12345-e67890.adobeaemcloud.com), several comma-separated,
# or '*' for any AEM as a Cloud Service repository of the user. Empty: local uploads only.
AEM_REPOSITORY_ID=
# delivery (default, approved assets) or author
AEM_TIER=
```

Optional action parameters, with their defaults: `IMS_HOST` (`https://ims-na1.adobelogin.com`), `IMS_SCOPES` (`openid,AdobeID`), `MCP_RESOURCE_URL` (the `adobeioruntime.net` URL of the action), `STATIC_ORIGIN` (`https://<namespace>.adobeio-static.net`), `AEM_IMS_ORG` (picked by the user), `AEM_API_KEY` (the client ID of the user's token).

## Deployment

Requires Node.js 20 and the [Adobe I/O CLI](https://developer.adobe.com/app-builder/docs/guides/runtime_guides/tools/cli-install) (`aio`).

```sh
npm install
npm run deploy      # aio app deploy: builds the Spectrum bundle, deploys the action and the static files
npm run undeploy
```

The MCP server is then served at:

```
https://<namespace>.adobeioruntime.net/api/v1/web/firefly-assembly/mcp-server
```

## Connecting an assistant

The server works with any MCP client that supports MCP Apps and OAuth, such as Claude and ChatGPT.

- **Claude**: add a custom connector with the URL above.
- **ChatGPT**: add the server as a custom app (connector) with the URL above and OAuth authentication.

In both cases, use the `adobeioruntime.net` domain, not `adobeio-static.net`: the resource in the OAuth metadata must match the server URL, otherwise sign-in fails (in Claude: "Couldn't register with … sign-in service"). Leave the OAuth client ID empty.
