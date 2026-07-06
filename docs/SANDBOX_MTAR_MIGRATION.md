# Sandbox + mtar Deployment Split — Migration Playbook

> **Audience:** A developer applying the "local sandbox via `manifest.yaml`,
> DevOps DEV/QA/PROD via `mta.yaml` (mtar transport)" deployment model to an
> existing tns FSM extension. Also covers the `tng` → `tns` naming correction
> and destination-name consolidation that travel with it.
>
> **First applied to:** `com.tns.fsm.inspreppdfviewext.app` (Inspection Report
> PDF Viewer), June 2026. Reusable for the remaining apps in the estate.
>
> **Also applied to:** `com.tns.fsm.secsignsignatureext.app` (SecSign Signature
> Portal PDF signing), July 2026 — see the worked-example values box below.
>
> **Time required:** ~30-45 minutes per app, plus FSM Admin coordination for the
> Web Container URL cutover.

For naming conventions see [NAMING.md](NAMING.md). For the full app rename
procedure (App ID, controllers, views) see [RENAME.md](RENAME.md) — this playbook
assumes the App ID is already correct and only covers deployment identifiers,
the `tng`→`tns` correction, and the destination consolidation.

---

## The model

Two deployment paths that differ from each other but stay internally consistent:

| | **Local sandbox** | **DevOps DEV/QA/PROD** |
|---|---|---|
| File used | `manifest.yaml` | `mta.yaml` |
| Command | `cf push` | `npm run build:mta` + `cf deploy` |
| CF app name | `tns-fsm-<capability>-ui-sandbox` | `tns-fsm-<capability>-ui` |
| Route | pinned `-sandbox-...` | auto-generated (`default-route: true`) |
| Destination service | `fsm-<capability>-destination` | `fsm-<capability>-destination` |
| Subaccount | your personal sandbox | DevOps-owned, separate per env |

**Why the DevOps app name omits `<env>`:** DEV/QA/PROD are separate subaccounts
(separate spaces, domains, auto-generated routes). The environment is encoded by
*which subaccount* the mtar lands in, so an `<env>` suffix on the app name is
redundant. This is a documented deviation from the default
`tns-fsm-<capability>-ui-<env>` convention — see NAMING.md.

**Why the sandbox name carries `-sandbox`:** purely to guarantee the local app
can never collide with the pipeline-owned `tns-fsm-<capability>-ui` app or hijack
its route.

**Why one unsuffixed destination everywhere:** the destination service instance
(`fsm-<capability>-destination`) is the same name in every subaccount, created and
configured per-subaccount in cockpit. No `-dev`/`-qa`/`-prod` suffix. This keeps
`manifest.yaml` and `mta.yaml` referencing an identical binding name.

---

## Per-app values to decide first

Fill these in before starting. Worked example uses the Inspection Report app.

| Token | Pattern | Example |
|---|---|---|
| `<capability>` | lowercase, no separators | `inspreppdfviewext` |
| App ID | `com.tns.fsm.<capability>.app` | `com.tns.fsm.inspreppdfviewext.app` |
| mta ID | `tns.fsm.<capability>.ui` | `tns.fsm.inspreppdfviewext.ui` |
| DevOps CF app | `tns-fsm-<capability>-ui` | `tns-fsm-inspreppdfviewext-ui` |
| Sandbox CF app | `tns-fsm-<capability>-ui-sandbox` | `tns-fsm-inspreppdfviewext-ui-sandbox` |
| Destination service | `fsm-<capability>-destination` | `fsm-inspreppdfviewext-destination` |
| BTP destination config | (FSM-side, app-specific) | `FSM_OAUTH_CONNECT` |

> The **BTP destination config name** (what `FSMService.js` reads, e.g.
> `FSM_OAUTH_CONNECT`) is separate from the **destination service instance name**
> (what `manifest.yaml`/`mta.yaml` bind to, e.g. `fsm-inspreppdfviewext-destination`).
> The service instance grants access to the config. Don't conflate them.

### Worked example — SecSignSignatureExt (this app)

| Token | Value |
|---|---|
| `<capability>` | `secsignsignatureext` |
| App ID | `com.tns.fsm.secsignsignatureext.app` |
| mta ID (DevOps) | `tns.fsm.secsignsignatureext.ui` |
| mta ID (sandbox) | `tns.fsm.secsignsignatureext.ui.sandbox` |
| DevOps CF app | `tns-fsm-secsignsignatureext-ui` |
| Sandbox CF app | `tns-fsm-secsignsignatureext-ui-sandbox` |
| Destination service instance | `fsm-secsignsignatureext-destination` |
| BTP destination config (FSM) | `FSM_OAUTH_CONNECT` |
| BTP destination config (SecSign) | `SECSIGN_CONNECT` |
| Region / org slug | `eu10-004` / `fsm-dev-op` |
| Sandbox route | `tns-fsm-secsignsignatureext-ui-sandbox-fsm-dev-op.cfapps.eu10-004.hana.ondemand.com` |
| Memory | `512M` (holds PDF buffers + ZIP extraction during batch signing — do **not** drop to 256M) |

> **App-specific note:** this app has **two** outbound BTP destination configs —
> `FSM_OAUTH_CONNECT` (FSM Data/Query API, OAuth2) and `SECSIGN_CONNECT` (SecSign
> Signature Portal, BasicAuthentication) — both reached through the single
> `fsm-secsignsignatureext-destination` service instance. The Inspection Report
> app had only one. Confirm **both** configs exist in each target subaccount's
> cockpit (Step 6), not just the FSM one.

---

## Step 1 — `tng` → `tns` correction

Sweep the whole repo. The correct estate name is **TNS**, not TNG.

```bash
grep -rn "tng\|TNG" . 2>/dev/null | grep -v node_modules | grep -v .git/
```

Replace in code/config (case-sensitive, dotted and slashed forms both appear in
App-ID-bearing files):

```bash
# slashed module paths (sap.ui.define, Component.js)
find . -type f \( -name "*.js" -o -name "*.xml" -o -name "*.json" -o -name "*.html" \) \
    -not -path "./node_modules/*" -not -path "./.git/*" \
    -exec sed -i 's|com/tng/fsm/|com/tns/fsm/|g' {} +

# dotted namespace (class declarations, manifest, xs-security, ui5*.yaml)
find . -type f \( -name "*.js" -o -name "*.xml" -o -name "*.json" -o -name "*.html" -o -name "*.yaml" \) \
    -not -path "./node_modules/*" -not -path "./.git/*" \
    -exec sed -i 's|com\.tng\.fsm\.|com.tns.fsm.|g' {} +

# deploy identifiers (CF app names, package.json name, service bindings)
find . -type f \( -name "*.yaml" -o -name "*.json" \) \
    -not -path "./node_modules/*" -not -path "./.git/*" \
    -exec sed -i 's|tng-fsm-|tns-fsm-|g' {} +
```

Then hand-check the docs (README, NAMING, SECURITY, SETUP, RENAME) for prose
references to "TNG"/"TNG estate":

```bash
grep -rn "TNG\|tng" *.md docs/ 2>/dev/null | grep -v .git/
```

Re-run the first grep until it returns nothing load-bearing. NAMING.md title and
scope line are common stragglers.

---

## Step 2 — `mta.yaml` (DevOps transport file)

Target shape — substitute `<capability>`:

```yaml
_schema-version: "3.2"
ID: tns.fsm.<capability>.ui
version: 1.0.0
description: <App description> (side-by-side, Node.js/Express + SAPUI5)

parameters:
  enable-parallel-deployments: true

modules:
  - name: tns-fsm-<capability>-ui          # NO -dev / -env suffix
    type: nodejs
    path: .
    parameters:
      buildpack: nodejs_buildpack
      command: npm start
      memory: 256M                          # match the app's actual need
      disk-quota: 512M
      default-route: true                   # CF auto-generates host per subaccount
    requires:
      - name: fsm-<capability>-destination
    build-parameters:
      builder: custom
      commands:
        - npm ci --omit=dev
      ignore:
        - ".git/"
        - "docs/"
        - "dist/"
        - "resources/"
        - "mta_archives/"
        - "*.mtaext"

resources:
  - name: fsm-<capability>-destination
    type: org.cloudfoundry.existing-service
    parameters:
      service-name: fsm-<capability>-destination
```

Checklist:
- [ ] Module `name` is unsuffixed (`tns-fsm-<capability>-ui`).
- [ ] `requires` and `resources` both reference the **same** unsuffixed
      destination service name.
- [ ] `service-name` byte-matches the instance that actually exists in the target
      subaccount (see Step 6).
- [ ] `memory` matches the app (the Inspection Report app uses `256M`; T&M and
      SecSign use `512M` — don't blindly copy).

> **⚠️ BAS regenerates the wrong `mta.yaml`.** If the app was originally a Fiori
> `generator-fiori` project (old html5-apps-repo model), SAP Business Application
> Studio will silently regenerate `mta.yaml` as the **html5-repo** descriptor —
> managed `xsuaa` + `html5-apps-repo` host + `destination-content` module +
> `deploy_mode: html5-repo`, with the old generated `ID` (e.g. `mobileappsignport`)
> and `description: Generated by Fiori Tools`. This is the exact model this
> playbook moves away from. **Overwrite it wholesale** with the plain-nodejs shape
> above. Symptoms that it happened: `type: html5`, `type: com.sap.application.content`,
> or `deploy_mode: html5-repo` anywhere in `mta.yaml`.

---

## Step 3 — `manifest.yaml` (local sandbox file)

Keep the "do not commit" header. Target shape:

```yaml
# ============================================================
#  SANDBOX / LOCAL ONLY — DO NOT COMMIT TO THE DEVOPS REPO
#  Personal test instance. The official DEV app is owned by
#  the pipeline and uses the unsuffixed name/route.
#  NEVER copy the "-sandbox" name or route into the repo's
#  mta.yaml — it would hijack the pipeline app/route.
# ============================================================

applications:
  - name: tns-fsm-<capability>-ui-sandbox
    memory: 256M
    disk_quota: 512M
    instances: 1
    buildpacks:
      - nodejs_buildpack
    command: npm start
    path: .
    routes:
      - route: tns-fsm-<capability>-ui-sandbox-<orgslug>.cfapps.<region>.hana.ondemand.com
    services:
      - fsm-<capability>-destination       # unsuffixed — same instance as mta.yaml
```

Checklist:
- [ ] App name and route carry `-sandbox`.
- [ ] `services:` references the unsuffixed destination (NOT a `-dev` variant).
- [ ] Route's `<orgslug>` and `<region>` match your sandbox subaccount.

> **Best practice:** add `manifest.yaml` to `.gitignore` so the DevOps repo can
> only ever build from `mta.yaml`. The file's own header says don't commit it.

---

## Step 4 — `package.json`

Two things:

```jsonc
{
  "name": "tns-fsm-<capability>-ui",        // hyphenated, matches folder/repo
  "scripts": {
    // target the DevOps app name; do NOT delete the shared destination here
    "undeploy": "cf delete tns-fsm-<capability>-ui -f"
  }
}
```

> **Never `cf delete-service fsm-<capability>-destination` in an undeploy script.**
> The destination is shared across every environment/app in the subaccount;
> deleting it via a routine undeploy breaks everything else bound to it.
>
> BAS/Fiori tooling commonly generates exactly this dangerous form:
> ```
> "undeploy": "cf delete tns-fsm-<capability>-ui-sandbox -f && cf delete-service fsm-<capability>-destination -f"
> ```
> Strip the `&& cf delete-service ...` half, leaving only the app delete. (Seen
> and fixed on SecSignSignatureExt.)

---

## Step 5 — `FSMService.js` (verify, usually no change)

Confirm the BTP destination config name is correct and consistent across all
environments:

```bash
grep -n "destinationName" utils/FSMService.js
```

Should read the app's intended config name (e.g. `FSM_OAUTH_CONNECT`). This is
the FSM-side destination *config*, not the service instance. It does not carry an
env suffix — the same config name is used in every subaccount.

---

## Step 6 — Subaccount prerequisites (per environment)

In **each** target subaccount (your sandbox, and each DevOps env), before deploy:

```bash
# 1. The destination SERVICE INSTANCE must exist with the unsuffixed name
cf services
cf create-service destination lite fsm-<capability>-destination   # if missing

# 2. The BTP DESTINATION CONFIG must be configured in cockpit
#    (Connectivity > Destinations), e.g. FSM_OAUTH_CONNECT, with OAuth creds
#    + additional properties (account, company, X-Account-ID, etc.)
```

If the service instance name doesn't match the binding in your yaml, the push/deploy
fails to bind. This is the single most common failure point.

---

## Step 7 — Deploy + cutover (sandbox)

The app fails loud on first start until the auth key is set — this is expected.

```bash
# note the auth key from the OLD app first, if replacing one
cf env <old-app-name> | grep FSM_WEBCONTAINER_AUTH_KEY

cf push                                    # creates tns-fsm-<capability>-ui-sandbox

cf set-env tns-fsm-<capability>-ui-sandbox FSM_WEBCONTAINER_AUTH_KEY '<value>'
cf restage tns-fsm-<capability>-ui-sandbox

# verify clean start
cf logs tns-fsm-<capability>-ui-sandbox --recent | grep -E "Server running|AUTH_KEY is set|API mounted"
```

Then point FSM Admin's Web Container URL at the new `-sandbox` route:

```bash
cf app tns-fsm-<capability>-ui-sandbox     # copy the route
# FSM Admin > Companies > [Company] > Web Containers > [WC] > URL:
#   https://<route>/web-container-access-point
```

**Coexist-then-delete:** keep any old app (e.g. a leftover `tng-...-dev`) running
until the new sandbox app is verified end-to-end from FSM Mobile. The Web Container
URL field holds one URL, so the cutover moment is when you change it — reversible
by switching back. Once Mobile launches work against the sandbox app, delete the old:

```bash
cf delete <old-app-name> -f                # e.g. tng-fsm-<capability>-ui-dev
# do NOT delete the destination service — reuse it
```

---

## Step 8 — Docs

Update each app's docs to match:
- **README.md** — header CF app name (note both sandbox + DevOps), destination
  service name, destination config name, deploy section (both `cf push` and
  `build:mta`/`cf deploy` paths), and any `cf` commands using the app name.
- **NAMING.md** — record the env-suffix deviation if not already there; add the
  app to the appendix table; bump "Last updated".

---

## Quick verification sweep (run before committing)

```bash
# no stale tng anywhere
grep -rn "tng\|TNG" . 2>/dev/null | grep -v node_modules | grep -v .git/

# no stale -dev deploy identifiers or suffixed destination
grep -rn "ui-dev\b\|-destination-dev" manifest.yaml mta.yaml package.json README.md

# mta module name unsuffixed, destination matches in all 3 spots
grep -nE "name:|service-name:" mta.yaml

# sandbox binds the unsuffixed destination
grep -n "fsm-.*-destination" manifest.yaml

# App ID consistent
grep -rn "com.tns.fsm.<capability>.app" manifest.json xs-security.json ui5*.yaml index.html Component.js | wc -l
```

All should come back consistent with the table in "Per-app values to decide first".

---

## Per-app tracker

| App | tng→tns | mta.yaml | manifest.yaml | package.json | docs | deployed + cutover |
|---|---|---|---|---|---|---|
| `inspreppdfviewext` | ✅ | ✅ | ✅ | ✅ | ✅ | ⬜ in progress |
| `secsignsignatureext` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| _app 3_ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |