# tng-fsm-secsignsignatureext-ui-dev

FSM Document Signing App — SAP Fiori UI5 frontend + Node.js/Express backend deployed on SAP BTP Cloud Foundry.

Enables FSM technicians to view, sign, and merge PDF attachments linked to FSM Activities, running in two contexts:
- **FSM Mobile** via Web Container (standalone WebView)
- **FSM Web UI** via Shell Extension (iframe)

---

## Project Structure

```
tng-fsm-secsignsignatureext-ui-dev/
│
├── index.js                          # Server entry point – middleware, routes, listen
│
├── routes/                           # Express route handlers (one file per domain)
│   ├── context.js                    # POST /web-container-access-point
│   │                                 # GET  /web-container-context
│   ├── attachments.js                # GET  /api/attachments/:objectId
│   │                                 # GET  /api/attachment-content/:id
│   │                                 # GET  /api/attachment-pdf/:id
│   │                                 # POST /api/attachments/merge
│   │                                 # GET  /api/attachments/merged/:uuid
│   └── signing.js                    # POST /api/signing/trigger
│
├── utils/                            # Backend services
│   ├── fsm/                          # SAP FSM API integration
│   │   ├── FSMService.js             # FSM Data + Query API calls
│   │   ├── DestinationService.js     # BTP Destination Service resolution
│   │   └── TokenCache.js            # OAuth token caching
│   └── signing/                      # Signing backend services
│       ├── CIService.js              # SAP Integration Suite iFlow calls
│       ├── SecSignService.js         # SecSign direct API calls
│       └── signing.config.js        # SIGNING_TARGET: 'ci' | 'secsign' | 'both'
│
└── webapp/                           # SAPUI5 frontend
    ├── controller/
    │   ├── App.controller.js         # Shell controller (empty)
    │   └── View1.controller.js       # Main view – UI state only, delegates to services
    │
    ├── utils/
    │   ├── services/                 # Frontend service layer
    │   │   ├── ContextService.js     # FSM context detection (Mobile + Shell SDK)
    │   │   ├── AttachmentService.js  # Attachment list, content, PDF URL, merge
    │   │   └── SigningService.js     # Trigger signing workflow
    │   └── helpers/                  # (reserved for future formatters/validators)
    │
    ├── view/
    │   ├── App.view.xml              # Root shell view
    │   └── View1.view.xml            # Main view: attachments table + PDF viewer
    │
    ├── i18n/
    │   └── i18n.properties           # UI labels and translations
    ├── css/
    │   └── style.css                 # Custom styles
    ├── model/
    │   └── models.js                 # Device model factory
    ├── Component.js                  # UI5 app bootstrap
    ├── index.html                    # UI5 CDN bootstrap (frame-options: allow)
    ├── manifest.json                 # App descriptor: routing, models, libs
    └── mock-signing.html             # Mock SecSign portal (testing only – remove before go-live)
```

---

## Architecture

```
FSM Mobile (Web Container)              FSM Web UI (Shell Extension)
         │                                         │
         │ POST /web-container-access-point         │ fsm-shell SDK
         ▼                                         ▼
    Express Backend (index.js)
         │
         ├── routes/context.js          ← session storage + context serving
         ├── routes/attachments.js      ← FSM attachment fetch + PDF merge
         └── routes/signing.js          ← SAP CI / SecSign trigger
                    │
          ┌─────────┴─────────┐
          ▼                   ▼
    utils/fsm/          utils/signing/
    FSMService          CIService  (current)
    DestinationSvc      SecSignService (production)
    TokenCache          signing.config.js  ← switch target here
```

---

## Signing Flow

```
1. User presses "Sign PDF"
      ↓ SigningService.triggerSigning()
      ↓ POST /api/signing/trigger
      ↓ Backend fetches PDF buffer from FSM
      ↓ Sends multipart/form-data to target (CI or SecSign)
      ↓ Response contains workflowstepurl

2. window.location.href = workflowstepurl
      ↓ WebView navigates to signing portal

3. User signs document in portal
      ↓ Portal redirects to redirecturl (your app URL + ?signed=true)

4. App detects return via URL params
      ↓ Marks row as signed in UI
```

---

## Switching Signing Target

Edit **one line** in `utils/signing/signing.config.js`:

```javascript
const SIGNING_TARGET = 'ci';      // SAP CI iFlow (current)
const SIGNING_TARGET = 'secsign'; // SecSign direct (production)
const SIGNING_TARGET = 'both';    // Both in parallel (testing)
```

---

## BTP Destinations Required

| Destination        | Auth Type           | Used by          |
|--------------------|---------------------|------------------|
| `FSM_OAUTH_CONNECT`| OAuth2ClientCredentials | FSMService   |
| `CI_BASIC_CONNECT` | BasicAuthentication | CIService        |
| `SECSIGN_CONNECT`  | NoAuthentication    | SecSignService   |

---

## Running Locally

```bash
npm install
npm start          # starts Express on port 3000
```

## Deploying to BTP Cloud Foundry

```bash
npm install
cf push            # uses manifest.yaml
```

---

## Application Details

| | |
|---|---|
| **Module Name** | tng-fsm-secsignsignatureext-ui-dev |
| **Generation Platform** | SAP Business Application Studio |
| **UI5 Version** | 1.144.1 |
| **UI5 Theme** | sap_horizon |
| **Node.js** | >= 18.0.0 |
| **BTP Region** | EU10 |