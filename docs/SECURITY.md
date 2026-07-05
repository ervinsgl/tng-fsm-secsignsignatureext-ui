# Security Architecture

> **Status:** Approved deviation from BTP coding guideline (Programmierrichtlinie für SAP-Erweiterungen §10).
> **Last updated:** April 2026 (cleanup pass — removed dead cookie path and request-gate machinery)
> **Owner:** [Team or person responsible — fill in]
> **Architecture approval:** [Approver name and date — fill in per Programmierrichtlinie §12]

## Purpose of this document

This document describes the inbound authentication and authorization model of the
T&M Journal app, why it differs from the company's standard XSUAA/OAuth2 pattern,
and what the operational characteristics of the current model are. It is intended for:

- Developers maintaining or extending this app.
- Architects reviewing the app's compliance with internal coding standards.
- Auditors verifying that security trade-offs have been deliberately made and documented.

If you are reading this because you are about to change anything in `index.js` related
to `requireSession`, the WebContainer POST handlers, the `/api/v1/shell-session-init`
endpoint, the `fsm_session` cookie, the `FSMJwtValidator`, the FSM Authentication Key,
or the bootstrap order in `View1.controller.js` `_initializeAsync()` —
**read this document first.**

---

## Summary

The app implements a **two-path inbound authentication model**, with full
session-based authentication on every API call. Each path uses a different
session-token delivery mechanism, but both reach the same backend session store.

| Path | Auth source | Token delivery |
|---|---|---|
| FSM Mobile WebContainer | Authentication Key (shared secret) | HttpOnly cookie (`fsm_session`) |
| FSM Web UI Shell extension | FSM JWT signature verification | `Authorization: Bearer <token>` header |
| Direct standalone URL | None — no longer functional | n/a |

The app does **not** use SAP XSUAA or IAS for inbound authentication. This is a
deliberate, approved deviation from the Programmierrichtlinie §10. Reasons documented
below.

The app does use the SAP BTP Destination Service with OAuth2 for **outbound**
authentication to FSM APIs. Outbound credentials are unaffected by this model and
remain compliant with the Programmierrichtlinie.

---

## Architecture context

The T&M Journal app is launched in three different contexts. Each delivers a
different authentication signal, and the app handles each one accordingly.

### Context 1 — FSM Mobile WebContainer

The app is opened as a WebContainer inside the FSM Mobile native app on a
technician's phone. FSM Mobile sends an HTTP `POST` request to
`/web-container-access-point` with the user's session context (cloudId, userName,
account, company, etc.) and an Authentication Key value configured in FSM Admin.
The app then renders inside the FSM Mobile WebView.

**Authentication path:** Authentication Key → session cookie issued on success.

This is the primary, most-used context.

### Context 2 — FSM Web UI Shell extension

The app is opened as an iframe-embedded extension inside the FSM Web UI. The iframe
loads via `GET /` directly. There is no entry POST. Context is delivered via the
`fsm-shell` SDK, which uses `postMessage` to communicate with the FSM Web UI host
page. The Shell context includes an `access_token` field — a real RS256-signed JWT
issued by FSM's `cloud-authentication-service-de`.

**Authentication path:** Frontend captures the JWT from the Shell SDK, POSTs it
to `/api/v1/shell-session-init`. Backend verifies the JWT signature against FSM's
public JWKS endpoint and returns a session token in the response body. Frontend
stores the token in memory and attaches it to subsequent `/api/v1/*` requests as
`Authorization: Bearer <token>`.

This context is occasionally used.

### Context 3 — Standalone URL

A developer or tester opens the app directly in a browser with URL parameters
(`?activityId=...` or `?serviceCallId=...`). After the strict-auth implementation,
this context **does not authenticate** and `/api/v1/*` calls return 401.

This context is now a development-only mode that requires real Mobile or Web UI
context to function. If a local-development bypass becomes needed, it should be
implemented as a clearly-named env var (e.g., `DEV_BYPASS_AUTH=true`) that is
never set on production environments.

---

## Why two delivery mechanisms (cookie vs Bearer header)

This is the most easily-misunderstood part of the architecture, so it gets its
own section.

The session token (random 32 bytes, base64url-encoded) is the same in both
flows. The backend `requireSession` middleware accepts it from either source.
What differs is **how the browser receives it and sends it back.**

### Why Mobile uses a cookie

The FSM Mobile WebView is a top-level browsing context. Cookies set on a
response from your app's domain are first-party from the WebView's perspective.
The browser stores them, the browser sends them on every subsequent request to
your domain. This is exactly how cookies are designed to work, and it works
reliably.

Mobile flow uses an HttpOnly cookie because:

- HttpOnly prevents JavaScript from reading the cookie, mitigating XSS-based
  session theft.
- The cookie is sent automatically by the browser on every request to your
  domain — no per-request frontend code needed.
- The Mobile WebView reliably stores it.

### Why Web UI cannot use a cookie

The FSM Web UI loads your app in an iframe. The iframe's domain
(`com.tng.fsm.timematerialext.app-fsm-dev-op.cfapps.eu10-004.hana.ondemand.com`) is different from
the parent page's domain (`de.fsm.cloud.sap`). From the browser's perspective,
the iframe is **third-party** content embedded in a first-party page.

Modern browsers — Edge, Chrome, Safari, Firefox — block third-party
cookies in this context regardless of `SameSite=None; Secure` attributes. The
browser receives the `Set-Cookie` response header, **but silently does not
store it**. Subsequent requests from the iframe carry no cookie. All
`/api/v1/*` calls return 401.

This was confirmed empirically during implementation: `document.cookie` after
a `Set-Cookie` response showed no `fsm_session` value, only pre-existing
tracking cookies.

The `/api/v1/shell-session-init` endpoint therefore deliberately does NOT
attempt to set a cookie. It returns the session token in the JSON response
body, and the frontend uses that token as a Bearer credential.

### How the Bearer header works

After `/api/v1/shell-session-init` succeeds, the backend returns the session
token in the JSON response body. The frontend reads the token from the response
and stores it on `window.__fsmSessionToken`. The global fetch wrapper in
`webapp/Component.js` checks for this value on every `/api/v1/*` request and
attaches it as `Authorization: Bearer <token>` if present.

The token is only in memory. When the iframe is closed or refreshed, the token
is gone — same security characteristic as a session cookie. The token is
JavaScript-readable in principle, but the iframe is sandboxed from the parent
(your code is the only thing inside the iframe), so the practical XSS surface
is essentially the same as before.

---

## What is implemented

### Tier 1 — Authentication Key on Mobile WebContainer entry POSTs

**Mechanism:** Shared secret between FSM and the app.

**FSM side:** The Authentication Key is configured in FSM Admin →
Companies → [Company] → Web Containers → [Web Container] → Authentication Key.
FSM Mobile reads this value during sync and includes it as the `authenticationKey`
field in the body of every WebContainer POST.

**App side:** The value is stored as the `FSM_WEBCONTAINER_AUTH_KEY` environment
variable in Cloud Foundry (`cf set-env`). The Express server validates the
`authenticationKey` field on every POST to `/web-container-access-point` and
`POST /` using a constant-time comparison (`crypto.timingSafeEqual`) to prevent
timing attacks. Mismatches return HTTP 401 and are logged.

**Threat blocked:** A random attacker who knows the URL cannot inject fake context
into the app's session store. They would need the secret, which is known only to
FSM Mobile clients (transmitted internally during sync).

**Rotation procedure:**
1. Update FSM Admin → Web Containers → Authentication Key field.
2. Wait briefly for the change to propagate.
3. `cf set-env com.tng.fsm.timematerialext.app FSM_WEBCONTAINER_AUTH_KEY <new>` and
   `cf restage com.tng.fsm.timematerialext.app`.
4. Active Mobile WebContainer launches return 401 during the brief window
   between FSM update and CF restage; users retap to launch with the new key.

### Tier 2 — JWT signature verification for Web UI Shell

**Mechanism:** Cryptographic verification of FSM-issued JWTs against FSM's public
JWKS endpoint.

**FSM side:** When a user launches the T&M Journal extension from FSM Web UI,
the Shell SDK provides an `access_token` (JWT, RS256-signed) in the Shell context.
This token is bound to the user's authenticated FSM Web UI session and includes
their identity (user_name, user_email), account context, and an expiration claim.

**App side:** The frontend `ContextService.js` calls
`POST /api/v1/shell-session-init` with the JWT in the body. The Express server
delegates to `utils/FSMJwtValidator.js`, which uses `jsonwebtoken` and `jwks-rsa`
to fetch FSM's public signing key and verify the JWT signature, expiration, and
algorithm. On success, the user's identity is extracted from the validated payload,
a session token is issued, and the token is returned in the response body.

**JWKS endpoint (DE region):**
`https://de.fsm.cloud.sap/api/oauth2/v2/.well-known/jwks.json`

The endpoint is overridable via `FSM_JWKS_URL` for other regions or environments.

**Key safety properties of the validator:**
- Algorithm allow-list (`['RS256']`) — prevents the `alg: none` JWT downgrade
  attack and HS256-vs-RS256 confusion attacks.
- Public keys cached for 24 hours — FSM keys rotate rarely; we don't fetch on
  every request.
- JWKS fetch rate-limited to 10/minute — prevents catastrophic re-fetching if
  the cache is bypassed.
- Default `jsonwebtoken` expiration and notBefore validation enabled.

**Threat blocked:** A random attacker who knows the URL cannot establish a session
without a valid FSM-issued JWT. They cannot forge a JWT because they don't have
FSM's signing key. Replaying an intercepted token expires within ~24 hours, and
even within that window the attacker would need network access from a context
that the JWT permits.

### Tier 3 — Session token on subsequent requests

**Mechanism:** Server-issued opaque session token. Delivered via either an
HttpOnly cookie (Mobile flow) or an Authorization Bearer header (Web UI flow).

**Issuance:** When either of the two authentication flows above succeeds, the
server generates a cryptographically random 32-byte token (`crypto.randomBytes(32)`),
stores it in an in-memory `sessionStore` keyed to the user's context, and either:

- Sets the `fsm_session` cookie on the response (Mobile flow only — done in
  the WebContainer POST handler).
- Returns the token in the JSON response body of `/api/v1/shell-session-init`
  (Web UI flow only — no cookie attempted because browsers won't store it
  in the iframe context).

**Cookie attributes (Mobile flow):** `HttpOnly`, `Secure`, `SameSite=Lax`,
`Path=/`, `Max-Age=1800` (30 minutes).

- `HttpOnly` — JavaScript cannot read the cookie. Mitigates XSS-based session
  theft for the Mobile flow.
- `Secure` — only transmitted over HTTPS. CF enforces HTTPS.
- `SameSite=None` — kept from the original cookie-only design. Could be
  `Lax` for the Mobile WebView's first-party context, but `None` is harmless
  here and avoids potential edge cases on older WebView implementations.
- `Max-Age=1800` — cookie expires after 60 minutes. The server-side
  `sessionStore` has a matching 60-minute TTL but is **sliding** — every
  authenticated request resets the expiration. Active users effectively
  never expire; only sessions truly idle for 60 minutes get expired.
  The cookie's `Max-Age` is also refreshed on every authenticated request
  for the cookie flow (Mobile), so browser-side expiry stays in sync with
  server-side.
  `sessionStore` has a matching TTL with eviction on every entry POST.

**Bearer token storage (Web UI flow):** The token returned in the JSON response
is stored on `window.__fsmSessionToken` by `ContextService.js` after Shell session
init succeeds. The global fetch wrapper in `webapp/Component.js` reads this value
on every `/api/v1/*` request and attaches it as `Authorization: Bearer <token>`
if present. The token is held in memory only; it is cleared automatically when
the iframe is reloaded, navigated away from, or closed. Same effective lifetime
as the cookie.

**Validation:** The `requireSession` middleware (used on all `/api/v1/*` routes
except `/api/v1/shell-session-init`, and on `/web-container-context`) checks
both sources:

1. `fsm_session` cookie — checked first
2. `Authorization: Bearer <token>` header — checked second if no cookie

Whichever source provides a valid token, the request proceeds. Missing or
invalid sessions return HTTP 401. Logs include `source=cookie` or `source=bearer`
to make the auth path visible in operational data.

---

## Bootstrap sequencing

The frontend bootstrap order matters and is enforced in
`webapp/controller/View1.controller.js` `_initializeAsync()`. The dependency
chain is:

```
auth context → type config → activity loading
auth context →             → org levels  
auth context →             → cache warm
auth context →             → org hierarchy
```

Concretely, `_initializeAsync()` does:

1. `await this._loadWebContainerContext()` — establishes auth (cookie set by
   Mobile flow already, or Bearer token stored by Web UI flow).
2. `await TypeConfigService.init()` — calls `/api/v1/get-type-config` which
   needs auth; falls back to built-in defaults on failure.
3. Fires `_loadOrganizationLevels()`, `_loadOrganizationalHierarchy()`, and
   `CacheService.warmAllCaches()` in parallel — all need auth, none depend on
   each other.

Steps 1 and 2 are awaited because subsequent work depends on them. Step 3's
items run in parallel because they're independent.

`onInit()` itself is **synchronous** and only does:

```javascript
onInit() {
    TMDialogService.init(this);
    this._initializeModel();      // creates the view model — must exist before user can click anything
    this._initializeAsync();      // fire-and-forget, runs the chain above
}
```

This satisfies the UI5 lifecycle contract (event listeners must return
`undefined`, not a Promise) AND ensures the view model exists before the view
renders, so the Refresh button (and similar) cannot be clicked before its
handler's prerequisites exist.

This explicit sequencing is the only mechanism preventing `/api/v1/*` calls
from racing ahead of session establishment. **Do not break this ordering** —
if any new code path fires `/api/v1/*` during bootstrap, it must either be
called from after `_loadWebContainerContext()` resolves, or have its own
explicit await on context resolution.

---

## What is no longer applicable (historical)

### Web UI carve-out (closed April 2026)

Prior to the Bearer-token implementation, the `/api/v1/*` middleware was lenient
("`optionalSession`") to allow the Web UI Shell flow to function despite never
receiving a session cookie. Anyone with the URL could call any `/api/v1/*`
endpoint without authentication.

This carve-out has been removed. All `/api/v1/*` endpoints now require a
valid session token, supplied via either cookie (Mobile) or Bearer header
(Web UI).

### Cookie-only model for Web UI (April 2026, brief)

For a brief period during implementation, the Web UI flow attempted to use a
cookie alone (with `SameSite=None; Secure`). The HTTP handshake worked but
failed silently because the browser refused to store the cookie due to
third-party context blocking.

The Bearer-header mechanism replaced this. The cookie set on Web UI's
`/api/v1/shell-session-init` was kept briefly as a fallback, then removed
once it was confirmed to never have effect.

### Standalone URL flow (now requires a real session)

Prior to strict authentication, the lenient middleware allowed standalone URL
mode (`?activityId=...`) to function. With strict authentication in place,
standalone mode now returns 401 on all API calls. Standalone is treated as a
development-only mode; for normal access, use FSM Mobile or Web UI.

---

## Why not XSUAA / IAS / Federated Authentication

This was the first option evaluated. It was rejected for the following reasons:

1. **FSM Mobile WebContainer flow is not compatible with browser-based login redirects.**
   XSUAA's authentication model relies on redirecting the user agent to an IAS
   login page, completing a SAML/OIDC flow, and redirecting back. The FSM Mobile
   WebView does not handle this cleanly — login state established inside the
   WebView often does not persist across WebContainer launches, and FSM Mobile
   does not pass any IAS-recognized authentication context into the WebView.

2. **Documented industry experience.** SAP community posts (e.g.,
   *"Developing a SAP FSM extension on SAP BTP CF using Federated Authentication"*)
   describe XSUAA-protected extensions failing during installation in FSM
   Extension Management. The clean integration path for XSUAA+IAS targets FSM
   Web UI only and requires a separate auth path for FSM Mobile WebContainer.
   Maintaining two parallel authentication systems would be more complex than
   the current model, which uses two well-defined flows with shared session-token
   infrastructure.

3. **Cost-benefit ratio.** Implementing full XSUAA+IAS+approuter would take an
   estimated 2-3 days of work, plus coordination with the BTP admin and IAS
   tenant configuration. The current model — Authentication Key for Mobile
   plus FSM JWT validation for Web UI — was implemented in a few hours and
   provides cryptographic verification of user identity for both flows. The
   incremental security benefit of XSUAA+IAS over the current model does not
   justify the cost or the operational complexity at this time.

This decision should be revisited if any of the following change:
- The company mandates XSUAA on all BTP applications without exceptions.
- A compliance or audit requirement specifically demands XSUAA on inbound paths.
- FSM Mobile changes its WebContainer auth model in a way that aligns with XSUAA.

---

## Operational notes

### Required environment variables

| Variable | Required | Purpose |
|---|---|---|
| `FSM_WEBCONTAINER_AUTH_KEY` | Yes — server refuses to start without it | Shared secret matching the FSM Web Container Authentication Key. Set via `cf set-env` and `cf restage`. |
| `FSM_JWKS_URL` | No (default: DE region) | URL of FSM's public JWKS endpoint. Default is `https://de.fsm.cloud.sap/api/oauth2/v2/.well-known/jwks.json`. Override for other regions. |

### Required FSM configuration

| Setting | Where | Value |
|---|---|---|
| Authentication Key | FSM Admin → Companies → [Company] → Web Containers → [TUVNcom.tng.fsm.timematerialext.appJournal] | Must byte-exactly match `FSM_WEBCONTAINER_AUTH_KEY` env var |

### In-memory state

- `contextStore` — Map from contextKey (`<userName>_<cloudId>`) to FSM context
  data. TTL 60 minutes, sliding (extended on every authenticated request to
  the matching session). In-memory only; not persisted.
- `sessionStore` — Map from session token to contextKey + expiration timestamp.
  TTL 60 minutes, sliding. In-memory only; not persisted.
- `FSMJwtValidator` JWKS cache — Map from `kid` to public key, managed by
  `jwks-rsa`. TTL 24 hours.
- `window.__fsmSessionToken` (browser-side, Web UI flow only) — In-memory holder
  of the session token, cleared on iframe reload/navigation.

All four reset on container restart (server side) or iframe reload (browser
side). Active sessions become invalid on server restart; users must re-launch
the app from FSM Mobile or refresh the FSM Web UI extension. This is acceptable
for a single-instance deployment; would need migration to Redis or similar
for horizontal scaling. See `manifest.yaml` (currently `instances: 1`).

### Log signals

| Log prefix | Meaning |
|---|---|
| `WC-ACCESS-POINT: context stored, session issued` | Successful Mobile entry |
| `WC-ACCESS-POINT: rejected POST — authenticationKey ...` | Mobile entry with bad/missing auth key — investigate if frequent |
| `SHELL-INIT: session issued` | Successful Web UI entry, JWT verified |
| `SHELL-INIT: rejected — JWT validation failed: ...` | Web UI entry with invalid JWT — could be expired token (benign) or attempted forgery (investigate) |
| `SHELL-INIT: rejected — missing authToken in body` | Frontend bug or tampering — Web UI client should always send the token |
| `AUTH: rejected ... missing-credential ... source=none` | Endpoint hit without cookie or Bearer — direct attack attempt, or bootstrap sequencing was broken |
| `AUTH: rejected ... invalid-or-expired ... source=cookie` | Mobile cookie expired or tampered — typically benign (user idle past TTL) |
| `AUTH: rejected ... invalid-or-expired ... source=bearer` | Web UI Bearer token expired or tampered — typically benign (user idle past TTL or iframe alive past 30 min) |
| `CONTEXT-FETCH: session ... attempted to read ...` | Cross-context read attempt — investigate immediately, this should not happen in normal use |

---

## Compliance reference (Programmierrichtlinie)

- **§7 (API Versioning):** Compliant. All routes mounted at `/api/v1`. Future
  breaking changes will use `/api/v2` alongside, never replacing v1.
- **§10 (Security — XSUAA, OAuth2):** Deliberate deviation. The guideline specifies
  "XSUAA, OAuth2" for inbound auth. This app uses Authentication Key (Mobile flow)
  + FSM JWT signature verification (Web UI flow), both backed by HttpOnly cookies
  or Bearer tokens depending on context. All inbound paths to `/api/v1/*` are
  cryptographically authenticated. This deviation has been approved per §12
  ("Abweichungen nur mit Architekturfreigabe") on **[date]** by **[approver]**.
- **§10 (No hardcoded secrets):** Compliant. Authentication Key is read from
  environment variable. JWKS URL has a code default that can be overridden via
  env var. Outbound FSM credentials come from the BTP Destination Service binding.
- **§10 (Secrets via service bindings):** Partially compliant. Authentication Key
  is via env var rather than a user-provided service. Defensible for a single
  secret; can be migrated to a service binding if company governance requires it.

---

## Threat model summary

| Threat | Mitigation |
|---|---|
| Anonymous attacker POSTs fake context to `/web-container-access-point` | Authentication Key required — attacker would need the FSM-side secret |
| Anonymous attacker calls `/api/v1/*` directly with no credentials | `requireSession` rejects with 401 |
| Attacker forges a fake JWT to reach `/api/v1/shell-session-init` | RS256 signature verification against FSM's JWKS — attacker doesn't have FSM's private key |
| Attacker presents a valid but expired JWT | Rejected by `jsonwebtoken`'s expiration check |
| Attacker downgrades a token to `alg: none` | Rejected by validator's algorithm allow-list (`['RS256']`) |
| Attacker substitutes HS256 token signed with the public key | Rejected by validator's algorithm allow-list |
| Attacker reads `/web-container-context?key=guess` | `requireSession` + cross-context check — must own the contextKey |
| Cookie theft via XSS (Mobile flow) | Cookie is HttpOnly — JS cannot read it |
| Bearer token theft via XSS (Web UI flow) | Token is JS-readable, but the iframe is sandboxed from the parent page — XSS would have to come from inside the iframe (i.e., from your own code) |
| Cookie/Bearer theft via network sniffing | All transport is HTTPS-only; CF enforces HTTPS |
| Session reuse after logout/timeout | Server-side `sessionStore` lookup — expired entries removed on every entry POST or session-init call |
| Privileged technician misuses FSM API via leaked token | Mitigated by sliding 60-minute idle TTL — a leaked but unused token expires after 60 min, but an actively-used leaked token could remain valid indefinitely until the WebView/iframe is closed. Same residual risk as any session-token auth with sliding refresh. |

---

## When to revisit this document

Update this document whenever any of the following change:

- The auth mechanism on any endpoint (e.g., adding XSUAA, adding new entry
  flows, modifying JWT validation, changing the session-init endpoint).
- The token delivery mechanism on either flow (e.g., switching Web UI from
  Bearer back to cookie, adding token persistence to localStorage).
- The cookie attributes (e.g., changing `SameSite`, the TTL, or the cookie name).
- The `FSM_WEBCONTAINER_AUTH_KEY` rotation procedure.
- The `FSM_JWKS_URL` (e.g., switching regions or environments).
- A new context (beyond Mobile / Web UI / Standalone) is added to the app.
- The session storage is moved from in-memory to Redis or similar (would change
  the multi-instance scaling section).
- The bootstrap sequencing in `_initializeAsync()` changes (would change the
  "Bootstrap sequencing" section).
- A security incident affects this app.

The "Last updated" line at the top of this document MUST be kept current.