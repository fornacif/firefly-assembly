# Firefly Assembly

MCP server, deployed as an Adobe I/O Runtime (App Builder) action, that creates variants of a Photoshop PSD template with the Photoshop API: versions, adaptations or localizations of a banner, ad, visual or social post. The workflow runs in Claude or ChatGPT through interactive widgets (MCP Apps).

## Connect the server

**Server URL:** `https://<namespace>.adobeioruntime.net/api/v1/web/firefly-assembly/mcp-server`, where `<namespace>` is the Runtime namespace of your deployment (`AIO_runtime_namespace` in `.env`, see [Deployment](#deployment)).

- **Claude:** **Settings > Connectors > Add custom connector**, name it **Firefly Assembly**, enter the server URL, leave the OAuth client ID empty, click **Connect** and sign in with your Adobe ID.
- **ChatGPT:** add the server as a custom app with **OAuth** authentication, leave the client ID empty and sign in with your Adobe ID.

Then enable the connector in your conversation. After a deployment that changes the tools, reconnect it and start a new conversation: the client keeps the tool list.

## Demo flow

1. **Prompt:** Ask your assistant: "Use Firefly Assembly to create 2 variants of a banner in English and French."
2. **Variants and template (step 1):** Set the number of variants per language and the languages. You can choose among 12 languages, for up to 50 variants in total. Then set the file-naming pattern and upload a layered PSD from your computer or AEM Assets.
3. **Layers (step 2):** Click the numbered zones on the template preview, or use the list, to pick the text and smart-object layers to vary. If the template uses fonts that Photoshop does not have, a warning names them: add their .otf or .ttf files under the preview, which is rendered again with them.
   Click **Next**: the widget writes a message with your selection, which you send to the assistant. Each widget ends its steps this way.
4. **Texts (step 3):** Give your own copy or a short brief, for example "surfing campaign", and the assistant writes each variant in each language. Edit the table, import an Excel file (.xlsx), or paste cells from a spreadsheet.
5. **Images (step 4):** Add one image per variant, from your computer or AEM, or generate it with Firefly from a prompt written in the slot. To have the assistant write the prompts, check **Generate a Firefly prompt per variant for the smart object layers** below the list of layers (step 2): the slots then show their prompts, editable, and **Generate with Firefly** generates all of them at once. Then adjust each crop to its frame. All languages of a variant share its images.
6. **Generate and review (step 5):** Variants are rendered in parallel as JPEG, PNG, and/or layered PSD, with each variant's languages side by side. The assistant checks each text on its visual and marks clipped, overflowing, or overlapping text with a proposed fix.
7. **Fix and download:** To fix a text, write your changes in the field of its variant (clicking the text on the enlarged visual, or its problem, starts a line for it there) and send them to the assistant, or ask in the chat; only these variants are regenerated. Download the files one by one or all at once as a ZIP.

## How it works

**Widgets.** Each tool of the workflow shows its own widget, with its own steps: `start-variant-creation` (1 Template, 2 Layers), `show-variant-texts` (3 Texts, 4 Images), `show-variant-images` (4 Images, without text layers) and `generate-variants` (5 Review, a new widget per generation). A widget sends what the user confirms as a user message (`ui/message`), with the full result in the model context and kept by the server under a short reference ending the message (`save-widget-result`, `get-widget-result`). The assistant passes this reference to `generate-variants` (`widgetRef`), which builds the variants from the texts and images confirmed, without the assistant copying them. Changes are generated again with `previousTaskId`: the new widget shows them with the unchanged variants.

**Several templates.** The start widget takes up to 5 templates, one per format (e.g. 1080x1080, 1080x1920): each variant is rendered in each template (at most 100 files per call). Layers of the same name and type are linked across templates and get the same text and image; an image framed in different ratios has a crop per ratio.

**Long operations.** Runtime ends a web request after about 60 seconds, so Photoshop jobs (reading a template, framing an image, generating variants, zipping) run as tasks: the tool starts an activation of the action and answers with a task id, the task writes its progress in App Builder state, and the widgets poll `get-task`. Manifests and crops are cached so that variants generated again do not redo them. Jobs are polled less and less often; on a 429, the requests wait for its Retry-After (up to 2 minutes), and a longer quota wait is shown in the start widget (`get-quota`).

**Text checks.** Right after `generate-variants`, the assistant calls `review-variants` (the visuals reduced to 640 px, given as images in parts under the 1 MB answer limit, with the texts sent and the layers of the template), then `report-variant-issues` (per variant, the problems found, a proposed fix and the rectangle of the text). The widget marks them on the visuals and pre-fills the changes of each variant.

**Usage reports.** Each generation shows a report of its API calls and times. Each task is also recorded in the App Builder database (region `emea`, collection `activity`): `get-usage-history` gives the generations of the user, `get-usage-report` the usage of all users, for the IMS user ids in `ADMIN_USER_IDS`.

**Authentication.** Users sign in with Adobe IMS: the action serves the OAuth protected resource metadata (RFC 9728) and validates the bearer token of each request; the MCP client registers its own OAuth client, so no client ID is needed. Photoshop API calls use Firefly Services server-to-server credentials.

## Best practices for templates

- **Use point text, not paragraph text**, for the texts to vary: a paragraph text keeps its box and hides or breaks a longer text.
- **Align texts from the side they should grow from**, and leave room around them: translations are often longer.
- **Break the original texts where the lines should break**: new texts follow the same number of lines.
- **Keep each element in its own layer** (logo, button, badge), and name the layers ("headline", "cta").
- **Use smart object layers for the images to replace**, framed at the size they should fill; do not lock the layers to vary.
- **Use fonts that Photoshop has** (Adobe Fonts included), or add their files in the start widget, if their license allows it.

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
## AEM Assets (optional) - repository browsed with the Asset Selector (delivery tier: approved assets)
# One repository (e.g. delivery-p12345-e67890.adobeaemcloud.com), several comma-separated,
# or '*' for any AEM as a Cloud Service repository of the user. Empty: local uploads only.
AEM_REPOSITORY_ID=
## IMS user ids of the admins (usage report of all the users), comma-separated
ADMIN_USER_IDS=
```

The database needs the **App Builder Data Services** API in the workspace (Developer Console); `aio app use` then adds its server-to-server credentials (`IMS_OAUTH_S2S_*`) to `.env`, which the action gets with the `include-ims-credentials` annotation. `aio app deploy` provisions the database when missing (`database` in `app.config.yaml`).

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
