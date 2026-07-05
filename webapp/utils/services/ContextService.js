/**
 * ContextService.js
 *
 * Detects the current FSM environment and returns a unified context object.
 *
 * Supported sources (detected automatically):
 *   'mobile' – FSM Mobile Web Container (context stored by Express backend)
 *   'shell'  – FSM Web UI Shell Extension (fsm-shell SDK in iframe)
 *
 * Every source normalises its data to the same output shape so callers
 * never need to know where the context came from:
 * {
 *   source:                          'mobile' | 'shell'
 *   userName:                        string
 *   companyName:                     string
 *   cloudAccount:                    string
 *   cloudId:                         string   ← Activity / ServiceCall ID
 *   objectType:                      string   ← 'ACTIVITY' | 'SERVICECALL'
 *   language:                        string
 *   dataCloudFullQualifiedDomainName: string
 *   authToken:                       string | null  (Shell only)
 * }
 *
 * Usage:
 *   ContextService.getContext().then(context => { ... })
 *
 * @file webapp/utils/services/ContextService.js
 * @module com/tns/fsm/secsignsignatureext/app/utils/services/ContextService
 */
sap.ui.define([], () => {
    "use strict";

    const SHELL_SDK_URL           = "https://unpkg.com/fsm-shell@1.20.0/release/fsm-shell-client.js";
    const SHELL_SDK_TIMEOUT_MS    = 5000;
    const SHELL_CTX_TIMEOUT_MS    = 5000;
    const SHELL_VIEWSTATE_WAIT_MS = 2000;

    return {

        /**
         * Detect environment and return a normalised context object.
         * Rejects if no context can be obtained.
         * @returns {Promise<Object>} Normalised context
         */
        getContext() {
            if (this._isInIframe()) {
                return this._getShellContext();
            }
            return this._getMobileContext();
        },

        // ── Mobile ────────────────────────────────────────────────────────

        async _getMobileContext() {
            const params     = new URLSearchParams(window.location.search);
            const sessionKey = params.get("session");

            const url = sessionKey
                ? `/web-container-context?session=${encodeURIComponent(sessionKey)}`
                : "/web-container-context";

            const response = await fetch(url);
            if (!response.ok) throw new Error(`Mobile context HTTP ${response.status}`);

            const data = await response.json();
            return { ...data, source: "mobile" };
        },

        // ── Shell ─────────────────────────────────────────────────────────

        async _getShellContext() {
            await this._loadShellSdk();
            const raw = await this._requestShellContext();

            return {
                source:                           "shell",
                userName:                         raw.user           || "N/A",
                companyName:                      raw.company        || "N/A",
                cloudAccount:                     raw.account        || "N/A",
                cloudId:                          raw.objectId       || "N/A",
                objectType:                       raw.objectType     || "N/A",
                language:                         raw.selectedLocale || "N/A",
                dataCloudFullQualifiedDomainName: raw.cloudHost      || "N/A",
                authToken:                        raw.auth?.access_token || null
            };
        },

        _loadShellSdk() {
            return new Promise((resolve, reject) => {
                if (window.FSMShell) { resolve(); return; }

                const script   = document.createElement("script");
                script.src     = SHELL_SDK_URL;
                script.async   = true;
                script.onload  = () => { console.log("[ContextService] Shell SDK loaded"); resolve(); };
                script.onerror = () => reject(new Error("Shell SDK failed to load"));
                document.head.appendChild(script);

                setTimeout(() => {
                    if (!window.FSMShell) reject(new Error("Shell SDK load timeout"));
                }, SHELL_SDK_TIMEOUT_MS);
            });
        },

        _requestShellContext() {
            return new Promise((resolve, reject) => {
                const { ShellSdk, SHELL_EVENTS } = window.FSMShell;
                const sdk = ShellSdk.init(parent, "*");

                const hardTimeout = setTimeout(
                    () => reject(new Error("Shell context timeout")), SHELL_CTX_TIMEOUT_MS
                );

                let baseData   = null;
                let objectId   = null;
                let objectType = null;
                let resolved   = false;

                const done = () => {
                    if (resolved || !baseData) return;
                    resolved = true;
                    clearTimeout(hardTimeout);
                    resolve({ ...baseData, objectId, objectType });
                };

                sdk.on(SHELL_EVENTS.Version1.REQUIRE_CONTEXT, (event) => {
                    try {
                        baseData = typeof event === "string" ? JSON.parse(event) : event;

                        const vs = baseData.viewState;
                        if (vs) {
                            const actId = vs.activityID || vs.selectedActivityId || vs.activityId;
                            const scId  = vs.selectedServiceCallId || vs.serviceCallID || vs.serviceCallId;
                            if (actId)     { objectId = actId; objectType = "ACTIVITY";    }
                            else if (scId) { objectId = scId;  objectType = "SERVICECALL"; }
                        }

                        setTimeout(done, SHELL_VIEWSTATE_WAIT_MS);
                    } catch (e) {
                        reject(new Error("Shell context parse error: " + e.message));
                    }
                });

                const onActivity = (a) => {
                    if (!a?.id) return;
                    objectId = a.id; objectType = "ACTIVITY";
                    done();
                };
                const onServiceCall = (sc) => {
                    if (!sc?.id || objectId) return;
                    objectId = sc.id; objectType = "SERVICECALL";
                    done();
                };

                ["activity", "ACTIVITY"].forEach(k => sdk.onViewState(k, onActivity));
                ["serviceCall", "SERVICECALL"].forEach(k => sdk.onViewState(k, onServiceCall));

                sdk.emit(SHELL_EVENTS.Version1.REQUIRE_CONTEXT, {
                    clientIdentifier: "fsm-signing-extension",
                    auth: { response_type: "token" }
                });
            });
        },

        // ── Utility ───────────────────────────────────────────────────────

        _isInIframe() {
            try { return window.self !== window.top; }
            catch (e) { return true; }
        }
    };
});