# Firefly Assembly

MCP server, deployed as an Adobe I/O Runtime (App Builder) action, that creates variants of a Photoshop PSD template with the Photoshop API: versions, adaptations or localizations of a banner, ad, visual or social post. The workflow runs in Claude or ChatGPT through interactive widgets (MCP Apps).

## Connect the server

**Server URL:** `https://85792-155azureplanarian.adobeioruntime.net/api/v1/web/firefly-assembly/mcp-server`

The server works with any MCP client that supports MCP Apps and OAuth, such as Claude and ChatGPT. Use the `adobeioruntime.net` domain, not `adobeio-static.net`: the resource in the OAuth metadata must match the server URL, otherwise sign-in fails (in Claude: "Couldn't register with … sign-in service").

### In Claude

1. Go to **Settings > Connectors > Add custom connector**.
2. Name it **Firefly Assembly** and enter the server URL.
3. Leave the OAuth client ID empty, click **Connect**, and sign in with your Adobe ID.
4. Enable the connector in your conversation.

### In ChatGPT

1. Add the server as a custom app (connector) in your settings.
2. Enter the server URL and choose **OAuth** authentication.
3. Leave the OAuth client ID empty and sign in with your Adobe ID.
4. Enable the app in your conversation.

## Demo flow

1. **Prompt:** Ask your assistant: "Use Firefly Assembly to create 2 variants of a banner in English and French."
2. **Variants and template (step 1):** Set the number of variants per language and the languages. You can choose among 12 languages, for up to 50 variants in total. Then set the file-naming pattern and upload a layered PSD from your computer or AEM Assets.
3. **Layers (step 2):** Click the numbered zones on the template preview, or use the list, to pick the text and smart-object layers to vary. If the template uses fonts that Photoshop does not have, a warning names them: add their .otf or .ttf files under the preview, which is rendered again with them.
4. **Texts (step 3):** Give your own copy or a short brief, for example "surfing campaign", and the assistant writes each variant in each language. Edit the table, import an Excel file (.xlsx), or paste cells from a spreadsheet.
5. **Images (step 4):** Add one image per variant, from your computer or AEM, or generate it with Firefly from the suggested prompt. Then adjust each crop to its frame. All languages of a variant share its images.
6. **Generate and review (step 5):** Variants are rendered in parallel as JPEG, PNG, and/or layered PSD, with each variant's languages side by side. The assistant checks each text on its visual and marks clipped, overflowing, or overlapping text with a proposed fix.
7. **Fix and download:** To fix a text, write your changes in the field of its variant (clicking the text on the enlarged visual, or its problem, starts a line for it there) and send them to the assistant, or ask in the chat; only these variants are regenerated. Download the files one by one or all at once as a ZIP.

## Workflow

1. **Start** (`start-variant-creation`): number of variants per language, languages (English, French, Italian, German, Spanish, Portuguese, Dutch, Polish, Swedish, Danish, Norwegian, Finnish; each variant is created in each language, up to 50 in total) PSD template, uploaded from the computer or picked in AEM Assets, read at once (`read-psd-template`) to pick the layers to change on its preview (editable text and smart object layers), model of the file names (`{template}`, `{variant}`, `{language}`, `{date}`; default `{template}_{variant}_{language}`), which `create-variant` applies to each file.
2. **Layers and fonts**: the layers are picked in the second step of the start widget (Next, once the template is uploaded; Back to change the settings); `get-psd-manifest` shows the same picker on its own, to pick other layers later. Under the preview, the user adds the .otf or .ttf files of the fonts that the Photoshop API does not have; they are given to each render (`fontOptions.additionalFonts`), and the preview is rendered again when a font is added or removed. Each font added is kept in the library of the user (`save-font`: the database collection `fonts`, with the PostScript, full and family names read from the file; at most 100 per user, a font of the same PostScript name replacing the earlier one): the widget lists them under Your fonts (`list-fonts`, with URLs signed again), to add in one click or remove from the library (`remove-font`), and adds by itself those whose name a template misses, then renders the preview again. The reading of a template gives its preview at once the fonts of the library that its texts use (PostScript names of the manifest), and tells the widget, which uses them for the other renders: no first render without them. The preview is rendered with its texts drawn again and the `fail` strategy for missing fonts, so that the widget names the fonts missing as a warning (the manifest also lists as missing the fonts that the render gets from Adobe Fonts, and a text not edited is not drawn again); the variants are rendered with a default font in place of a missing one (`use_default`).
3. **Texts** (`edit-variant-texts`): an editable table with the texts of each variant, which the user can also fill from an Excel file (.xlsx, its first sheet: a Variant column, then a column per layer name; matched by label, or in order) or by pasting cells copied from a spreadsheet, and download as an Excel file (read and written in the widget).
4. **Images**: with text layers too, the second step of the texts widget (`edit-variant-texts` with `images`), so that the texts and the images are confirmed together; with smart object layers only, `upload-variant-images`. In both, a grid with one image per variant and smart object layer, from the computer or AEM, or generated by Firefly from a prompt (proposed by the assistant from the brief, editable; `generate-image`, at the supported size closest to the ratio of the frame, copied to storage), with crops framed on the subject; the languages of a variant share its images and crops.
5. **Generation** (`create-variant`): all the variants (up to 50) are generated by a single call, in one task: their Photoshop jobs (renders and crops) all start at once, as JPEG (default), PNG and/or layered PSD files.
6. **Review**: the assistant checks the texts of each variant on its visual (see below), and the widget marks their problems on the visual, numbered, with a proposed fix. Each variant has a "What should change?" field, pre-filled with the proposed fixes; the user edits it and sends the changes to the assistant, which generates again only these variants; the new widget also shows the other variants of the generation, marked Unchanged (with the problems found on them, its field not pre-filled), and includes them in Download all. Clicking a text on the enlarged visual (where it is drawn, estimated from the layer in the template, its alignment and the lines of the new text, and joined with the box found by the review), or a problem of the card, goes back to the grid with a line for this text in the changes of the variant (`"headline": `), to write the change. The languages of each variant are shown side by side, one row per variant (its group) and one column per language. Each generation shows its variants (and, after changes sent, the unchanged ones of the generation changed), with a download button per file and a Download all button (a ZIP archive of all the files of the generation, built by a task: `create-variants-zip`). Variants generated again (with `previousTaskId`) keep all their formats up to date: with the same edits in other formats (e.g. PSD after JPEG), they keep the files of the earlier generation in the formats not rendered again; with other edits, they are also rendered again in their earlier formats, by the same Photoshop job (the edits of each variant are kept as a hash with its result). When the host can show a view full screen (`ui/request-display-mode`), a Full screen button shows the whole widget so (left before changes are sent, as the assistant answers with a new widget), and the enlarged view of a variant opens full screen, as a modal.

**Several formats**: the start widget takes up to 5 templates, one per format (e.g. 1080x1080, 1080x1920, 300x250), uploaded or picked in AEM together, each read at once; each variant is then rendered in each template (one file per variant and template, at most 100 per call, named with `{template}`). The layer step has a tab per template; the layers of the same name and type are linked: picking one picks them in the other templates, and they get the same text and image. The assistant is given linked layer ids, used in every step, and a `templates` JSON (name, URL, and for each linked layer its id in this template) that it passes to `create-variant`, which renders each variant with each template (`expandTemplates`). A text without line breaks is spread over the lines of the original text of each template. An image layer linked across frames of different ratios has a crop per ratio in the grid (`frames`, `crops`), each framed on the subject and adjustable; each template takes the crop of the ratio of its frame. The review shows each visual with the layers of its template, and the widget of the variants shows the formats of each variant side by side, with the name of its template. A change can target some templates of a variant only (`templates` on the variant).

Widgets return what the user confirmed through a short reference that the assistant reads with `get-widget-result`. The other tools (`save-widget-result`, `suggest-crop`, `create-upload-url`, AEM picker tools…) are used by the widgets. `upload-file` uploads a single file outside the workflow.

## Long operations

Adobe I/O Runtime ends a web request after about 60 seconds, and Photoshop jobs on large files can take longer. The operations that run Photoshop jobs (reading a template and rendering its preview, framing an image, generating variants) run as tasks: the tool starts an activation of the same action without waiting for it (5 minutes, the action timeout), signed with a secret of the action, and answers at once with a task id. The task writes its progress and result in App Builder state; the widgets poll `get-task` and show what is ready: the layers then the preview, each variant as soon as it is rendered. `get-psd-manifest` still waits up to 50 seconds for the layers, as the assistant needs them. The manifests of the templates are kept for an hour in the container and in App Builder state, so that the tasks run in other containers (parallel generations, edits from the widget) do not read them again. The crops of the images are kept likewise, for 12 hours: a variant generated again (e.g. after a text change) does not crop its images again. The size of an image to frame or crop is read from the header of its file (PNG, JPEG, GIF, WebP: the first 512 KB at most), without a Photoshop job; only other formats, or a JPEG rotated by its EXIF orientation, get a Photoshop manifest.

The Photoshop jobs are polled after 2.5 seconds, then every 1.5 seconds for the first 10 seconds, then less and less often up to every 8 seconds: each status request counts against the rate limit of Firefly Services, as the jobs do. On a 429 answer, all the requests of the container to the API wait for its Retry-After (up to 2 minutes); a longer Retry-After (a quota used up, e.g. until midnight UTC) is not waited for: the requests fail at once until then, with the time it ends. This time is shared with the other containers in App Builder state (read again every minute), and the start widget shows it (`get-quota`), before anything is started. A job not finished after 60 seconds is submitted again, unless the API was rate limited within the last minute. The 429 answers and the time waited for the rate limit are counted for each call, with its periods of wait, and shown in the generation report and the usage reports (a tile, the tooltip of each kind of call, a 429 column): the delay caused (the time during which calls waited, the calls waiting at once counted once), and the sum of the waits of the calls.

## Usage reports

At the end of each generation, the widget shows a report: the variants generated, the time taken, and the API calls made since the template was imported (Photoshop jobs, Firefly image generations, subject detections), with their execution times by kind and the renders of the generation against the average render. Each task keeps its calls in App Builder state, under a session of the user that the reading of another template starts again.

Each task (template reading, crop, image generation, generation of variants) is also recorded in the database of the workspace ([App Builder Database Storage](https://developer.adobe.com/app-builder/docs/guides/app_builder_guides/storage/database), region `emea`, collection `activity`, `actions/mcp-server/history.js`): the user (IMS user id), its duration, its API calls by kind, and for a generation its template, variants, formats and languages. The activity is kept without limit of time (a document of about 1 KB per task, within the 40 GB of storage of an App Builder pack). The assistant answers with two tools, over the last days or the whole history:

- `get-usage-history`: the generations of the user, with their totals.
- `get-usage-report`: the usage of all the users (totals, per user, per day, per kind of API call), only for the IMS user ids listed in `ADMIN_USER_IDS`.

Before a generation, with the number of variants and languages, the start widget estimates it (`get-generation-estimate`): one Photoshop render per variant and, once the template is read, if its image layers vary, one crop per image (the languages of a variant sharing its images) and the crop suggestions of the image grid; and the time of the generation, from the average time of these calls over the last 30 days (those of the user, or of all the users, or typical times before any) and the jobs run at once.

## Text checks

The assistant checks the texts of the generated variants by looking at them, right after create-variant, in the same turn: the user has nothing to ask. The assistant calls:

1. `review-variants`: once the generation is done (it waits for it, and answers that it is not finished after about 35 seconds, the assistant then calls it again), the visuals of the generation, reduced to 1000 px on their longest side and given as images (the assistant reads images in a tool result, not their URLs; `actions/mcp-server/review.js`), with the texts sent, the language of each variant and the layers of the template with their positions. An action answer is at most 1 MB: the visuals are given in parts (about 750 KB of images each, 4 to 6 visuals), each naming the variants left for the next call.
2. `report-variant-issues`, after each part: per variant, the problems found (a text cut or past an edge, hidden, overlapping another element, hard to read, badly broken, in another language, or not the text sent), each with its layer, a fix proposed to the user and the rectangle of the text on the visual; without a rectangle, the area of the layer in the template is marked, and where it overlaps the layers named.

The problems are stored with the generation; the widget waits for them (`get-variant-review`, up to 5 minutes), marks them on the visuals, numbered, and pre-fills the changes of each variant with the fixes proposed.

## Best practices for templates

- **Use point text, not paragraph text**, for the texts to vary. A paragraph text keeps its box: a longer text is hidden past its last line or has its words broken across lines. A point text only breaks lines where its text does, and grows from its anchor.
- **Align the texts from the side they should grow from**: centered texts grow on both sides, left-aligned texts to the right.
- **Leave room around the texts** that will be translated or rewritten: localized texts are often longer.
- **Keep each element in its own layer** (logo, button, badge), not merged into a background: the review is given the positions of the layers, and marks the overlaps from them.
- **Use smart object layers for the images to replace**, with the frame of the image at the size it should fill: images are cropped to the ratio of their frame.
- **Do not lock the layers to vary**: locked layers are not offered in the layer picker.
- **Name the layers** (e.g. "headline", "cta"): the names are shown to the user and to the assistant.
- **Break the lines of the original texts where they should be**: the assistant writes the new texts with the same number of lines and about the same number of characters per line. A new text written without any line break is spread over as many lines as the original text, of balanced lengths, without breaking words; a text with line breaks is kept as written.
- **Avoid texts on busy areas of an image**: they are hard to read.
- **Use fonts that Photoshop has** (Adobe Fonts included), or add the files of the others in the start widget: a missing font is replaced by a default font. Check that the license of a font allows sending it to a cloud service.

## Authentication

- **Users** sign in with Adobe IMS. The action serves the OAuth protected resource metadata (RFC 9728) at `/.well-known/oauth-protected-resource` and validates the bearer token of each MCP request against IMS (`actions/mcp-server/validator.js`). The MCP client (Claude, ChatGPT) registers its own OAuth client with IMS, so no client ID is needed in the connector settings.
- **Photoshop API** calls use Firefly Services server-to-server credentials.

## Project structure

| Path | Content |
|---|---|
| `actions/mcp-server/index.js` | Action entry point: HTTP routing, OAuth metadata, MCP transport |
| `actions/mcp-server/tools.js` | MCP tools, resources and prompt, Photoshop API and storage calls |
| `actions/mcp-server/views.js` | HTML of the widgets |
| `actions/mcp-server/review.js` | Visuals of the generated variants reduced for the review by the assistant |
| `actions/mcp-server/state.js` | App Builder state (tasks, widget results, reviews), values kept as JSON |
| `actions/mcp-server/history.js` | History of the activity in the database: recording, history of a user, usage report |
| `actions/mcp-server/fonts.js` | Library of the fonts of each user in the database, and the names read from a font file |
| `actions/mcp-server/zip.js` | ZIP archives of the files of a generation |
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
