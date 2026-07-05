# Setup Guide — Deploying T&M Journal to a New BTP Subaccount

> **Audience:** A developer (you, a colleague, or a future maintainer) setting up
> a fresh deployment of this app from the GitHub repository to a different BTP
> subaccount, dev space, or after losing access to an existing deployment.
>
> **Time required:** ~45-60 minutes of focused work, plus customer/admin
> coordination time.
>
> **Last updated:** April 2026

This guide is a step-by-step procedure for getting the T&M Journal app from
"GitHub repository" to "running in customer's BTP subaccount, accessible from
FSM Mobile and FSM Web UI."

For the architecture this app implements, see [SECURITY.md](SECURITY.md).
For the naming conventions used here, see [NAMING.md](NAMING.md).

---

## Before you start

Confirm these prerequisites are in place. Without all of them, the procedure
won't complete cleanly.

### Access prerequisites

- [ ] **GitHub access** to this repository
- [ ] **SAP Business Application Studio (BAS) access** in your account
- [ ] **BTP Cockpit access** to the target subaccount, with at least Subaccount
      Viewer role (Subaccount Administrator preferred for setup)
- [ ] **Cloud Foundry Space Developer role** on the target CF space (granted by
      the customer's BTP admin to your email)

### Information you need to gather

- [ ] **Target CF API endpoint URL** (e.g., `https://api.cf.eu10-004.hana.ondemand.com`)
- [ ] **Target CF org name** and **CF space name**
- [ ] **FSM Authentication Key value** — either the existing one currently
      configured in FSM Admin, or you generate a fresh one and have the customer
      paste it into FSM Admin (see Step 4)
- [ ] **FSM Admin access** (yours or coordination with a customer admin) to
      update the Web Container Authentication Key field and the URL field
- [ ] **Confirmation that destination `FSM_S4E` exists** at the subaccount level,
      with valid OAuth credentials to FSM (see Step 3)

### Tools required

These are pre-installed in BAS but worth confirming:

- [ ] Node.js 18+ (`node --version`)
- [ ] npm 8+ (`npm --version`)
- [ ] Cloud Foundry CLI (`cf --version`)
- [ ] Git (`git --version`)

---

## Step 1: Clone the repository in BAS

Open a BAS dev space (Fiori type recommended). Open a terminal.

Set up your Git identity if not already done:

```bash
git config --global user.name "Your Name"
git config --global user.email "your-email@company.com"
```

Clone the repo. If it's private, generate a Personal Access Token in GitHub
(Settings → Developer settings → Personal access tokens, scope `repo`) and
use it as the password when prompted.

```bash
cd ~/projects
git clone https://github.com/ervinsgl/tng-fsm-timematerialext-ui.git
cd tng-fsm-timematerialext-ui
```

Verify you got the right code:

```bash
ls docs/SECURITY.md utils/FSMJwtValidator.js
# Both files should exist

grep -c "/api/v1/" webapp/utils/services/*.js webapp/controller/mixin/*.js | head -3
# Should show non-zero matches across multiple files
```

If either file is missing or the API versioning grep returns zero, you have an
older or incorrect commit checked out. Stop and verify the branch and commit
before proceeding.

## Step 2: Install dependencies

```bash
npm install
```

Should take 30-60 seconds. Watch for any error output. If npm complains about
Node version, switch:

```bash
nvm install 18
nvm use 18
```

## Step 3: Verify or create the BTP destination

The app uses a destination called `FSM_S4E` to authenticate outbound calls to
FSM. This must be configured in BTP Cockpit.

In a browser, log in to BTP Cockpit. Navigate to:

**Subaccount → Connectivity → Destinations**

Look for `FSM_S4E`. If it exists with valid OAuth credentials and the additional
properties below, skip to Step 4.

### If FSM_S4E does NOT exist or needs to be recreated

Click "Create Destination" and configure:

| Property | Value |
|---|---|
| Name | `FSM_S4E` |
| Type | `HTTP` |
| URL | `https://de.fsm.cloud.sap` (or your region's FSM URL) |
| Proxy Type | `Internet` |
| Authentication | `OAuth2ClientCredentials` |
| Token Service URL | `https://de.fsm.cloud.sap/api/oauth2/v2/token` |
| Token Service URL Type | `Dedicated` |
| Client ID | _(from FSM Admin → Account → Clients)_ |
| Client Secret | _(from FSM Admin → Account → Clients)_ |

**Additional Properties** (these are crucial — the app reads them):

| Property | Value |
|---|---|
| `account` | _(your FSM account name, e.g., `TUEV-NORD_T1`)_ |
| `company` | _(your FSM company name, e.g., `TUEV-NORD_S4E`)_ |
| `URL.headers.X-Account-ID` | _(numeric account ID)_ |
| `URL.headers.X-Company-ID` | _(numeric company ID)_ |
| `URL.headers.X-Client-ID` | `FSM_Extension` |
| `URL.headers.X-Client-Version` | `0.0.1` |

Save. Click "Check Connection" — should return HTTP 200 (or sometimes 405,
which is also fine — it means OAuth worked and FSM responded).

> **Where to get the OAuth client credentials:** In FSM Admin → Account → Clients.
> If no client exists, create one with appropriate scopes for Activity, Service
> Call, Time Effort, Material, Expense, Mileage, and lookup data.

## Step 4: Decide on the FSM Authentication Key

The app validates inbound POSTs from FSM Mobile using a shared secret stored in
the `FSM_WEBCONTAINER_AUTH_KEY` environment variable. The same value must be
configured in FSM Admin's Web Container Authentication Key field.

Two scenarios:

### Scenario A: Reuse an existing key

If an existing FSM Web Container is already configured for this app and you
want to keep its current Authentication Key value:

1. Get the value from the customer (or from FSM Admin if you have access).
2. Save it somewhere secure (1Password, etc.) for use in Step 7.

No FSM Admin work needed yet.

### Scenario B: Generate a fresh key

If this is a fresh setup, or you want to rotate the key:

1. Generate a new value:
```bash
   openssl rand -base64 32
```
2. Copy the output. Save it somewhere secure for use in Step 7.
3. **Have the customer (or you, if you have access) paste this value into
   FSM Admin → Companies → [Your Company] → Web Containers → [Your Web Container]
   → Authentication Key field.** Save in FSM Admin.

The values in FSM Admin and `FSM_WEBCONTAINER_AUTH_KEY` env var must match
byte-exactly. Mobile launches will return 401 if they differ.

## Step 5: Log in to Cloud Foundry

```bash
cf login
```

Prompts:
- **API endpoint:** the URL gathered in prerequisites
- **Email/password:** your credentials (or SSO redirect)
- **Org:** select the customer's CF org
- **Space:** select the customer's CF space

Verify:

```bash
cf target
cf apps
```

`cf target` should show the correct org and space. `cf apps` may show the old
app under a different name or no apps at all — either is fine.

## Step 6: Create the service binding

```bash
cf services
```

If `fsm-timematerialext-destination-dev` is in the list, skip to Step 7.

If it's missing, create it:

```bash
cf create-service destination lite fsm-timematerialext-destination-dev
```

Wait ~30 seconds, then verify:

```bash
cf service fsm-timematerialext-destination-dev
# Should show: status: create succeeded
```

This service binding will give the app access to the `FSM_S4E` destination
configured at the subaccount level (Step 3).

## Step 7: Build and push the app

From the project root:

```bash
rm -rf dist resources
npm run build:cf
cf push
```

The build takes ~30 seconds. The push takes 1-2 minutes.

The app will likely **fail to start on the first push** with this error in the
logs:

```
FATAL: FSM_WEBCONTAINER_AUTH_KEY environment variable is not set.
```

This is expected. The next step fixes it.

## Step 8: Set environment variables

Set the auth key from Step 4:

```bash
cf set-env tng-fsm-timematerialext-ui-dev FSM_WEBCONTAINER_AUTH_KEY '<value-from-step-4>'
```

Optionally, override the JWKS URL if the FSM tenant is in a non-DE region:

```bash
# Default in code is DE region; only set this if needed
cf set-env tng-fsm-timematerialext-ui-dev FSM_JWKS_URL 'https://<region>.fsm.cloud.sap/api/oauth2/v2/.well-known/jwks.json'
```

Restage the app to pick up the env vars:

```bash
cf restage tng-fsm-timematerialext-ui-dev
```

Wait ~1-2 minutes for restaging.

## Step 9: Verify the app started correctly

```bash
cf logs tng-fsm-timematerialext-ui-dev --recent
```

Look for these lines (should all appear within seconds of each other):

```
Server running on port <PORT>
FSM_WEBCONTAINER_AUTH_KEY is set (<N> chars)
Session TTL: 60 minutes
Cookie: HttpOnly; Secure; SameSite=None; Path=/
API mounted at /api/v1 (strict auth — no Web UI carve-out)
FSMJwtValidator: using JWKS endpoint https://de.fsm.cloud.sap/...
```

If all these are present and there are no error stack traces afterward, the
backend is healthy.

## Step 10: HTTP-level smoke test

Get the app's URL:

```bash
cf app tng-fsm-timematerialext-ui-dev
```

Look for the `routes:` line. Copy the URL.

Test the static file serving:

```bash
curl -i https://<route-from-above>/
# Expected: HTTP 200 with HTML content
```

Test the auth gate:

```bash
curl -i https://<route-from-above>/api/v1/get-time-tasks
# Expected: HTTP 401 with JSON message about missing session
```

Both responses confirm the app is responding correctly: it serves static files
to anyone, but requires auth for API calls.

## Step 11: Update FSM Admin with the new URL

Coordinate with whoever has FSM Admin access. They (or you) need to update the
Web Container in FSM Admin:

**FSM Admin → Companies → [Your Company] → Web Containers → [Web Container Name]**

| Field | Value |
|---|---|
| URL | `https://<route-from-step-10>` |
| Authentication Key | _(value from Step 4 — already set there if Scenario B was used)_ |

Save in FSM Admin.

If users are on FSM Mobile and need to pick up the new URL, they need to sync
their FSM Mobile app (close and reopen, then sync). Web UI users will see the
new URL on next page load.

## Step 12: Test FSM Mobile flow

On a test device with FSM Mobile installed:

1. Force-quit FSM Mobile
2. Reopen FSM Mobile and sync
3. Navigate to an Activity that has access to T&M Journal
4. Tap the T&M Journal Web Container button
5. The app should load and display the activity data

While doing this, watch the logs:

```bash
cf logs tng-fsm-timematerialext-ui-dev
```

You should see (when the user taps the button):

```
WC-ACCESS-POINT: context stored, session issued (contextKey=..., sessionStoreSize=N)
```

Followed by a series of `/api/v1/*` calls returning 200. No 401 errors.

Try a basic workflow: open Activity, view T&M tables, optionally Add Entry.
Confirm everything works.

## Step 13: Test FSM Web UI flow

On a desktop browser:

1. Log in to FSM Web UI
2. Navigate to an Activity that has the T&M Journal extension
3. Click the extension button
4. The app should load in iframe

In browser DevTools console, you should see:

```
ContextService: Running in iframe, trying Shell SDK first...
ContextService: FSM Shell SDK loaded
ContextService: Raw shell context received
ContextService: Session token stored for Bearer auth (Web UI flow)
ContextService: Shell session initialized — cookie set
ContextService: Context resolved from shell
TypeConfigService: Loaded config from server
CacheService: Cache warm complete in ~Xms {technicians: true, timeTasks: true, items: true, expenseTypes: true}
```

In CF logs:

```
SHELL-INIT: session issued (contextKey=..., userEmail=..., sessionStoreSize=N)
```

Followed by `/api/v1/*` calls returning 200. No 401 errors.

Test the same workflows you tested for Mobile (View T&M, Add Entry, etc).

## Step 14: Mark setup complete

If both Mobile and Web UI flows work end-to-end:

- [ ] App is deployed
- [ ] Service binding active
- [ ] Auth key configured on both sides (FSM Admin + CF env var)
- [ ] FSM Web Container points at the new URL
- [ ] Mobile flow works
- [ ] Web UI flow works

Setup is complete.

---

## Common issues and fixes

### `cf push` fails with "service `fsm-timematerialext-destination-dev` not found"

The service binding wasn't created. Go back to Step 6.

### App crash-loops with `FATAL: FSM_WEBCONTAINER_AUTH_KEY environment variable is not set`

Env var wasn't set, or restage didn't happen. Go back to Step 8.

### Mobile launch returns HTTP 401 with `WC-ACCESS-POINT: rejected POST — authenticationKey mismatch`

The `FSM_WEBCONTAINER_AUTH_KEY` env var doesn't match the FSM Admin Authentication
Key field. Both must be byte-exactly identical.

To diagnose:
```bash
cf env tng-fsm-timematerialext-ui-dev | grep FSM_WEBCONTAINER_AUTH_KEY
```

Compare the value with what's in FSM Admin → Web Containers → Authentication Key.
If different, set both sides to the same value and restage the app.

### Web UI shows app loading screen indefinitely or gets 401s in console

Most likely the FSM Web UI Shell flow's JWT validation failed. Check logs:

```bash
cf logs tng-fsm-timematerialext-ui-dev --recent | grep "SHELL-INIT"
```

If you see `SHELL-INIT: rejected — JWT validation failed: ...`, the JWT
couldn't be verified. Possible causes:
- JWKS endpoint unreachable from CF (rare, only in non-DE regions if the URL is wrong)
- JWT signed by an unexpected key (FSM-side configuration drift)

### Browser console shows `Failed to load resource: ...mobileapptm/Component.js` or similar

The app ID rename from `mobileapptm` to `com.tng.fsm.timematerialext.app` left
a stale reference. Verify with:

```bash
grep -rn "mobileapptm" --include="*.js" --include="*.xml" --include="*.json" --include="*.html" 2>/dev/null \
    | grep -v node_modules
```

Should return nothing. If it returns matches, those are stale references that
need updating before redeploy.

### Old `mobileapptm` app still running in the same space

If the previous deployment still exists under the locked-out email, it can stay
until decommission. The new app runs alongside it on a different name and URL.
Customer's BTP admin can `cf delete mobileapptm -f` when ready.

### Need to roll back

If the new deployment has problems and the old one still works:

1. In FSM Admin, change the Web Container URL back to the old app's URL.
2. (Optionally) `cf delete tng-fsm-timematerialext-ui-dev -f` to remove the
   new app entirely.

The old app continues functioning since its env vars and service binding were
not touched.

---

## Maintenance

### Rotating the FSM Authentication Key

1. Generate a new value: `openssl rand -base64 32`
2. Update FSM Admin → Web Containers → Authentication Key
3. Update CF env var: `cf set-env tng-fsm-timematerialext-ui-dev FSM_WEBCONTAINER_AUTH_KEY '<new-value>'`
4. Restage: `cf restage tng-fsm-timematerialext-ui-dev`

In-flight Mobile launches return 401 during the brief window between the FSM
update and CF restage. Users retap to relaunch. No long downtime.

### Updating the app after code changes

```bash
git pull origin main
npm install   # only if dependencies changed
rm -rf dist resources
npm run build:cf
cf push
```

Env vars persist across `cf push` (no need to re-set them unless they're being
changed).

### Adding a new environment (test, prod)

For a new environment (e.g., test):

1. Create the service binding: `cf create-service destination lite fsm-timematerialext-destination-test`
2. Adjust `manifest.yaml` (or use a separate manifest file) to set the CF app
   name to `tng-fsm-timematerialext-ui-test` and reference the new service binding
3. Push, set env vars, restage as in Steps 7-9
4. Configure a new FSM Web Container in FSM Admin pointing at the test app URL

App ID, controller name, view name, and folder name do NOT change between
environments — see [NAMING.md](NAMING.md) for the full pattern.

---

## Reference

- [SECURITY.md](SECURITY.md) — full security architecture (inbound auth, JWT
  validation, threat model, rotation)
- [NAMING.md](NAMING.md) — naming conventions across TNG FSM extensions
- [README.md](../README.md) — app overview, features, API reference