# SecSignSignatureExt — Change Workflow (BAS → DevOps → DEV → QA → PROD)

How to take a change from idea to running in each environment, safely.

---

## The pieces you work with

- **BAS workspace** = a clone of the Azure DevOps repo (`tns.fsm.secsignsignatureext.ui`, in BAS-Git).
  This is where you edit, and what you commit. **The repo is the source of truth** — the
  pipeline builds and deploys from it, not from your local files.
- **Sandbox CF app** (`tns-fsm-secsignsignatureext-ui-sandbox`) = your private running instance for
  testing, deployed by hand with `cf push`. Its deploy descriptors use `-sandbox` names and are
  **local only — never committed.**
- **Pipeline** = builds the `.mtar` and deploys. You don't run build/deploy by hand for the
  official environments.
- **Branch model (UNIFY):**
  - `feature/*` → `develop` (via PR) → deploys to **DEV**
  - `develop` → `main` (via PR) → creates the **cTMS transport** to **QA**, then **PROD**

---

## Part A — Make and ship a change

### 1. Start from an up-to-date `develop`
```
git checkout develop
git pull
git checkout -b feature/<short-name>
```

### 2. Make the code change in BAS
Edit the code files (`utils/`, `webapp/`, `index.js`, etc.).

### 3. (Recommended) Test it in your sandbox first
Deploy the current code to the sandbox app and check it from FSM Mobile:
```
cf push        # uses the local sandbox manifest.yaml (-sandbox name + route)
```
Launch the sandbox from its own FSM Mobile Web Container registration and confirm the change works.
This is what the sandbox is for — prove it before it enters the official flow.

> Sandbox needs its auth key set once (the app exits on startup without it):
> ```
> cf set-env tns-fsm-secsignsignatureext-ui-sandbox FSM_WEBCONTAINER_AUTH_KEY '<value>'
> cf restage tns-fsm-secsignsignatureext-ui-sandbox
> ```

### 4. Stage ONLY the files you meant to change
```
git status
git diff <file>            # check each diff before staging
git add <only the intended files>
```
**Commit:** code files, and `mta.devops.yaml` / `manifest.devops.yaml` **only if** you intentionally
changed the repo (pipeline) versions.
**Never stage:** `secrets.mtaext`, any `-sandbox`-named descriptor, the local `manifest.yaml` /
`mta.yaml`, `node_modules`, real secret values, the `FSM_WEBCONTAINER_AUTH_KEY` value.

> Safety check before committing:
> ```
> git diff --cached | grep -i sandbox              # expect NOTHING
> git diff --cached | grep -i AUTH_KEY             # expect NOTHING (no secret values)
> ```

### 5. Commit with a clear message
```
git commit -m "<what changed and why>"
```

### 6. Push the branch
```
git push
```

### 7. Open a Pull Request into `develop`
- **Into:** `develop` (never `main` for a feature branch).
- **Reviewers:** [fill in this app's reviewers].
- **Description:** what changed and why (one or two lines is enough).

### 8. Pipeline runs on the PR
Expect **Build** to pass. **DeployDev** behaves per the pipeline setup; a destination-missing
error is environment setup, not your code.

### 9. Merge to `develop` → DEV deploy
Once reviewed and merged, the pipeline deploys the change to **DEV**.

### 10. Promote to QA / PROD (separate, deliberate step)
When DEV is verified, open a PR **`develop` → `main`**. Merging it creates the **cTMS transport**;
QA (then PROD) is released through cTMS / Cloud ALM, not straight from Git.

---

## Part B — Guardrails (the things that actually bite)

- **Code only across the sandbox/repo boundary.** Move `utils/`, `webapp/`, `index.js`,
  etc. Never carry `-sandbox` `manifest.yaml` / `mta.yaml` into the repo.
- **Run `git diff --cached | grep -i sandbox` before every push.** Zero hits expected.
- **Never commit secrets.** No clientSecret, no `secrets.mtaext`, and **no
  `FSM_WEBCONTAINER_AUTH_KEY` value** — this app uses it (see Part C) and it must
  only ever be set via `cf set-env`, never written into a committed file. The
  `.gitignore` covers the descriptor files — keep it that way.
- **Keep the destination references consistent** when you touch a destination name.
  This app has **two** outbound destinations:
  - `manifest*.yaml` / `mta*.yaml` → service **instance** name (`fsm-secsignsignatureext-destination`)
  - `utils/fsm/FSMService.js` → `FSM_DESTINATION = 'FSM_OAUTH_CONNECT'` (FSM Data/Query API config)
  - `utils/signing/SecSignService.js` → `SECSIGN_DESTINATION = 'SECSIGN_CONNECT'` (SecSign portal config)
  - Both destination **entries** (`FSM_OAUTH_CONNECT`, `SECSIGN_CONNECT`) must be configured in the cockpit.
- **Don't reinstall npm on the corporate network** unless needed — it can hit the proxy
  corruption. The committed `package-lock.json` is the trusted one; build happens in the pipeline
  (clean network). Remember runtime deps must be declared in `package.json` (`adm-zip`,
  `cookie-parser`, `axios`, `express`, `form-data`) — CF silently misses anything undeclared.

---

## Part C — Per-environment runtime setup (NOT code — done once per environment)

These are not solved by a PR. They must exist in each space/subaccount:

1. **Destination service _instance_** `fsm-secsignsignatureext-destination` — **before deploy**
   (missing = the bind/404 deploy error).
2. **Destination _entries_** — both, configured with URL + credentials; **clientSecret
   pasted after import** (it isn't carried over) — before the app calls out:
   - `FSM_OAUTH_CONNECT` — FSM Data/Query API (OAuth2 client credentials).
   - `SECSIGN_CONNECT` — SecSign Signature Portal (BasicAuthentication).
3. **Env var** `FSM_WEBCONTAINER_AUTH_KEY` — **required**; the app **exits on startup if it is
   unset** (fail-fast guard in `index.js`). Set per environment via `cf set-env` + `cf restage`,
   and it must **byte-exactly match** the Authentication Key configured on the FSM-side Web
   Container. Never commit the value.
4. **Read the deployed route** (`cf app <n>` or cockpit) and **register it as the FSM Mobile
   Web Container** for that environment — after deploy:
   ```
   # FSM Admin > Companies > [Company] > Web Containers > [WC] > URL:
   #   https://<route>/web-container-access-point
   ```

> **Security model (see `SECURITY.md`):** This app is **Mobile-only**. Inbound auth is
> Authentication Key at the Web Container entry POST (Tier 1) + a sliding 60-minute HttpOnly
> session cookie on all `/api/*` calls (Tier 3). There is **no** FSM Web UI / Shell / JWT path —
> if a Web UI context is ever added, it needs a separate Bearer-token auth path because browsers
> block third-party cookies in the iframe.

---

## Quick reference — where things live

| Thing | Where |
|---|---|
| Source of truth | Azure DevOps repo (`tns.fsm.secsignsignatureext.ui`) |
| Your editor | BAS (workspace = repo clone) |
| Your test instance | sandbox CF app (`cf push`, local `-sandbox` descriptors) |
| Build + deploy | pipeline (DEV) / cTMS + Cloud ALM (QA, PROD) |
| Web Container entry | `index.js` → `routes/context.js` `POST /web-container-access-point` (validates Auth Key, issues session cookie) |
| Session validation | `utils/auth/requireSession.js` + `utils/auth/SessionStore.js` (sliding 60-min TTL) |
| `FSM_WEBCONTAINER_AUTH_KEY` | Env var (per environment, `cf set-env`); validated in `SessionStore.isValidAuthKey()` |
| FSM destination config name | `utils/fsm/FSMService.js` → `FSM_DESTINATION` (`FSM_OAUTH_CONNECT`) |
| SecSign destination config name | `utils/signing/SecSignService.js` → `SECSIGN_DESTINATION` (`SECSIGN_CONNECT`) |