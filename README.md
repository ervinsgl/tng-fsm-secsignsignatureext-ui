# SecSignSignatureExt — FSM Document Signing App

A SAP Fiori application for SAP Field Service Management (FSM), operated as an FSM Mobile Web Container extension. Enables FSM technicians to **view and digitally sign PDF attachments** on FSM Activities via the **SecSign Signature Portal**, with signed documents written back to FSM automatically.

> **Version:** 0.0.1
> **Platform:** SAP BTP Cloud Foundry
> **Last Updated:** October 2026

---

## Documentation

- [docs/SETUP.md](docs/SETUP.md) — fresh deployment to a new BTP subaccount
- [docs/RENAME.md](docs/RENAME.md) — renaming an existing app to comply with naming conventions
- [docs/NAMING.md](docs/NAMING.md) — naming convention reference for all tns FSM extensions
- [docs/SECURITY.md](docs/SECURITY.md) — security architecture, threat model, accepted risks (as-built; Mobile active path)
- [docs/SANDBOX_MTAR_MIGRATION.md](docs/SANDBOX_MTAR_MIGRATION.md) — sandbox + mtar deployment-split playbook
- [docs/SecSignSignatureExt_Change_Workflow.md](docs/SecSignSignatureExt_Change_Workflow.md) — BAS → DevOps → DEV → QA → PROD change flow

---

## 📋 Table of Contents

- [Overview](#-overview)
- [Architecture](#-architecture)
- [Core Concepts](#-core-concepts)
- [Features](#-features)
- [Prerequisites](#-prerequisites)
- [Setup & Deployment](#-setup--deployment)
- [FSM Mobile Integration](#-fsm-mobile-integration-primary)
- [Standalone / Development Mode](#-standalone--development-mode)
- [How It Works](#-how-it-works)
- [The Signing Flow](#-the-signing-flow)
- [API Reference](#-api-reference)
- [Project Structure](#-project-structure)
- [Troubleshooting](#-troubleshooting)
- [Application Details](#-application-details)
- [Current Status](#-current-status)
- [Security Notes](#-security-notes)

---

## 🎯 Overview

This application lets an FSM technician view the PDF attachments on an Activity and sign one or more of them in a single workflow, without leaving the FSM Mobile app. Signing is performed by the external **SecSign Signature Portal**: the app batches the selected PDFs into one signing portfolio, redirects the technician to the portal, and on return confirms completion, retrieves the signed documents, and writes them back to their FSM attachments — marking each as signed.

It runs inside the **FSM Mobile Web Container** (a WebView), auto-detecting the Activity in context and listing its attachments.

**Key Features:**
- ✅ Lists all PDF attachments on the context Activity, showing signed / unsigned status
- ✅ **Inline PDF viewer** for any attachment before signing
- ✅ **Single-document** signing (per-row) and **batch** signing ("Sign Selected") in one portfolio
- ✅ Uses SecSign's **`advanced-signature`** action with a fixed on-page signature position (signer positions nothing)
- ✅ **Reliable completion confirmation** — polls portfolio status and only proceeds when the portfolio reaches the finished state
- ✅ Signed portfolio (a ZIP) is split back into individual PDFs and **mapped to the originating FSM attachments by file name — all-or-nothing** (nothing is written if any document cannot be matched)
- ✅ Each signed attachment's content is updated in FSM and **marked signed** via UDF
- ✅ Already-signed rows are locked out of selection so they can't be re-signed
- ✅ Logged-in user's name + email shown in the header (FSM User API)
- ✅ **Visible errors** — a failed attachment load or a launch without an Activity shows a message, never a misleading empty list
- ✅ **Light on the network** — the list loads metadata only (a PDF is downloaded only when opened or signed); BTP destinations, the FSM token and the signed-UDF lookup are cached
- ✅ German + English UI (locale driven by FSM context)
- ✅ Direct FSM **Data API**, **Query API**, and **User API** integration via SAP BTP Destination Service

**Technology Stack:**
- **Frontend:** SAP UI5 (Fiori)
- **Backend:** Node.js + Express
- **Deployment:** SAP Business Technology Platform (Cloud Foundry)
- **Signing:** SecSign Signature Portal (BasicAuthentication via `SECSIGN_CONNECT`)
- **Outbound Authentication:** OAuth 2.0 via BTP Destination Service (`FSM_OAUTH_CONNECT`)
- **Inbound Authentication:** Authentication Key + session cookie (Mobile path) — see [Security Notes](#-security-notes)

---

## 🏗️ Architecture

The app is operated as an **FSM Mobile Web Container** extension. A standalone/dev path is retained, but Mobile is the active context.

| Context | Description | How It Works |
|---------|-------------|--------------|
| **FSM Mobile** (active) | Web Container in FSM Mobile app | POST context to `/web-container-access-point`; Auth Key validated and discarded; context stored server-side; session cookie issued |
| **Standalone** (dev) | Direct browser access | No valid session; `/api/*` returns 401; used for pure-frontend UI iteration |

**Context Detection Priority:** Mobile Web Container (stored session via `?session=` key) → Standalone.

```
┌──────────────────────────────────────────────────────────────────────────┐
│                              ENTRY POINTS                                  │
├──────────────────────────────────┬───────────────────────────────────────┤
│         FSM Mobile               │            Standalone (dev)            │
│         (Web Container)          │            (browser / no session)      │
│              │                   │                    │                   │
│   POST context to access-point   │        no session — /api/* → 401       │
│   Auth Key validated             │                                        │
│   + session cookie issued        │                                        │
└──────────────┼───────────────────┴────────────────────┼───────────────────┘
               │                                        │
               ▼                                        ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                          SAP BTP (Cloud Foundry)                           │
│  ┌──────────────────────────────────────────────────────────────────────┐ │
│  │                          UI5 App (Frontend)                           │ │
│  │                                                                       │ │
│  │  ContextService.js  - Detects environment, resolves cloudId + locale │ │
│  │  AttachmentService.js - Loads attachment list, PDF URL, finalize      │ │
│  │  SigningService.js  - Triggers the SecSign signing workflow          │ │
│  │  UserService.js     - Resolves logged-in user (name + email)         │ │
│  │  SecSignSignatureExt.controller.js - Orchestrates list + sign + return│ │
│  │       ↓                                                               │ │
│  │  1. Attachments table (per-row + "Sign Selected" batch)              │ │
│  │  2. Inline PDF viewer                                                  │ │
│  │  3. Redirect to SecSign portal → sign → redirect back                 │ │
│  │  4. Finalize on return → refresh table (real signed state from FSM)   │ │
│  └───────────────────────────┬───────────────────────────────────────────┘ │
│                              │                                              │
│  ┌───────────────────────────▼──────────────────────────────────────────┐ │
│  │                       Express Server (Backend)                        │ │
│  │                                                                       │ │
│  │  - WebContainer entry: /web-container-access-point (Auth Key + cookie)│ │
│  │  - requireSession middleware guards /api/* + /web-container-context   │ │
│  │  - Attachments API: list, PDF stream, finalize-signed                 │ │
│  │  - Signing API:     /api/signing/trigger                              │ │
│  │  - utils/fsm/:     FSMService, DestinationService, TokenCache         │ │
│  │  - utils/signing/: SecSignService, SignedZipExtractor, signing.config │ │
│  │  - utils/auth/:    SessionStore, requireSession                       │ │
│  └──────────────┬───────────────────────────────────┬────────────────────┘ │
└─────────────────┼───────────────────────────────────┼───────────────────────┘
                  │ OAuth Token                        │ BasicAuth
                  ▼                                    ▼
         ┌─────────────────┐                  ┌─────────────────┐
         │ BTP Destination │                  │ BTP Destination │
         │ FSM_OAUTH_CONNECT│                 │ SECSIGN_CONNECT │
         └────────┬────────┘                  └────────┬────────┘
                  │                                    │
                  ▼                                    ▼
         ┌─────────────────┐                  ┌─────────────────┐
         │     FSM API     │                  │  SecSign        │
         │                 │                  │  Signature      │
         │  - Data API v4  │                  │  Portal         │
         │  - Query API    │                  │                 │
         │  - User API     │                  │  - Portfolio    │
         │  (Attachment,   │                  │    workflow     │
         │   UdfMeta, User)│                  │  - Status/poll  │
         └─────────────────┘                  │  - Signed ZIP   │
                                              └─────────────────┘
```

---

## 🧩 Core Concepts

Understanding SecSignSignatureExt requires a few concepts:

| Concept | Meaning |
|---------|---------|
| **Portfolio** | A SecSign signing workflow container. One portfolio holds all the PDFs selected in a single signing action (one or many), signed in one pass. Identified by a `portfolioid`. |
| **`advanced-signature`** | The SecSign signature action used (ascending assurance level). Configured in `signing.config.js` as `SIGNATURE_ACTION`. |
| **Signer identifier** | SecSign identifies the signer by the **user name** (the local part of the email, before `@`) — **not** the full email. The app derives it in `SecSignService.js` via `signerEmail.split('@')[0]`. The technician's email comes from the FSM User API and **must be a TÜV NORD address** — e.g. `egleizds@tuev-nord.de`, from which `egleizds` is used to look up the signer in the SecSign portal. That user name must correspond to a registered **SecSign ID**, or the trigger fails (see [Troubleshooting](#-troubleshooting)). |
| **Fixed signature position** | The signature annotation is placed at a fixed on-page position (`SIG_POSITION`) so the signer positions nothing (`sigposbysigner = false`). Keeps the mobile signing step simple. |
| **Portfolio state** | SecSign reports a numeric `portfoliostate`. The app treats `3` (FINISHED) as "successfully signed → safe to download". States are centralized in `signing.config.js` (`PORTFOLIO_STATE`). |
| **Completion poll** | On return from the portal, the backend polls `SPPortfolioStatus/{portfolioId}` a bounded number of times (`COMPLETION_POLL`: 6 attempts, 1.5s apart) before concluding signed / not-signed. Prevents acting on an incomplete workflow. |
| **Signed ZIP** | A SecSign portfolio download is a ZIP containing the signed PDFs (and, depending on the SecSign workflow configuration, a signature protocol / audit report). `SignedZipExtractor` maps each **requested** document to exactly one PDF in the ZIP **by file name** — anything else in the ZIP is ignored. Matching follows SecSign's naming: the **`-signed` suffix** it appends (`TEST_1.pdf` → `TEST_1-signed.pdf`) and the **`_` it substitutes** for spaces and `/ # % & { } \ < > * ? $ ! ' " : + ` \| = @`; letter case, umlaut encoding and folder prefixes are ignored. **All-or-nothing:** if any document has no match or more than one, nothing is written to FSM. There is no positional guessing. |
| **`Z_Attachment_PDFSigned`** | The FSM Attachment UDF that marks a document as signed. Set to `true` after write-back; read on load to show signed status and lock the row. |
| **Pending batch** | Between trigger and return, the selected batch (portfolioId, Activity id, attachment ids + names) is persisted in `localStorage`, so the return handler — after a full-page redirect — knows what to finalize and match. It is read once on return; a leftover batch from a different Activity is ignored. |

---

## ✨ Features

### UI Components

| Component | Description |
|-----------|-------------|
| **Attachments Table** | Lists every attachment on the context Activity: a per-row Sign button, file name (opens the PDF), type, and description. MultiSelect for batch signing. If the list cannot be loaded, an **error strip** replaces the table ("could not be loaded" or "session expired"); "No attachments found" means the Activity really has none. |
| **Sign Selected (N)** | Toolbar button that signs all selected unsigned PDFs in one portfolio. The count updates live; already-signed rows are excluded from selection. |
| **Per-Row Sign** | Each unsigned row has its own "Sign PDF" button for single-document signing. Signed rows show a green "Signed!" state and are disabled. |
| **Inline PDF Viewer** | Clicking a file name opens the PDF in an inline `PDFViewer` panel (streamed from the backend), with a download button. |
| **User Header** | Shows the logged-in technician's name and email (resolved via the FSM User API), plus the context source (Mobile App) and object type badges. |
| **Localized UI** | All labels and messages are in English and German; the language follows the FSM context locale automatically. |

### Signing Pipeline

A single Sign action runs a trigger → redirect → finalize sequence:

| Stage | Resolves | Source |
|-------|----------|--------|
| **Trigger** | Fetches each selected PDF binary from FSM, starts one SecSign portfolio, returns the portal URL | Data API (attachment content) + SecSign trigger |
| **Sign** | Technician signs all documents in the portfolio in one pass on the SecSign portal | SecSign Signature Portal (external) |
| **Confirm** | On return, polls portfolio status until FINISHED (or gives up after the bounded poll) | SecSign `SPPortfolioStatus` |
| **Extract + map** | Downloads the signed ZIP and maps every requested document to exactly one signed PDF by name — or changes nothing | `SignedZipExtractor` |
| **Write-back** | Updates each attachment's content in FSM and marks it signed via UDF | Data API (update content + UDF) |

*Backend modules: `utils/signing/SecSignService.js`, `utils/signing/SignedZipExtractor.js`, `utils/fsm/FSMService.js`.*

---

## ✅ Prerequisites

### Required Tools

| Tool | Version | Purpose |
|------|---------|---------|
| **Node.js** | v18.0.0+ | Backend runtime |
| **npm** | v8.0.0+ | Package management |
| **Cloud Foundry CLI** | Latest | `cf` command for deployment |
| **UI5 CLI** | v4.0.33+ | Build tooling (dev dependency) |
| **MBT** (Cloud MTA Build Tool) | v1.2+ | Builds the `.mtar` for DevOps transport |

### SAP BTP Account

- Cloud Foundry space with available quota
- Memory: 512MB (configurable in `manifest.yaml` / `mta.yaml`)
- Disk: 512MB
- `instances: 1` (in-memory session/context store — see [Current Status](#-current-status))

### SAP BTP Services

| Service | Instance Name | Purpose |
|---------|---------------|---------|
| **Destination Service** | `fsm-secsignsignatureext-destination` | FSM API + SecSign connectivity (outbound) |

> The destination service instance is **unsuffixed** (`fsm-secsignsignatureext-destination`)
> and reused in every subaccount/environment — see
> [docs/SANDBOX_MTAR_MIGRATION.md](docs/SANDBOX_MTAR_MIGRATION.md).

### Destination Configuration

This app uses **two** destination configs on the one service instance.

#### FSM_OAUTH_CONNECT (FSM Data/Query/User API)

Name: FSM_OAUTH_CONNECT
Type: HTTP
URL: https://<region>.fsm.cloud.sap
Authentication: OAuth2ClientCredentials
Token Service URL: https://<region>.fsm.cloud.sap/api/oauth2/v2/token
Client ID: <your-fsm-client-id>
Client Secret: <your-fsm-client-secret>
Additional Properties:
account: <your-account>
company: <your-company>
URL.headers.X-Account-ID: <your-account-id>
URL.headers.X-Company-ID: <your-company-id>
URL.headers.X-Client-ID: <your-client-id>
URL.headers.X-Client-Version: <your-client-version>

#### SECSIGN_CONNECT (SecSign Signature Portal)

Name: SECSIGN_CONNECT
Type: HTTP
URL: https://<your-secsign-portal-host>/rest/signatureportal/v1/SPWorkflow/Start
Authentication: BasicAuthentication
User: <secsign-user>
Password: <secsign-password>

> The destination **config** names (`FSM_OAUTH_CONNECT`, `SECSIGN_CONNECT` — what the app
> reads via `FSM_DESTINATION` in `utils/fsm/FSMService.js` and `SECSIGN_DESTINATION` in
> `utils/signing/SecSignService.js`) are separate from the destination **service instance**
> name (`fsm-secsignsignatureext-destination`, what the manifest binds to).

The backend reads FSM destinations via `utils/fsm/DestinationService.js`, attaching
`account`/`company` as query params and the `X-Account-ID` / `X-Company-ID` / `X-Client-ID` /
`X-Client-Version` headers to every FSM call.

> **Destination cache:** resolved destinations are cached for **10 minutes** per name. A
> change in the BTP cockpit (e.g. a rotated SecSign password) takes effect within 10 minutes,
> or immediately after `cf restart`.

### FSM Access

- SAP Field Service Management instance
- API access credentials (OAuth client) for outbound calls
- User with permissions for:
  - Activities (read)
  - Attachments (read, update content, update UDF)
  - Users (read — for the header)
  - UDF metadata (read — for `Z_Attachment_PDFSigned`)
- The **`Z_Attachment_PDFSigned`** UDF must exist on the Attachment business object

### SecSign Access

- A SecSign Signature Portal instance reachable from Cloud Foundry
- BasicAuthentication credentials for the portal (used by `SECSIGN_CONNECT`)

### FSM Mobile Integration

- Web Container configured in FSM Admin (URL → `/web-container-access-point`)
- Authentication Key configured on the Web Container, matching `FSM_WEBCONTAINER_AUTH_KEY`

---

## 🚀 Setup & Deployment

This app uses the **sandbox + mtar deployment split**: a local sandbox via
`cf push` (`manifest.yaml`), and DevOps DEV/QA/PROD via `mta.yaml` (mtar transport).
See [docs/SANDBOX_MTAR_MIGRATION.md](docs/SANDBOX_MTAR_MIGRATION.md) for the full model.

### 1. Clone & Install

```bash
git clone <repository-url>
cd tns-fsm-secsignsignatureext-ui
npm install
```

### 2. Configure BTP Destinations

Create the **FSM_OAUTH_CONNECT** and **SECSIGN_CONNECT** destination configs as shown in
[Prerequisites](#-prerequisites). Account and company are **not** configured in the
app — they come from the FSM destination's additional properties.

### 3. Create the Destination Service Instance

```bash
cf create-service destination lite fsm-secsignsignatureext-destination
```

This must exist **before** any deploy — the manifest/mta binds it as an existing
service. Missing instance = bind/staging failure (the most common deploy error).

### 4. Build the UI5 Frontend

```bash
npm run build:cf
```

This runs the UI5 preload build (`ui5-deploy.yaml`) with cachebuster info, producing
the deployable `webapp` bundle the Express server serves statically.

### 5a. Deploy — Local Sandbox (`cf push`)

```bash
cf push        # uses the local-only manifest.yaml (-sandbox name/route)
```

The sandbox `manifest.yaml` defines `tns-fsm-secsignsignatureext-ui-sandbox`, 512MB memory,
the Node.js buildpack, `npm start`, the pinned `-sandbox` route, and binds
`fsm-secsignsignatureext-destination`.

> The `-sandbox` `manifest.yaml` / `mta.yaml` are **local only — never committed.**
> The DevOps repo carries the unsuffixed variants (app `tns-fsm-secsignsignatureext-ui`,
> `default-route: true`).

### 5b. Deploy — DevOps (mtar transport)

```bash
npm run build:mta      # produces mta_archives/*.mtar
cf deploy mta_archives/<archive>.mtar
```

DEV deploys from the committed `mta.yaml`; QA/PROD are promoted via cTMS / Cloud ALM,
not a direct `cf deploy`. See the change-workflow doc.

### 6. Set the Authentication Key (inbound auth) — REQUIRED

```bash
cf set-env tns-fsm-secsignsignatureext-ui-sandbox FSM_WEBCONTAINER_AUTH_KEY '<value>'
cf restage tns-fsm-secsignsignatureext-ui-sandbox
```

**The app exits on startup if this is unset** (fail-fast guard in `index.js`). The value
must **byte-exactly match** the Authentication Key configured on the FSM-side Web Container.
Never commit the value.

### 7. Get the Application URL

```bash
cf app tns-fsm-secsignsignatureext-ui-sandbox
```

Copy the route. This is the URL you register in FSM Admin as the **Web Container** URL
(append `/web-container-access-point`).

### Local Development

```bash
npm start          # Express server (backend + static frontend) on port 3000
npm run start-ui5  # Fiori dev server (frontend only, no backend API)
```

> Local outbound FSM/SecSign calls require the BTP Destination Service binding (or running in
> SAP Business Application Studio with the bound service). The Fiori dev server
> (`start-ui5`) serves only the UI — backend `/api/*` endpoints are not available.

---

## 📱 FSM Mobile Integration (primary)

This app is operated as a **Web Container** in FSM Mobile. This is the active, configured integration path.

### Configure FSM Web Container

Navigate to: **FSM Admin → Companies → [Your Company] → Web Containers**

#### 1. Create Web Container

| Field | Value |
|-------|-------|
| **Name** | `Signature Portal` |
| **External ID** | `Z_SecSignSignatureExt` |
| **URL** | `https://tns-fsm-secsignsignatureext-ui-sandbox-xxx.cfapps.eu10-004.hana.ondemand.com/web-container-access-point` |
| **Object Types** | `Activity` |
| **Authentication Key** | `<must byte-match FSM_WEBCONTAINER_AUTH_KEY>` |
| **Active** | ✓ Checked |

> Use the sandbox route for the sandbox app, or the DevOps app's route
> (`tns-fsm-secsignsignatureext-ui`) for DEV/QA/PROD. One URL field per registration —
> the cutover moment is when you change it.

#### 2. Web Container Context

When opened from FSM Mobile, the web container POSTs context to
`/web-container-access-point`. The server validates the Authentication Key, stores the
context (without the key and the FSM user token) keyed by `userName-cloudId`, issues a session cookie, and
redirects to the app with a `?session=<key>`. The frontend retrieves context via
`/web-container-context`.

| Field | Description |
|-------|-------------|
| `cloudId` | Activity ID (used to resolve and load attachments). If missing, the app shows "This app must be opened from an Activity". |
| `objectType` | Object type (`ACTIVITY`) |
| `userName` | Current user's name (resolved to name + email for the header) |
| `cloudAccount` | FSM account name |
| `companyName` | FSM company name |
| `language` | User's language preference (drives UI locale — `de` / `en`) |
| `authenticationKey` | Shared secret validated against `FSM_WEBCONTAINER_AUTH_KEY` — **discarded after validation, never stored or returned to the browser** |
| `authToken` | The technician's FSM user token (JWT) — **not used by the app; discarded on entry, never stored or returned** |
| `dataCloudFullQualifiedDomainName` | FSM cluster URL (informational) |

#### 3. Add to Mobile Screen Configuration

Navigate to: **FSM Admin → Companies → [Your Company] → Screen Configurations**

1. Select `Activity Mobile` (or your custom activity screen)
2. Click the pencil icon to edit
3. Add a Web Container button to the activity screen
4. Configure: **Label** `Signature Portal`, **Web Container** `Z_SecSignSignatureExt`
5. **Save**

### Inbound Authentication (Mobile)

The Web Container entry POST validates the Authentication Key (Tier 1) and issues an
HttpOnly session cookie (Tier 3) with a sliding 60-minute TTL. Every `/api/*` call and
`/web-container-context` is guarded by the `requireSession` middleware, which slides the
TTL on each request. `/web-container-context` only returns the context the caller's own
session is bound to (403 otherwise). The stored context itself is kept 12 hours, so it
always outlives the session — access is controlled by the session alone. See
[Security Notes](#-security-notes).

---

## 🧪 Standalone / Development Mode

For local UI iteration, the frontend can be served without an FSM session, but it has no data and no signing.

https://tns-fsm-secsignsignatureext-ui-sandbox-xxx.cfapps.eu10-004.hana.ondemand.com

> Standalone mode is for pure-frontend UI work (CSS, layout, view structure) only.
> With inbound auth in place, `/api/*` calls require a valid session cookie, so
> standalone has no attachments and no signing — every API call returns 401 without a
> real Mobile session. For end-to-end testing, launch from FSM Mobile.

---

## 🔄 How It Works

### Load Flow

┌─────────────────────────────────────────────────────────────────┐
│  Context received (Mobile POST → session cookie + ?session key) │
│  ContextService.getContext() → { cloudId, objectType, language }│
│  Language applied to UI (de / en) before content renders        │
└──────────────────────────┬──────────────────────────────────────┘
▼
┌─────────────────────────────────────────────────────────────────┐
│  AttachmentService.loadAttachments(cloudId)                     │
│  → GET /api/attachments/<cloudId>                               │
└──────────────────────────┬──────────────────────────────────────┘
▼
┌─────────────────────────────────────────────────────────────────┐
│  Backend: FSMService.getAttachmentsForObject()                  │
│  1. Query attachments for the Activity (Query API)              │
│  2. Read Z_Attachment_PDFSigned UDF → signed flag per row       │
│     (UDF meta resolved once per load, shared by all rows)       │
│  Metadata only — no PDF content is downloaded for the list.     │
└──────────────────────────┬──────────────────────────────────────┘
▼
┌─────────────────────────────────────────────────────────────────┐
│  Frontend renders: attachments table (per-row Sign + Sign       │
│  Selected), signed rows locked, user header, inline PDF viewer  │
│  — or an error strip if the list could not be loaded            │
└─────────────────────────────────────────────────────────────────┘

### Detailed Steps

| Step | Action | Result |
|------|--------|--------|
| 1 | Technician opens an Activity in FSM Mobile and launches **Signature Portal** | App opens in the Mobile WebView; Auth Key validated, session cookie set |
| 2 | Context received | `ContextService` resolves the Activity `cloudId` and applies the UI locale |
| 3 | Attachments loaded | `/api/attachments/<cloudId>` returns rows with signed status (metadata only). On failure an error strip is shown instead of the table. |
| 4 | Table rendered | Per-row Sign buttons; signed rows show green "Signed!" and are disabled |
| 5 | (Optional) View a PDF | Clicking a file name streams it into the inline viewer — the only time a PDF is downloaded to the device |
| 6 | Technician selects PDFs and signs | Redirect to the SecSign portal (see The Signing Flow) |
| 7 | Return from portal | Backend confirms completion, writes signed PDFs back, marks them signed |
| 8 | Table refreshes | Rows reflect the real signed state from FSM |

### Outbound (app → FSM API)

┌─────────────────────────────────────────────────────────────────┐
│  1. Read VCAP_SERVICES → Destination Service credentials        │
└──────────────────────────┬──────────────────────────────────────┘
▼
┌─────────────────────────────────────────────────────────────────┐
│  2. Fetch FSM_OAUTH_CONNECT destination → FSM URL + OAuth config│
│     (cached 10 min per destination name; failures not cached)   │
└──────────────────────────┬──────────────────────────────────────┘
▼
┌─────────────────────────────────────────────────────────────────┐
│  3. Get FSM OAuth token (cached, 5 min pre-expiry buffer;       │
│     concurrent requests share one refresh)                      │
└──────────────────────────┬──────────────────────────────────────┘
▼
┌─────────────────────────────────────────────────────────────────┐
│  4. Make FSM API calls: Query API, Data API v4, User API        │
└─────────────────────────────────────────────────────────────────┘

*Outbound FSM is handled by `utils/fsm/FSMService.js` (destination + token via
`utils/fsm/DestinationService.js` and `utils/fsm/TokenCache.js`). SecSign is handled by
`utils/signing/SecSignService.js` against the `SECSIGN_CONNECT` destination, which uses the
same destination cache.*

---

## 🖊️ The Signing Flow

This is the heart of the app. A single **Sign** action (per-row or "Sign Selected") runs a trigger → sign → finalize sequence across a full-page redirect to the SecSign portal.

### 1. Trigger

The frontend calls `POST /api/signing/trigger` with the selected documents, the signer's
email (from the FSM User API lookup shown in the header) and a `returnUrl` (the app's own
page). The backend:

1. Rejects the batch if two selected documents have names SecSign cannot tell apart
   (e.g. `Bericht.pdf` + `bericht.PDF`, or `A B.pdf` + `A_B.pdf`) — they could not be
   mapped back after signing. The technician signs them one at a time instead.
2. Fetches each selected PDF binary from FSM (Data API attachment content).
3. Starts **one** SecSign portfolio workflow containing all documents — a single step with
   one `sigpos` per document, using `SIGNATURE_ACTION = 'advanced-signature'` and the fixed
   `SIG_POSITION` (so the signer positions nothing).
4. Passes the `returnUrl` as SecSign's `redirecturl` so the portal returns the browser to
   the app after signing.
5. Returns the portfolio's `workflowstepurl` (portal URL) and `portfolioid`.

Trigger OK | portfolioid: 4411 | url: https://<portal>/…/Portfolio/4411/WorkflowStep/3713

### 2. Persist & Redirect

The frontend persists the pending batch in `localStorage`
(`portfolioId`, `objectId`, `documents`) and navigates the browser full-page to the
portal URL. The batch marker survives the redirect; so does the session cookie (issued at
entry, `SameSite=Lax`).

### 3. Sign

The technician signs all documents in the portfolio in one pass on the SecSign portal.
On completion, SecSign shows the redirect UX (`REDIRECT_UX`) and issues a **GET redirect**
back to the app's `returnUrl`.

### 4. Confirm Completion (on Return)

On reload, `_checkSigningReturn()` detects the pending batch and calls
`POST /api/attachments/finalize-signed`. (A leftover batch whose Activity is not the one
now open is ignored and removed.) The backend confirms the portfolio actually finished
before touching anything:

- Polls `SPPortfolioStatus/{portfolioId}` up to `COMPLETION_POLL.attempts` (6) times,
  `COMPLETION_POLL.intervalMs` (1500ms) apart.
- Proceeds only when `portfoliostate === PORTFOLIO_STATE.FINISHED` (3).
- If not finished (technician declined or went back), nothing is changed and the row stays
  unsigned.

### 5. Extract & Map

The backend downloads the signed portfolio (a ZIP) and `SignedZipExtractor`:

- Logs the full ZIP listing (`[SignedZipExtractor] ZIP entries (N): …`).
- Maps each requested document to exactly one PDF in the ZIP by file name, following
  SecSign's renaming (`-signed` suffix, `_` for unsafe characters — see
  [Core Concepts](#-core-concepts)). Other entries (protocol, audit report) are ignored
  because nobody requested them.
- **All-or-nothing:** if any document has no match or an ambiguous one, the request fails
  with `SIGNED_MAPPING_FAILED` and **no attachment is changed** — the log line lists the
  missing, ambiguous and available names. Nothing is ever assigned by position.

### 6. Write-Back

For each mapped document, the backend:

1. Updates the attachment's content in FSM with the signed PDF (Data API).
2. Marks it signed via `Z_Attachment_PDFSigned = true` (UDF).

The frontend then reloads attachments so the table reflects the real signed state, and a
success toast confirms:

Document signed and saved            (single)
3 documents signed and saved         (batch)

### Session expiry during signing

The session expires after 60 minutes **idle**, so a normal signing never hits it. It
happens in practice only if the app is restarted or redeployed while the technician is on
the SecSign portal: the in-memory session is wiped and `finalize-signed` returns 401 on
return. **Nothing is written to FSM.** The frontend shows a distinct warning ("Your session
expired before your signature could be saved, so nothing was changed. Please open this app
again from FSM Mobile and sign the document(s) again.") and the technician signs again —
like a re-login. This is a deliberate, documented choice (`docs/SECURITY.md`, accepted
risk #3).

---

## 🔌 API Reference

### Backend Endpoints

All `/api/*` routes and `/web-container-context` are guarded by the `requireSession`
middleware (a valid session cookie is required; see [Security Notes](#-security-notes)).
The Web Container entry POST is gated by the Authentication Key instead.

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/web-container-access-point` | Auth Key | Validate the FSM Authentication Key, store context (keyed by `userName-cloudId`, without the key), issue a session cookie, redirect to the app. |
| POST | `/` | Auth Key | Fallback web container entry point (same handler, older FSM versions). |
| GET | `/web-container-context?session=<key>` | requireSession | Frontend retrieves its stored context. The key must be the caller's own session context (403 otherwise). |
| GET | `/api/user/:name` | requireSession | Resolve an FSM user's profile (name + email) for the header. |
| GET | `/api/attachments/:objectId` | requireSession | List attachments for the Activity: `[{ id, fileName, type, description, signed }]` — metadata only. |
| GET | `/api/attachment-pdf/:attachmentId` | requireSession | Stream a single PDF (used as the inline `PDFViewer` source). |
| POST | `/api/signing/trigger` | requireSession | Fetch PDFs from FSM, start one SecSign portfolio, return the portal URL. Body: `{ documents: [{ attachmentId, fileName }], signerEmail, returnUrl }`. Errors: `400 DUPLICATE_FILENAMES`, `422 SIGNER_NOT_REGISTERED`. |
| POST | `/api/attachments/finalize-signed` | requireSession | Confirm portfolio completion, map signed PDFs to attachments (all-or-nothing), write them back + mark signed. Body: `{ portfolioId, documents: [{ attachmentId, fileName }] }`. Returns `{ signed, signedAttachmentIds, state }`. Error: `500 SIGNED_MAPPING_FAILED` (nothing written). |

> `GET /api/attachment-content/:attachmentId` was removed in October 2026 — it only fed a
> list preview that was never displayed.

### FSM APIs Used (Outbound)

| API | Endpoint | Purpose |
|-----|----------|---------|
| **Query API v1** | `/api/query/v1` | CoreSQL queries: attachments on the Activity (`Attachment`), signed-UDF meta (`UdfMeta`). |
| **Data API v4** | `/api/data/v4/Attachment/<id>` | Read attachment binary; update content; update `Z_Attachment_PDFSigned` UDF. |
| **User API v1** | `/api/user/v1/users/?name=<name>` | Resolve the logged-in user's name + email for the header. |
| **OAuth Token Endpoint** | `/api/oauth2/v2/token` | OAuth2 client-credentials flow (via BTP Destination Service). |

### SecSign APIs Used (Outbound)

| API | Endpoint | Purpose |
|-----|----------|---------|
| **Workflow Start** | `/rest/signatureportal/v1/SPWorkflow/Start` | Start a portfolio workflow with the batched PDFs; returns `portfolioid` + `workflowstepurl`. |
| **Portfolio Status** | `/rest/signatureportal/v1/SPPortfolioStatus/{portfolioId}` | Poll for completion (`portfoliostate === 3`). |
| **Portfolio Download** | `/rest/signatureportal/v1/SPPortfolio/{portfolioId}/Download` | Retrieve the signed ZIP for extraction (default naming: `-signed` suffix, unsafe characters → `_`). |

### FSM DTOs

| DTO | Version | Used for |
|-----|---------|----------|
| `Attachment` | `.8` | Attachment list, content, signed-status UDF |
| `UdfMeta` | `.20` | Resolve the `Z_Attachment_PDFSigned` UDF external id |

> DTO versions and the signed-marker UDF (`Z_Attachment_PDFSigned`) are referenced in
> `utils/fsm/FSMService.js`. Signing behavior (action, position, states, poll, redirect UX)
> is centralized in `utils/signing/signing.config.js`.

---

## 📁 Project Structure

tns-fsm-secsignsignatureext-ui/
│
├── # ─────────── ROOT LEVEL ───────────
├── index.js                         # Express server, auth-key startup guard, mounts routes + requireSession
├── package.json                     # Node.js deps (express, axios, form-data, adm-zip, cookie-parser)
├── manifest.yaml                    # Cloud Foundry deployment — SANDBOX (cf push, local only)
├── mta.yaml                         # MTA transport descriptor — SANDBOX (local only)
│                                    #   (DevOps repo carries manifest.devops.yaml / mta.devops.yaml)
├── xs-app.json                      # App Router configuration
├── xs-security.json                 # Security configuration (xsappname = App ID)
├── ui5.yaml / ui5-local.yaml / ui5-deploy.yaml   # UI5 tooling configs
├── README.md                        # This file
│
├── # ─────────── DOCUMENTATION ───────────
├── docs/
│   ├── SETUP.md                     # Fresh deployment guide
│   ├── RENAME.md                    # App renaming guide
│   ├── NAMING.md                    # Naming convention reference
│   ├── SECURITY.md                  # Security architecture, accepted risks (as-built; Mobile active path)
│   ├── SANDBOX_MTAR_MIGRATION.md    # Sandbox + mtar deployment-split playbook
│   ├── SecSignSignatureExt_Change_Workflow.md  # BAS → DevOps → DEV → QA → PROD change flow
│   └── screenshots/                 # App screenshots for documentation
│
├── # ─────────── BACKEND ───────────
├── routes/
│   ├── context.js                   # Web Container entry (Auth Key + cookie), context retrieval, user lookup
│   ├── attachments.js               # Attachment list, PDF stream, finalize-signed
│   └── signing.js                   # POST /api/signing/trigger
│
├── utils/
│   ├── auth/
│   │   ├── SessionStore.js          # Auth-Key validation + session tokens (sliding 60-min TTL)
│   │   └── requireSession.js        # Session-cookie middleware guarding /api/*
│   ├── fsm/
│   │   ├── FSMService.js            # FSM Data + Query + User API calls; signed-status UDF
│   │   ├── DestinationService.js    # BTP Destination Service resolution (10-min cache per name)
│   │   └── TokenCache.js            # OAuth token caching (5 min pre-expiry buffer, shared refresh)
│   └── signing/
│       ├── SecSignService.js        # SecSign trigger, status poll, signed download
│       ├── SignedZipExtractor.js    # Signed ZIP → PDFs, all-or-nothing name mapping to attachment ids
│       └── signing.config.js        # Signature action, position, portfolio states, poll, redirect UX
│
└── # ─────────── FRONTEND (SAP UI5) ───────────
webapp/
│
├── index.html                       # App entry point
├── manifest.json                    # UI5 app descriptor (id: com.tns.fsm.secsignsignatureext.app)
├── Component.js                     # UI5 Component
├── appconfig.json                   # FSM extension descriptor (sandbox name carries "(Sandbox)")
│
├── view/
│   ├── App.view.xml                 # Root view
│   └── SecSignSignatureExt.view.xml # Main view: error strip, attachments table, inline PDF viewer
│
├── controller/
│   ├── App.controller.js            # Root controller
│   └── SecSignSignatureExt.controller.js  # Main controller: load + sign + return flow
│
├── utils/
│   └── services/
│       ├── ContextService.js        # Context detection (Mobile / standalone) + locale
│       ├── AttachmentService.js     # Attachment list (metadata), PDF URL, finalize
│       ├── SigningService.js        # Trigger the SecSign signing workflow
│       └── UserService.js           # Resolve logged-in user (name + email)
│
├── model/
│   └── models.js                    # Device model
│
├── css/
│   └── style.css                    # Custom styles
│
└── i18n/
├── i18n.properties              # Translations (English)
└── i18n_de.properties           # Translations (German)

> **Backend is split by domain:** `routes/` holds the Express handlers; `utils/auth/` owns
> inbound session security; `utils/fsm/` owns FSM transport + API calls; `utils/signing/`
> owns the SecSign workflow, ZIP extraction, and signing config. The only write paths to FSM
> are attachment content update + the signed UDF, both in `finalize-signed`.
>
> **Sandbox vs DevOps files:** `manifest.yaml`, `mta.yaml`, and `appconfig.json` have a
> local-only sandbox variant (never committed) and a committed DevOps variant
> (`*.devops.yaml` / `appconfig.devops.json`) — see
> [docs/SANDBOX_MTAR_MIGRATION.md](docs/SANDBOX_MTAR_MIGRATION.md).

---

## 🐛 Troubleshooting

### View Logs

```bash
cf logs tns-fsm-secsignsignatureext-ui-sandbox --recent   # recent buffered logs
cf logs tns-fsm-secsignsignatureext-ui-sandbox            # live tail
```

### Common Issues

| Issue | Cause | Solution |
|-------|-------|----------|
| App won't start / crashes on boot | `FSM_WEBCONTAINER_AUTH_KEY` not set | The startup guard exits when the key is missing. Set it via `cf set-env` + `cf restage`. Check logs for `FATAL: FSM_WEBCONTAINER_AUTH_KEY is not set`. |
| Web Container launch fails / 401 on entry | Auth Key mismatch | The `authenticationKey` in the POST must byte-match `FSM_WEBCONTAINER_AUTH_KEY`. Check logs for `WC-ACCESS-POINT: rejected POST — authenticationKey`. Re-copy the key on both sides. |
| Red strip "Your session has expired" instead of the list | Session cookie missing/expired (401) | Check for `AUTH: rejected ... source=none` (cookie didn't attach) or `source=cookie` (expired). Re-launch from FSM Mobile. If persistent, confirm the entry POST issued the cookie. |
| Red strip "The attachments could not be loaded" | Backend or FSM error while listing (5xx), or no connection | Check `[FSMService] Attachments error` / `[Attachments] List error` in the logs and the `FSM_OAUTH_CONNECT` destination. (Before October 2026 this looked like "No attachments found".) |
| "This app must be opened from an Activity" | Launch context has no `cloudId` | The Web Container is assigned to the wrong object type or opened outside an Activity. Check the Web Container's **Object Types** (`Activity`) and the screen configuration. |
| PDF viewer blank | `/api/attachment-pdf/*` blocked or content missing | Confirm the request carries the cookie (same-origin in the WebView). Check the attachment actually has PDF content in FSM. |
| Signing doesn't start (no portal URL) | SecSign trigger failed | Check `[SecSignService] Trigger error` in logs and the `SECSIGN_CONNECT` destination (URL, BasicAuth creds). The trigger needs a reachable portal. |
| "User not registered" dialog on Sign (EN/DE) | Signer user name has no SecSign ID | SecSign returned `404 — "Did not find a SecSign ID nor a remote user for user name '<n>'"`. The signer is the local part of the technician's email (before `@`), which **must be a registered SecSign ID** in the Signature Portal. Confirm the FSM user's email is a **TÜV NORD** address (e.g. `egleizds@tuev-nord.de`) and that `egleizds` exists as a SecSign ID. The app surfaces this as a localized `signerNotRegistered` message instead of a raw 404 (`SIGNER_NOT_REGISTERED`, HTTP 422). If some users' emails don't map cleanly to their SecSign user name, that mapping is the thing to verify. |
| "Several selected documents have the same file name" | Two selected attachments are indistinguishable for SecSign | Expected. Sign them one at a time, or rename one in FSM. |
| Returned from portal but nothing signed | Portfolio not finished, or technician went back | The poll requires `portfoliostate === 3`. Check `[SecSignService] Portfolio N not finished after 6 checks`. If the technician declined, this is expected — nothing changes. |
| "Session expired" warning after signing | App restarted/redeployed while the technician was on the portal | Nothing was written to FSM. Re-open from FSM Mobile and sign again (by design — see `docs/SECURITY.md`, accepted risk #3). |
| "Could not finalize signing: The signed documents could not be matched…" | A ZIP entry name does not match a requested document | Nothing was changed. Find `finalize-signed MAPPING FAILED` in the log: it lists `missing`, `ambiguous` and `available` names, and the line before it shows the full `ZIP entries` listing. Compare them with the rules in [Core Concepts](#-core-concepts) — a new SecSign naming convention would show up here. |
| "Select all" selects signed rows | — | Fixed: signed rows are stripped from selection in `onSelectionChange`. If seen, confirm the deployed controller has that logic. |
| Wrong UI language | FSM context language not applied | Check `[View1] Setting language to '<code>'` in logs. Mobile sends `language`; if absent, the UI stays in the default. |
| FSM calls fail with auth errors | FSM destination misconfigured | Verify `FSM_OAUTH_CONNECT`, OAuth credentials, and `account`/`company` additional properties. |
| A change to a BTP destination has no effect | Destination cache (10 min) | Wait 10 minutes or `cf restart`. |
| Deploy fails to bind / 404 on staging | Destination service instance missing | Create `fsm-secsignsignatureext-destination` (unsuffixed) in the subaccount before deploy. |
| Deploy succeeds but a dependency is missing at runtime | npm dep not declared in `package.json` | CF silently omits undeclared deps. Confirm `adm-zip`, `cookie-parser`, `axios`, `express`, `form-data` are all in `dependencies`. |

### Backend Error Logs

Key failure points log the step, status, and detail on one line:

[Server] FATAL: FSM_WEBCONTAINER_AUTH_KEY is not set. Refusing to start.
[Context] WC-ACCESS-POINT: rejected POST — authenticationKey invalid or missing
[Context] GET context: rejected — requested '<key>' does not match session '<key>'   (→ 403)
[SecSignService] Trigger error: <status> <message>
[Signing] Trigger failed: Signer not registered in SecSign: <userName>   (→ 422 SIGNER_NOT_REGISTERED, localized dialog)
[Signing] Trigger rejected — duplicate file names in batch: <names>   (→ 400 DUPLICATE_FILENAMES)
[SecSignService] Portfolio <id> not finished after 6 checks (state: <state>)
[Attachments] Portfolio <id> not signed (state: <state>) — leaving attachments unchanged
[SignedZipExtractor] ZIP entries (<n>): <name> | <name> | …
[Attachments] finalize-signed MAPPING FAILED | portfolioId: <id> | missing: [...] | ambiguous: [...] | available: [...] | no attachments were changed

Auth rejections log as `AUTH: rejected ... source=<cookie|none>`. Successful
writes stay quiet by design. `[DestinationService] Loaded: <name> (cached for 10 min)`
appears at most once per destination per 10 minutes.

---

## 📝 Application Details

|                          |                                              |
|--------------------------|----------------------------------------------|
| **App Name**             | SecSignSignatureExt                          |
| **Module Name**          | com.tns.fsm.secsignsignatureext.app          |
| **CF App Name**          | tns-fsm-secsignsignatureext-ui (DevOps) / tns-fsm-secsignsignatureext-ui-sandbox (local) |
| **Framework**            | SAP UI5 (Fiori) + Node.js Express            |
| **UI5 Theme**            | sap_horizon                                  |
| **Min UI5 Version**      | 1.144.1                                      |
| **Deployment Platform**  | SAP Business Technology Platform (Cloud Foundry, eu10-004) |
| **Node.js Version**      | 18+                                          |
| **Destinations**         | FSM_OAUTH_CONNECT (OAuth2 client credentials) · SECSIGN_CONNECT (BasicAuthentication) |
| **Outbound Auth**        | OAuth 2.0 (FSM) + BasicAuthentication (SecSign) via BTP Destination Service |
| **Inbound Auth**         | Authentication Key + session cookie (Mobile, active) |
| **Operated Context**     | FSM Mobile Web Container (Standalone retained for dev) |

---

## 🚀 Current Status

### ✅ Implemented

**Context & Integration**
- Mobile Web Container context resolution (cloudId, objectType, user, locale)
- UI language switching from FSM context (German / English)
- Standalone context path retained for pure-frontend dev
- Inbound Mobile auth: Authentication Key (Tier 1) + sliding 60-min session cookie (Tier 3)
- Authentication Key never stored or returned to the browser; context readable only by its own session

**Attachment & Viewing**
- Attachment list for the context Activity with signed status via `Z_Attachment_PDFSigned`
- List loads metadata only; PDFs downloaded only when opened or signed
- Error strip for a failed list load (session expired / could not be loaded) and for a launch without an Activity
- Inline PDF viewer streamed from the backend
- Logged-in user name + email in the header (FSM User API)

**Signing Pipeline**
- Single-document and batch signing in one SecSign portfolio (`advanced-signature`)
- Fixed on-page signature position (signer positions nothing)
- Bounded completion poll — only proceeds when the portfolio reaches FINISHED (state 3)
- Signed ZIP mapping by file name, all-or-nothing, following SecSign's `-signed` / `_` renaming
- Write-back of signed content + `Z_Attachment_PDFSigned = true` per attachment
- Already-signed rows locked out of selection and re-signing
- Session expiry during signing surfaced as "sign again"; leftover batches of other Activities ignored

**Architecture / Tooling**
- Backend split by domain (`routes/`, `utils/auth/`, `utils/fsm/`, `utils/signing/`)
- Centralized signing config (`signing.config.js`)
- Outbound caching: BTP destinations (10 min, per name), FSM token (shared refresh), signed-UDF meta (once per list load)
- German + English i18n bundles
- Sandbox + mtar deployment split (local `cf push` / DevOps mtar)

### 📋 Planned

- **JWT verification / Web UI path** — not implemented; would be required if a Web UI Shell
  context is ever added (cookies are blocked in the iframe — needs a Bearer path)
- **TLS verification on SecSign calls** — currently disabled (`rejectUnauthorized: false`);
  needs the portal's CA chain (open item in `docs/SECURITY.md`)
- **Per-request entitlement** (attachment/object ids checked against the launched Activity;
  signer derived server-side) — accepted risk for now, implementation kept aside
- **Input validation / UUID guards** on `/api/*` params (CoreSQL injection hardening)
- Persistent session/context storage (currently in-memory; requires `instances: 1`)
- Eventual-consistency handling on post-sign refresh (brief retry if FSM lags)
- Auth Key rotation runbook hardening

---

## 🔐 Security Notes

> **Status: as-built (Mobile active path).** Inbound authentication is implemented for
> the FSM Mobile Web Container flow. See [docs/SECURITY.md](docs/SECURITY.md) for the full
> model, threat table, accepted risks and open items.

**Implemented**
- **Inbound (Mobile):** the Web Container entry POST validates the FSM **Authentication Key**
  (constant-time compare, `SessionStore.isValidAuthKey`) and issues an HttpOnly **session
  cookie** with a sliding 60-minute TTL. The `requireSession` middleware guards every
  `/api/*` route and `/web-container-context`; `SameSite=Lax` lets the cookie survive the
  SecSign GET-redirect return. The app **fails to start** without `FSM_WEBCONTAINER_AUTH_KEY`.
- **Authentication Key** is discarded after validation — never stored, never returned to
  the browser. **`/web-container-context`** returns only the caller's own context (403 otherwise).
- **Outbound OAuth** to FSM via the BTP Destination Service (`FSM_OAUTH_CONNECT`) and
  **BasicAuthentication** to SecSign (`SECSIGN_CONNECT`); credentials live in VCAP_SERVICES
  (BTP-managed); destinations and FSM tokens cached in memory only.
- **Session/context** stored **in memory**, cleared on restart. HTTPS enforced by CF.
- **Signing safety:** write-back occurs only after the portfolio is confirmed FINISHED and
  every signed PDF is matched to its attachment unambiguously; otherwise nothing is
  written. A mid-signing server restart is surfaced to the technician ("sign again").

**Known gaps (tracked in `docs/SECURITY.md` — "Accepted risks" and "Open item")**
- **No FSM Web UI / JWT path.** The app is Mobile-only. If a Web UI context is added, it
  needs a separate Bearer-token auth path (browsers block third-party cookies in the iframe).
- **Per-request entitlement** is not enforced: ids and the signer email come from the
  client (accepted risk — requires a valid session and deliberate tampering).
- **TLS verification disabled** on SecSign calls (open item).
- **Input validation / UUID guards** on `/api/*` params (CoreSQL) recommended.

---

## 📄 License

Internal use only — Company proprietary.

---

**Last Updated:** October 2026
