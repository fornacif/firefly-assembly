# Firefly Assembly

MCP server, deployed as an Adobe I/O Runtime (App Builder) action, that creates variants of a Photoshop PSD template with the Photoshop API: versions, adaptations or localizations of a banner, ad, visual or social post. The workflow runs in Claude or ChatGPT through interactive widgets (MCP Apps).

## Workflow

1. **Start** (`start-variant-creation`): number of variants (up to 10) and PSD template, uploaded from the computer or picked in AEM Assets.
2. **Layers** (`get-psd-manifest`): the template preview with its editable layers (text and smart object layers); the user picks the ones to change.
3. **Texts** (`review-variant-texts`): an editable table with the texts of each variant.
4. **Images** (`upload-variant-images`): a grid with one image per variant and smart object layer, from the computer or AEM, with crops framed on the subject.
5. **Generation** (`create-variant`): the variants are rendered in parallel, as JPEG (default), PNG and/or layered PSD files.

Widgets return what the user confirmed through a short reference that the assistant reads with `get-widget-result`. The other tools (`save-widget-result`, `suggest-crop`, `create-upload-url`, AEM picker tools…) are used by the widgets. `upload-file` uploads a single file outside the workflow.

## Authentication

- **Users** sign in with Adobe IMS. The action serves the OAuth protected resource metadata (RFC 9728) at `/.well-known/oauth-protected-resource` and validates the bearer token of each MCP request against IMS (`actions/mcp-server/validator.js`). The MCP client (Claude, ChatGPT) registers its own OAuth client with IMS, so no client ID is needed in the connector settings.
- **Photoshop API** calls use Firefly Services server-to-server credentials.

## Project structure

| Path | Content |
|---|---|
| `actions/mcp-server/index.js` | Action entry point: HTTP routing, OAuth metadata, MCP transport |
| `actions/mcp-server/tools.js` | MCP tools, resources and prompt, Photoshop API and storage calls |
| `actions/mcp-server/views.js` | HTML of the widgets |
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
