# Rename Guide — Renaming an Existing TNG FSM Extension

> **Audience:** A developer renaming an existing FSM extension to comply with
> the [NAMING.md](NAMING.md) conventions. This applies to apps that were
> originally created with non-conforming names (typically generator defaults
> like `mobileapptm`, `View1`, etc.) and need to be brought into compliance.
>
> **Time required:** ~2-3 hours of focused work, plus customer/admin
> coordination time for the FSM Web Container URL update.
>
> **Last updated:** April 2026

This guide is the procedure used to rename `mobileapptm` to
`com.tng.fsm.timematerialext.app` in April 2026. It's designed to be reusable
for future renames.

For the target naming patterns, see [NAMING.md](NAMING.md).
For the security architecture that needs to keep working through the rename,
see [SECURITY.md](SECURITY.md).

---

## When to use this guide

Use this guide when:

- An existing app has non-conforming names (typically `mobileapptm`,
  `appforfsm`, `tmjournal`, generator defaults like `View1`)
- The app is already deployed and working in BTP
- You want to bring it into [NAMING.md](NAMING.md) compliance without breaking it

Do NOT use this guide when:

- Setting up a new app from scratch — use [SETUP.md](SETUP.md) and start with
  the correct names per [NAMING.md](NAMING.md)
- The app is locked away under an account you don't control — see
  [SETUP.md](SETUP.md), which describes deploying fresh from GitHub instead

---

## Pre-flight

Before starting, confirm:

- [ ] You have GitHub write access to the app's repository
- [ ] You have CF Space Developer role on the target space
- [ ] You can edit FSM Admin's Web Container settings (or have a customer admin
      who can)
- [ ] The app currently works end-to-end (Mobile + Web UI) — you want a known
      good baseline to revert to if anything goes wrong
- [ ] The team agrees on the target names per [NAMING.md](NAMING.md)
- [ ] You have ~2-3 hours of uninterrupted time

Take a snapshot of the working state:

```bash
git status                  # should be clean
git log --oneline -1        # note the commit SHA — your fallback
git tag pre-rename-baseline # tag the working state for easy rollback
git push origin pre-rename-baseline
```

If anything goes wrong during the rename, you can return to this tag by:
```bash
git reset --hard pre-rename-baseline
cf push   # redeploys the working version
```

---

## Naming targets

Before starting, decide the target names. This guide uses the rename of
`mobileapptm` → `com.tng.fsm.timematerialext.app` as the worked example.

Fill in your own values:

| Aspect | Old | New |
|---|---|---|
| App ID | `mobileapptm` | `com.tng.fsm.<capability>.app` |
| CF app name | `mobileapptm` | `tng-fsm-<capability>-ui-<env>` |
| Service binding | `mobileapptm-destination` | `fsm-<capability>-destination-<env>` |
| Controller file | `View1.controller.js` | `<Capability>.controller.js` |
| View file | `View1.view.xml` | `<Capability>.view.xml` |
| GitHub repo (optional) | varies | `tng-fsm-<capability>-ui` |
| Local folder (optional) | varies | `tng-fsm-<capability>-ui` |

Substitute these throughout the guide.

---

## Phase order and rationale

The rename is split into 5 phases, executed in order. Each phase is committed
separately so any phase can be reverted independently if something breaks.

| Phase | What | Risk | Verify |
|---|---|---|---|
| 1 | Controller and view rename | Low | App still loads after deploy |
| 2 | Service binding rename | Low | App connects to FSM after deploy |
| 3 | CF app name rename | Medium (URL changes) | New URL responds |
| 4 | App ID rename | High (touches ~50 files) | All UI flows still work |
| 5 | Folder rename | Trivial | Cosmetic only |

Phases 1-2 are straightforward. Phase 3 changes the deployed URL so requires
FSM Admin coordination. Phase 4 is the largest change and the most likely to
hit a missed reference. Phase 5 is local cleanup.

For a fresh deployment (no existing CF app to rename in place), Phases 2 and 3
collapse — the new CF app is created with the correct name from day one. See
[SETUP.md](SETUP.md) for that procedure.

---

## Phase 1: Rename controller and view files

### What changes

| From | To |
|---|---|
| `webapp/view/View1.view.xml` | `webapp/view/<Capability>.view.xml` |
| `webapp/controller/View1.controller.js` | `webapp/controller/<Capability>.controller.js` |
| Routing target `TargetView1` in `manifest.json` | `Target<Capability>` |
| Routing route `RouteView1` in `manifest.json` | `Route<Capability>` |
| Class declaration `<old-app-id>.controller.View1` | `<old-app-id>.controller.<Capability>` |

App ID stays unchanged in this phase.

### Steps

```bash
git checkout -b rename/phase1-controller-view

# Use git mv to preserve blame history
git mv webapp/view/View1.view.xml webapp/view/<Capability>.view.xml
git mv webapp/controller/View1.controller.js webapp/controller/<Capability>.controller.js
```

Edit `webapp/controller/<Capability>.controller.js`:
```javascript
// Find:
return Controller.extend("<old-app-id>.controller.View1", {
// Change to:
return Controller.extend("<old-app-id>.controller.<Capability>", {
```

Edit `webapp/manifest.json`'s `routing` section. Replace every `View1` reference
with `<Capability>` (route name, target name, viewId, viewName).

Edit `webapp/Component.js`. Replace every `RouteView1` and `TargetView1`
reference with the new names.

Edit `webapp/view/<Capability>.view.xml`. Find:
```xml
controllerName="<old-app-id>.controller.View1"
```
Change to:
```xml
controllerName="<old-app-id>.controller.<Capability>"
```

> **The view's `controllerName` attribute is easy to miss.** It's the binding
> between the view file and its controller class. Without updating it, the
> controller won't be instantiated when the view loads.

### Verify

```bash
grep -rn "View1" --include="*.js" --include="*.xml" --include="*.json" 2>/dev/null \
    | grep -v node_modules | grep -v dist/ | grep -v resources/
```

Expected results:
- Test files (`webapp/test/...`) may have `View1` references — fix or delete
  per your team's testing setup
- JSDoc comments and inline strings may mention "View1" historically — these
  don't break anything; clean them up if you want pristine state

There should be NO load-bearing references to `View1` remaining (no
`controllerName="...View1"`, no `Controller.extend("...View1")`, no
`viewName: "View1"` in manifest.json, no `RouteView1`/`TargetView1` in JS).

### Build, deploy, test

```bash
rm -rf dist resources
npm run build:cf
cf push
```

After deploy, test:
- App loads (Mobile and Web UI)
- Refresh button works (controller methods accessible)
- Navigation still works (router targets resolved)

If browser console shows `Controller ...View1 not found` or `Failed to load
resource ...View1.controller.js`, you missed a reference.

### Commit

```bash
git add -A
git commit -m "Phase 1: rename View1 to <Capability>"
git push origin rename/phase1-controller-view
```

---

## Phase 2: Rename service binding

### What changes

| File | Change |
|---|---|
| `manifest.yaml` `services:` list | `mobileapptm-destination` → `fsm-<capability>-destination-<env>` |

### Steps

In BTP, rename the service instance. Two options:

**Option A — Rename in place (preserves destinations inside if any):**
```bash
cf rename-service mobileapptm-destination fsm-<capability>-destination-<env>
```

**Option B — Create new and delete old:** Only if the destinations are at the
subaccount level (Scenario A from [SETUP.md](SETUP.md)) and you don't need to
preserve service-instance-internal config.

After the BTP-side rename:

Edit `manifest.yaml`:
```yaml
services:
  - fsm-<capability>-destination-<env>   # was: mobileapptm-destination
```

If `mta.yaml` exists and is actively used, update its references too. If not
used (you deploy via `manifest.yaml`), consider deleting `mta.yaml` to avoid
maintaining two diverging copies.

### Build, deploy, test

```bash
cf push
```

Verify the binding:
```bash
cf env <cf-app-name> | grep VCAP_SERVICES
```

The new binding name should appear. The app should still work — it reads
VCAP_SERVICES generically, not by binding name.

Test FSM Mobile and Web UI launches.

### Commit

```bash
git add -A
git commit -m "Phase 2: rename service binding to fsm-<capability>-destination-<env>"
git push
```

---

## Phase 3: Rename CF app

### What changes

| File | Change |
|---|---|
| `manifest.yaml` `applications[].name` | `mobileapptm` → `tng-fsm-<capability>-ui-<env>` |
| `manifest.yaml` `routes[].route` | New URL pattern |
| `package.json` `undeploy` script | `cf undeploy mobileapptm` → `cf undeploy <new-name>` |

> **Critical:** Renaming the CF app changes the app's URL. The FSM Web Container
> in FSM Admin must be updated to point at the new URL, otherwise FSM Mobile
> launches will hit the old (now-gone) URL and fail.

### Pre-stage the FSM-side change

**Before** the push, prepare FSM Admin:

In FSM Admin → Companies → [Your Company] → Web Containers → [Web Container Name]:

Update the **URL field** to the new URL: `https://tng-fsm-<capability>-ui-<env>-<orgslug>.cfapps.<region>.hana.ondemand.com`

(The exact orgslug and region depend on your CF setup. Check `cf app
<old-name>` to see the current URL pattern, then construct the new one by
substituting the app-name segment.)

Save in FSM Admin. FSM Mobile won't sync until next launch, so this is
non-disruptive in advance.

### Steps

Edit `manifest.yaml`:

```yaml
applications:
  - name: tng-fsm-<capability>-ui-<env>   # was: mobileapptm
    memory: 512M
    disk_quota: 512M
    instances: 1
    buildpacks:
      - nodejs_buildpack
    command: npm start
    path: .
    routes:
      - route: tng-fsm-<capability>-ui-<env>-<orgslug>.cfapps.<region>.hana.ondemand.com
    services:
      - fsm-<capability>-destination-<env>
```

Edit `package.json`:

```json
"undeploy": "cf undeploy tng-fsm-<capability>-ui-<env> --delete-services --delete-service-keys --delete-service-brokers"
```

### Push (creates a new CF app)

```bash
cf push
```

Cloud Foundry sees the new app name and creates a fresh CF app. The old
`mobileapptm` app stays running — both coexist briefly.

Restore env vars on the new app (they don't migrate from the old one):

```bash
# Read existing values from the old app
cf env mobileapptm | grep -E "FSM_WEBCONTAINER_AUTH_KEY|FSM_JWKS_URL"

# Set them on the new app
cf set-env tng-fsm-<capability>-ui-<env> FSM_WEBCONTAINER_AUTH_KEY '<value>'
cf set-env tng-fsm-<capability>-ui-<env> FSM_JWKS_URL '<value-if-set>'

# Restage to pick up the env vars
cf restage tng-fsm-<capability>-ui-<env>
```

### Verify

```bash
cf logs tng-fsm-<capability>-ui-<env> --recent | grep -E "Server running|API mounted|FSM_WEBCONTAINER"
```

Both the old and new app should now be running. Test FSM Mobile (which now
points at the new URL via the FSM Admin change above):

- Force-quit FSM Mobile, reopen, sync, launch T&M Journal
- Should hit the new app
- Should work end-to-end

Once verified, delete the old app:

```bash
cf delete mobileapptm -f
```

### Commit

```bash
git add -A
git commit -m "Phase 3: rename CF app to tng-fsm-<capability>-ui-<env>"
git push
```

---

## Phase 4: Rename App ID

This is the largest phase. The App ID appears in ~50 files via three different
syntactic forms.

### What changes

| Form | Where | Replacement |
|---|---|---|
| Slashed: `<old>/...` | UI5 module paths in `sap.ui.define` | `com/tng/fsm/<capability>/app/...` |
| Dotted: `<old>.X` | Class declarations, namespace references | `com.tng.fsm.<capability>.app.X` |
| Bare: `"<old>"` | JSON values in manifest, xs-security, etc. | `"com.tng.fsm.<capability>.app"` |

### Inventory first

```bash
grep -rn "<old-app-id>" --include="*.js" --include="*.xml" --include="*.json" --include="*.yaml" --include="*.html" 2>/dev/null \
    | grep -v node_modules | grep -v dist/ | grep -v resources/ | grep -v .git/ | wc -l
```

Note the count. After the rename, this should be zero (or close to zero, with
only intentional historical comments remaining).

### Run the find-and-replace

**Slashed form first (most common):**

```bash
find . -type f \( -name "*.js" -o -name "*.xml" -o -name "*.json" \) \
    -not -path "./node_modules/*" \
    -not -path "./dist/*" \
    -not -path "./resources/*" \
    -not -path "./.git/*" \
    -exec sed -i 's|<old-app-id>/|com/tng/fsm/<capability>/app/|g' {} +
```

**Dotted form:**

```bash
find . -type f \( -name "*.js" -o -name "*.xml" -o -name "*.json" \) \
    -not -path "./node_modules/*" \
    -not -path "./dist/*" \
    -not -path "./resources/*" \
    -not -path "./.git/*" \
    -exec sed -i 's|<old-app-id>\.|com.tng.fsm.<capability>.app.|g' {} +
```

The `\.` matches a literal dot. Without escaping, `sed` would also match
`<old-app-id>X` strings.

### Hand-edit the bare references

These should NOT be done with sed (too easy to break unrelated fields with
similar-looking strings):

**`webapp/manifest.json`:**
```json
"id": "<old-app-id>",      → "id": "com.tng.fsm.<capability>.app",
"service": "<old-app-id>"  → "service": "com.tng.fsm.<capability>.app"
```

**`xs-security.json`:**
```json
"xsappname": "<old-app-id>",  → "xsappname": "com.tng.fsm.<capability>.app",
```

**`ui5.yaml`, `ui5-local.yaml`, `ui5-deploy.yaml`:**
```yaml
metadata:
  name: <old-app-id>           → name: com.tng.fsm.<capability>.app
```

**`ui5-deploy.yaml`** (also has `archiveName`):
```yaml
archiveName: <old-app-id>      → archiveName: com.tng.fsm.<capability>.app
```

**`package.json`** (npm names can't have dots — use the hyphenated form
matching the folder/repo):
```json
"name": "<old-app-id>"         → "name": "tng-fsm-<capability>-ui"
```

**`webapp/index.html`** (CRITICAL — easy to miss):

This file references the app ID in the bootstrap configuration. Look for two
patterns:

```html
data-sap-ui-resourceroots='{
    "<old-app-id>": "./"          → "com.tng.fsm.<capability>.app": "./"
}'
```

```html
data-name="<old-app-id>"          → data-name="com.tng.fsm.<capability>.app"
```

Or in JS within the HTML:
```javascript
new sap.ui.core.ComponentContainer({
    name: "<old-app-id>"          → name: "com.tng.fsm.<capability>.app"
})
```

> **Why `index.html` is the most-missed file:** Find-and-replace patterns
> (`<old-app-id>/` and `<old-app-id>.`) don't match the bare-string references
> in HTML attributes and JS object literals. Manual edit required.

**`webapp/simple.html`** (if it exists): same pattern as `index.html`.

### Component lookup strings (also easy to miss)

UI5 components are sometimes looked up via a special pattern:

```javascript
sap.ui.getCore().getComponent("container-<old-app-id>")
```

The literal prefix `container-` plus the App ID. Find these:

```bash
grep -rn '"container-<old-app-id>"' --include="*.js" 2>/dev/null \
    | grep -v node_modules | grep -v dist/ | grep -v resources/
```

If any are found, replace:

```bash
sed -i 's|"container-<old-app-id>"|"container-com.tng.fsm.<capability>.app"|g' \
    <each-file-from-above>
```

### Operator log messages

Some console.error messages reference CF commands using the old name. Find them:

```bash
grep -rn 'cf set-env <old-app-id>\|cf restage <old-app-id>\|cf logs <old-app-id>' --include="*.js" 2>/dev/null \
    | grep -v node_modules
```

Update these to reference the new CF app name (which was renamed in Phase 3,
not the App ID). For this app's case:

```bash
sed -i 's|cf set-env <old-app-id>|cf set-env tng-fsm-<capability>-ui-<env>|g' index.js
```

### Optional: delete `mta.yaml`

If `mta.yaml` exists but is not actively used for deployment (deploy uses
`manifest.yaml`), delete it rather than maintaining ~30 references in two
diverging files:

```bash
git rm mta.yaml
```

### Final verification

```bash
grep -rn "<old-app-id>" --include="*.js" --include="*.xml" --include="*.json" --include="*.yaml" --include="*.yml" --include="*.html" 2>/dev/null \
    | grep -v node_modules \
    | grep -v "package-lock.json" \
    | grep -v dist/ | grep -v resources/ | grep -v .git/
```

Expected output:
- Possibly some `.vscode/launch.json` lines (BAS-local config, can be left or
  added to `.gitignore`)
- Possibly some test files (decide based on whether tests are actually run)
- Possibly some pure JSDoc/XML comments referencing history (harmless)

There should be NO references to the old name in:
- Code that runs at runtime (controllers, services, mixins)
- Configuration files (manifest.json, manifest.yaml, ui5*.yaml, xs-security.json)
- HTML files (index.html, simple.html)
- Bootstrap files (Component.js)

### Build

```bash
rm -rf dist resources
npm run build:cf
```

The build output should reference the new App ID:
```
ProjectBuilder Preparing build for project com.tng.fsm.<capability>.app
```

If the build complains about unresolved modules, you missed a reference.

### Local sanity test (highly recommended)

Before deploying, start the app locally and load it in a browser:

```bash
export FSM_WEBCONTAINER_AUTH_KEY='local-dev-test-value'
npm start
```

Open `http://localhost:3000` in a browser (or use BAS port forwarding). Open
DevTools console.

Look for:
- ✅ App loads (UI5 framework + your modules all resolve)
- ✅ NO "Failed to load resource" errors mentioning the old App ID
- ✅ NO `mobileapptm/...` (old paths) requested anywhere

If the app loads cleanly locally, you've caught the missed-reference class of
bugs that the build alone doesn't always reveal.

> **Don't skip the local browser test.** The build process is text-processing.
> Module loading happens at runtime in the browser. References missed by the
> build (like the `index.html` bootstrap config) only fail when the browser
> tries to actually instantiate the component.

### Build, deploy, test

```bash
cf push
```

After deploy, test thoroughly. UI5 modules load lazily — broken paths don't
fail until that specific module is needed. Exercise every flow:

- App loads (Mobile and Web UI)
- Type Config dialog opens
- Add Entry dialog opens (test all three: Time/Material, Expense, Mileage flavors)
- Edit Selected on a table works
- Delete Selected on PENDING entry works
- Refresh button works
- Session Context dialog opens

Watch for ANY browser console errors. Trace each one back to a missed reference.

### Commit

```bash
git add -A
git commit -m "Phase 4: rename App ID from <old-app-id> to com.tng.fsm.<capability>.app"
git push
```

---

## Phase 5: Folder rename (optional, cosmetic)

The local folder name is purely cosmetic. The folder doesn't appear inside any
deployed file. Renaming is trivial.

### Steps

Close your IDE / BAS. Then:

```bash
cd ~/projects   # or wherever the project lives
mv <old-folder> tng-fsm-<capability>-ui
```

Re-open in your IDE at the new path. Update any IDE-specific config
(`.vscode/launch.json` paths, etc.) if needed.

If your shell history or saved scripts reference the old path, update them.

That's it. Nothing inside any file changes.

---

## Rollback

Each phase is its own commit. To revert:

**Phase 1 broken:** `git revert HEAD` and `cf push`. Restores the View1 names.

**Phase 2 broken:** `git revert HEAD`. Run `cf rename-service` to revert the BTP
side. `cf push`.

**Phase 3 broken:** Trickier — the new CF app exists. To revert: `git revert HEAD`,
`cf push` to redeploy the old name. `cf delete <new-name>`. Update FSM Admin
URL back to old. Restore env vars on old app if missing.

**Phase 4 broken:** `git revert HEAD` (it's all one commit). `cf push`.

**Phase 5 broken:** `mv` the folder back. Trivial.

If multiple phases broke and rollback is messy, the nuclear option is:

```bash
git checkout pre-rename-baseline
cf push
```

This jumps back to the tag created in pre-flight, fully reverting all phases.
Update FSM Admin URL back to the original, restore env vars, etc.

---

## Lessons learned (April 2026 rename)

The April 2026 rename of `mobileapptm` → `com.tng.fsm.timematerialext.app` ran
into these gotchas. They're addressed in the steps above but worth noting for
future awareness:

1. **`webapp/index.html` was the largest miss.** The bootstrap config's
   `data-sap-ui-resourceroots` and the `data-name` attribute are bare-string
   references that no `mobileapptm/` or `mobileapptm.` find-and-replace pattern
   matches. Fixed in this guide by listing it as a manual-edit file.

2. **`"container-<old-app-id>"` lookup strings.** Used in `formatter.js` and
   `TMCreationService.js` for component lookup. The `container-` prefix means
   they don't match standard rename patterns. Fixed in this guide.

3. **The view's `controllerName` attribute was missed in early Phase 1.**
   Renamed the file but the attribute pointing at the controller still said
   `View1`. Fixed in this guide.

4. **`mta.yaml` had ~30 references** but wasn't actively used for deployment.
   Decided to delete rather than maintain. Fixed in this guide.

5. **Local `npm start` didn't catch the `index.html` bug** because the issue
   only manifests when a browser actually tries to load the page. Fixed by
   adding the "load in browser locally" step before deploy.

6. **The old `mobileapptm` app stayed running alongside the new one** during
   Phase 3. Both coexisted for verification, then the old was deleted. This
   pattern is safer than in-place renaming and is documented in Phase 3.

---

## Reference

- [SETUP.md](SETUP.md) — fresh deployment guide (use for new apps, or when
  deploying to a new BTP subaccount)
- [NAMING.md](NAMING.md) — naming convention specification
- [SECURITY.md](SECURITY.md) — security architecture (must keep working through
  the rename)
- [README.md](../README.md) — app overview, features, API reference