# Security Architecture

> **Status:** Approved deviation from BTP coding guideline (Programmierrichtlinie für SAP-Erweiterungen §10).
> **Last updated:** October 2026 (Authentication Key no longer stored or returned; context read restricted to the own session; context TTL decoupled from the session; accepted risks documented)
> **Owner:** [Team or person responsible — fill in]
> **Architecture approval:** [Approver name and date — fill in per Programmierrichtlinie §12]

## Purpose of this document

This document describes the inbound authentication and authorization model of the
FSM Document Signing app (SecSign extension), why it differs from the company's
standard XSUAA/OAuth2 pattern, and what the operational characteristics of the
current model are. It is intended for:

- Developers maintaining or extending this app.
- Architects reviewing the app's compliance with internal coding standards.
- Auditors verifying that security trade-offs have been deliberately made and documented.

If you are reading this because you are about to change anything in `index.js`
related to `requireSession`, the WebContainer POST handlers, the `fsm_session`
cookie, the `SessionStore`, the FSM Authentication Key, or the SecSign redirect
round-trip — **read this document first.**

---

## Summary

The app implements **session-based inbound authentication for the FSM Mobile
WebContainer flow**. Entry is gated by a shared Authentication Key; all
subsequent API calls require a session token delivered via an HttpOnly cookie.

| Path | Auth source | Token delivery |
|---|---|---|
| FSM Mobile WebContainer | Authentication Key (shared secret) | HttpOnly cookie (`fsm_session`) |
| FSM Web UI Shell extension | Not implemented — Web UI context not in scope | n/a |
| Direct standalone URL | None — no valid session, API calls return 401 | n/a |

The app does **not** use SAP XSUAA or IAS for inbound authentication. This is a
deliberate, approved deviation from the Programmierrichtlinie §10. Reasons
documented below.

The app does use the SAP BTP Destination Service with OAuth2 for **outbound**
authentication to FSM APIs (`FSM_OAUTH_CONNECT`) and BasicAuthentication to the
SecSign Signature Portal (`SECSIGN_CONNECT`). Outbound credentials are unaffected
by this model and remain compliant with the Programmierrichtlinie.

The model **authenticates** callers (only technicians who launched from FSM Mobile
get a session). It does **not** fully **authorize** each request against the
launched Activity — see [Accepted risks](#accepted-risks).

> **Scope note:** Only the FSM Mobile WebContainer context is currently used and
> secured. The FSM Web UI Shell extension (iframe) context is not in scope for
> this app; if it is added later, a second auth path (FSM JWT verification +
> Bearer token) will be required, because browsers block third-party cookies in
> the iframe context. See "When to revisit this document."

---

## Architecture context

The app is launched from the FSM Mobile native app as a WebContainer inside a
WebView on a technician's phone. FSM Mobile sends an HTTP `POST` to
`/web-container-access-point` with the user's session context (cloudId, userName,
account, company, language, etc.) and an Authentication Key value configured in
FSM Admin. The app then renders inside the FSM Mobile WebView.

**Authentication path:** Authentication Key → session cookie issued on success.

This is the only production context. A developer opening the app directly in a
browser without a valid session will receive 401 on all `/api/*` calls.

---

## The signing round-trip (SecSign)

This app's defining flow is a full-page redirect to an external signing portal
and back. Understanding it is essential to understanding why the cookie model works.

1. **Entry** — FSM Mobile POSTs context to `/web-container-access-point`. The
   Authentication Key is validated and discarded, the context is stored, and the
   `fsm_session` cookie is set on the redirect response. The cookie now lives in
   the WebView.
2. **Trigger** — the technician taps Sign. The frontend calls
   `POST /api/signing/trigger` (same-origin AJAX; cookie sent automatically).
   The backend fetches the PDF(s) from FSM, starts one SecSign portfolio
   workflow, and returns a `workflowstepurl`.
3. **Leave** — the browser navigates full-page to the SecSign portal (a
   different domain). The cookie is not sent to SecSign, and does not need to be.
4. **Return** — after signing, SecSign issues a **302 GET redirect** back to the
   app's `returnUrl` (`https://<app>/?session=<key>`). Because the return is a
   top-level GET navigation, the `SameSite=Lax` cookie is included on the
   request. The app reloads with the cookie intact.
5. **Finalize** — on reload, the frontend detects the pending batch (persisted in
   `localStorage`) and calls `POST /api/attachments/finalize-signed` (same-origin,
   cookie sent). The backend polls SecSign for portfolio completion, downloads
   the signed ZIP, maps each signed PDF to its attachment by file name, and
   writes the signed PDFs back to FSM. If any document cannot be matched
   unambiguously, nothing is written.

**Why the cookie survives the round-trip:** it is issued at *entry*, not at
signing time, so it is already stored before the technician leaves for SecSign.
The critical property is that SecSign returns via a **GET redirect**, which
`SameSite=Lax` permits. (A POST-back would strip a Lax cookie and break the
return; SecSign does not POST back.)

---

## What is implemented

### Tier 1 — Authentication Key on WebContainer entry POSTs

**Mechanism:** Shared secret between FSM and the app.

**FSM side:** The Authentication Key is configured in FSM Admin → Companies →
[Company] → Web Containers → [Web Container] → Authentication Key. FSM Mobile
reads this value during sync and includes it as the `authenticationKey` field in
the body of every WebContainer POST.

**App side:** The value is stored as the `FSM_WEBCONTAINER_AUTH_KEY` environment
variable in Cloud Foundry. `SessionStore.isValidAuthKey()` validates the
`authenticationKey` field on every POST to `/web-container-access-point` and
`POST /` using a constant-time comparison (`crypto.timingSafeEqual`) to prevent
timing attacks. Length mismatches short-circuit to reject. Mismatches return HTTP
401 and are logged. The server refuses to start if the env var is unset
(fail-fast guard in `index.js`).

**The key is never stored or returned.** After validation, `authenticationKey` is
removed from the POST body before the context is stored, so it can never reach
the browser through `GET /web-container-context`.

> **History:** until October 2026 the full POST body — including the key — was
> stored and returned to the browser in the context response. The key should be
> rotated once after that fix is deployed (procedure below), since it may be
> present in WebView logs or crash reports from before.

**Threat blocked:** A random attacker who knows the URL cannot inject fake
context into the app's session store. They would need the secret, which is known
only to FSM Mobile clients (transmitted internally during sync).

**Rotation procedure:**
1. Update FSM Admin → Web Containers → Authentication Key field.
2. Wait briefly for the change to propagate.
3. `cf set-env <app-name> FSM_WEBCONTAINER_AUTH_KEY <new>` and
   `cf restage <app-name>`.
4. Active WebContainer launches return 401 during the brief window between FSM
   update and CF restage; technicians re-tap to launch with the new key.

### Tier 3 — Session token on subsequent requests

**Mechanism:** Server-issued opaque session token, delivered via an HttpOnly
cookie.

**Issuance:** When the entry POST's Authentication Key check passes, the server
generates a cryptographically random 32-byte token
(`crypto.randomBytes(32).toString('base64url')`), stores it in the in-memory
`SessionStore` keyed to the context key (`<userName>-<cloudId>`), and sets the
`fsm_session` cookie on the redirect response.

**Cookie attributes:** `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`,
`Max-Age=3600000ms` (60 minutes).

- `HttpOnly` — JavaScript cannot read the cookie. Mitigates XSS-based session theft.
- `Secure` — only transmitted over HTTPS. CF enforces HTTPS.
- `SameSite=Lax` — sent on same-origin requests and on top-level GET navigations.
  This is what allows the cookie to ride along on the SecSign GET redirect back
  into the app.
- `Max-Age` / TTL — 60 minutes, **sliding**. Every authenticated request
  (`requireSession`) resets both the server-side expiry in `SessionStore` and the
  cookie's Max-Age, so an active technician effectively never expires. Only a
  session genuinely idle for 60 minutes is expired.

**Validation:** The `requireSession` middleware reads the `fsm_session` cookie,
validates it against `SessionStore.validateAndTouch()`, slides the TTL, and
refreshes the cookie Max-Age. Missing or expired sessions return HTTP 401. Logs
include the rejection reason and `source=cookie` / `source=none`.

**Protected routes:**
- `GET /web-container-context` (context retrieval) — additionally, the requested
  `?session=<key>` must equal the context key the cookie's session is bound to;
  otherwise HTTP 403. A technician can only read their own launch context.
- `GET /api/user/:name` (user profile for header)
- All `/api/attachments/*` routes (list, content, PDF stream, finalize-signed)
- `POST /api/signing/trigger`

**Not protected (by design):** the entry POST handlers themselves
(`/web-container-access-point`, `POST /`), which are gated by the Authentication
Key instead, and the static frontend assets.

### Session expiry during the signing round-trip

If the session expires while the technician is on the SecSign portal — in
practice only when the app is restarted or redeployed in that window, since a
normal signing takes minutes and the session TTL is 60 minutes *idle* — the
`fsm_session` cookie is no longer valid on return, so
`POST /api/attachments/finalize-signed` returns 401. The signature exists on
SecSign, but **nothing is written to FSM**.

This is handled deliberately the simple way, like a re-login in other SAP
services: `AttachmentService.finalizeSigned()` tags the 401 with
`error.sessionExpired = true`, and the controller shows a distinct warning
("Your session expired before your signature could be saved, so nothing was
changed. Please open this app again from FSM Mobile and sign the document(s)
again."). The technician re-opens the app and signs again. The first SecSign
portfolio stays on the portal without being written to FSM — see
[Accepted risks](#accepted-risks), item 3.

---

## Why not XSUAA / IAS / Federated Authentication

1. **FSM Mobile WebContainer flow is not compatible with browser-based login
   redirects.** XSUAA relies on redirecting the user agent to an IAS login page
   and back. The FSM Mobile WebView does not handle this cleanly — login state
   established inside the WebView often does not persist across WebContainer
   launches, and FSM Mobile does not pass any IAS-recognized authentication
   context into the WebView.

2. **Documented industry experience.** SAP community reports describe
   XSUAA-protected extensions failing during installation in FSM Extension
   Management. The clean XSUAA+IAS path targets FSM Web UI only and requires a
   separate auth path for FSM Mobile WebContainer.

3. **Cost-benefit ratio.** Implementing full XSUAA+IAS+approuter would take an
   estimated 2-3 days plus BTP admin and IAS tenant coordination. The current
   model — Authentication Key for Mobile entry plus a sliding session cookie —
   was implemented in a few hours and cryptographically gates entry. The
   incremental benefit does not justify the cost at this time.

This decision should be revisited if the company mandates XSUAA without
exceptions, an audit specifically demands XSUAA on inbound paths, or FSM Mobile
changes its WebContainer auth model.

---

## Accepted risks

The following are known and deliberately **not** mitigated at this time. Each was
weighed against the way the app is actually used (technicians launching from FSM
Mobile on their own device) and judged acceptable. They were identified in the
October 2026 code review.

| # | Risk | Why accepted | What would change it |
|---|---|---|---|
| 1 | **Entitlement is not checked per request.** A valid session proves *who* the caller is, but the attachment and object IDs in `/api/*` requests come from the client and are not compared with the launched Activity. A technician who edits requests could read, sign or overwrite attachments of another Activity. | Requires a valid session (launched from FSM Mobile with the Authentication Key), deliberate request tampering inside the FSM Mobile WebView, and knowledge of valid FSM UUIDs, which no endpoint lists. Not a realistic everyday threat for this user group. | An audit finding, or exposure beyond FSM Mobile (e.g. the Web UI path). A complete implementation exists (server-side check of every object/attachment ID against the session's Activity) and is kept aside for this case. |
| 2 | **The signer email is sent by the client.** `POST /api/signing/trigger` takes `signerEmail` from the request body. | Limited effect: the portfolio is addressed to the named SecSign user, and the portal has been observed to reject (HTTP 403) a browser logged in as a different user — so a forged value sends the portfolio to someone else rather than producing a signature in their name. (The exact portal rule behind that 403 has not been formally confirmed.) | Same as #1 — the same kept-aside implementation derives the signer from the session's FSM user. |
| 3 | **Re-signing after a session expiry.** If the session expires during the round-trip (see above), the technician signs again; the first portfolio remains on SecSign without being written to FSM. | Rare (app restart/redeploy during a signing) and equivalent to a re-login elsewhere. No data is lost or written wrongly. | Frequent occurrences, or a requirement that every signature leaves exactly one portfolio. A retry mechanism (keeping the pending batch across the expiry) was designed and is kept aside. |
| 4 | **In-memory stores, single instance.** Sessions and contexts live in process memory. | Acceptable for `instances: 1`. | Any need to scale beyond one instance — the stores must move to Redis or similar first. `instances: 1` is load-bearing. |

### Open item (not accepted — to be resolved)

| Item | Status |
|---|---|
| **TLS certificate verification is disabled on all SecSign calls** (`rejectUnauthorized: false` in `SecSignService`). These calls carry the SecSign Basic credentials and the signed PDFs. | To be fixed by trusting the portal's CA chain (agent `ca` option) or using a publicly trusted certificate on the portal, then removing the flag. Requires the certificate chain from the SecSign/infrastructure team. |

---

## Operational notes

### Required environment variables

| Variable | Required | Purpose |
|---|---|---|
| `FSM_WEBCONTAINER_AUTH_KEY` | Yes — server refuses to start without it | Shared secret matching the FSM Web Container Authentication Key. Set via `cf set-env` and `cf restage`. |

### Required FSM configuration

| Setting | Where | Value |
|---|---|---|
| Authentication Key | FSM Admin → Companies → [Company] → Web Containers → [Web Container] | Must byte-exactly match `FSM_WEBCONTAINER_AUTH_KEY` env var |

### Required BTP destinations (outbound — unrelated to inbound auth)

| Destination | Purpose | Auth |
|---|---|---|
| `FSM_OAUTH_CONNECT` | FSM Data + Query API | OAuth2 client credentials (via Destination Service) |
| `SECSIGN_CONNECT` | SecSign Signature Portal | BasicAuthentication |

### In-memory state

- `SessionStore._sessions` — Map from session token to `{ contextKey, expiresAt }`.
  Sliding 60-minute TTL; swept every 10 minutes. In-memory only; not persisted.
  **This is what controls access.**
- `sessions` (in `routes/context.js`) — Map from context key
  (`<userName>-<cloudId>`) to stored FSM context (without the Authentication Key).
  12-hour TTL from entry, swept every 10 minutes. In-memory only. It is
  deliberately much longer than the session TTL: the context only has to outlive
  the session, and with an equal 60-minute TTL a technician active for more than
  an hour kept a valid session but lost the context, so the page failed on reload
  (e.g. on return from SecSign). Reading a context still requires a valid session
  bound to it.

Both reset on container restart. Active sessions become invalid on restart;
technicians must re-launch from FSM Mobile. This is acceptable for a
single-instance deployment (`manifest.yaml` `instances: 1`); horizontal scaling
would require moving the stores to Redis or similar.

### Log signals

| Log prefix | Meaning |
|---|---|
| `WC-ACCESS-POINT: context stored, session issued` | Successful Mobile entry |
| `WC-ACCESS-POINT: rejected POST — authenticationKey ...` | Entry with bad/missing auth key — investigate if frequent |
| `[SessionStore] Session issued` | New session token created |
| `[SessionStore] Swept N expired` | Routine idle-session cleanup |
| `[Context] Session cleanup: removed N` | Routine context cleanup (contexts older than 12 hours) |
| `AUTH: rejected ... missing-credential ... source=none` | Protected endpoint hit without a cookie — direct attack attempt, or the cookie was not sent |
| `AUTH: rejected ... invalid-or-expired ... source=cookie` | Cookie expired or tampered — typically benign (idle past TTL), or a server restart during a signing round-trip |
| `[Context] GET context: rejected — requested '...' does not match session '...'` | A valid session asked for someone else's context (403) — investigate; not produced by the app itself |
| `[Attachments] finalize-signed MAPPING FAILED` | Signed PDFs could not be matched to attachments; nothing written to FSM — the line lists missing, ambiguous and available names |

---

## Compliance reference (Programmierrichtlinie)

- **§7 (API Versioning):** Partial. Routes are currently mounted under `/api`
  without an explicit version segment. If versioning is later required, introduce
  `/api/v1` alongside without breaking existing paths.
- **§10 (Security — XSUAA, OAuth2):** Deliberate deviation. The guideline
  specifies "XSUAA, OAuth2" for inbound auth. This app uses an Authentication Key
  (entry) plus a sliding HttpOnly session cookie (subsequent calls). All inbound
  paths to protected routes require a valid session. This deviation has been
  approved per §12 ("Abweichungen nur mit Architekturfreigabe") on **[date]** by
  **[approver]**.
- **§10 (No hardcoded secrets):** Compliant. The Authentication Key is read from
  an environment variable. Outbound FSM and SecSign credentials come from BTP
  Destination Service bindings.
- **§10 (Secrets via service bindings):** Partially compliant. The Authentication
  Key is an env var rather than a user-provided service. Defensible for a single
  secret; can be migrated to a service binding if governance requires it.

---

## Threat model summary

| Threat | Mitigation |
|---|---|
| Anonymous attacker POSTs fake context to `/web-container-access-point` | Authentication Key required — attacker would need the FSM-side secret |
| Anonymous attacker calls `/api/*` directly with no credentials | `requireSession` rejects with 401 |
| Attacker reads `/web-container-context?session=guess` | `requireSession` requires a valid cookie before the handler runs |
| Authenticated technician reads another technician's context | The requested key must match the session's own context key — 403 otherwise |
| Authentication Key leaked to the browser | Removed from the context before storing; never returned (fixed October 2026 — rotate once) |
| Authenticated technician tampers with attachment/object IDs or the signer | **Not mitigated** — accepted risk #1 and #2 |
| Cookie theft via XSS | Cookie is HttpOnly — JS cannot read it |
| Cookie theft via network sniffing | All transport is HTTPS-only; CF enforces HTTPS |
| Session reuse after idle timeout | Sliding 60-minute TTL — an idle session expires; `validateAndTouch` removes expired entries |
| Timing attack on the Authentication Key | Constant-time comparison (`crypto.timingSafeEqual`) with a length pre-check |
| Server restart mid-signing loses the FSM write-back | Nothing is written to FSM; the frontend detects the 401 and asks the technician to re-open and sign again (accepted risk #3) |
| Signed PDF written to the wrong attachment | All-or-nothing name matching (incl. SecSign's `-signed` suffix and `_` replacement); on any mismatch nothing is written |
| Man-in-the-middle on CF → SecSign | **Open item** — TLS verification currently disabled |
| Leaked but actively-used session token | Sliding TTL bounds an *unused* leaked token to 60 min; an actively-used leaked token remains valid until idle. Same residual risk as any sliding-session model. |

---

## When to revisit this document

Update this document whenever any of the following change:

- The auth mechanism on any endpoint (e.g., adding XSUAA, adding the FSM Web UI
  Shell context, modifying the Authentication Key check).
- The token delivery mechanism (e.g., adding a Bearer path for a future Web UI
  context, or changing the cookie to a different store).
- The cookie attributes (`SameSite`, TTL, cookie name) — note that `SameSite=Lax`
  is load-bearing for the SecSign GET-redirect return.
- The `FSM_WEBCONTAINER_AUTH_KEY` rotation procedure.
- The SecSign redirect behavior (e.g., if SecSign ever POSTs back instead of
  issuing a GET redirect, the `SameSite=Lax` cookie would be stripped and the
  return flow would break).
- The session storage is moved from in-memory to Redis or similar (would change
  the single-instance scaling note).
- Any accepted risk is mitigated, or the TLS open item is resolved.
- A security incident affects this app.

The "Last updated" line at the top of this document MUST be kept current.
