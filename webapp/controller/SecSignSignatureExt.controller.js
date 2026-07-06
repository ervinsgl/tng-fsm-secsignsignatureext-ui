sap.ui.define([
    "sap/ui/core/mvc/Controller",
    "sap/ui/model/json/JSONModel",
    "sap/m/MessageBox",
    "sap/m/MessageToast",
    "com/tns/fsm/secsignsignatureext/app/utils/services/ContextService",
    "com/tns/fsm/secsignsignatureext/app/utils/services/AttachmentService",
    "com/tns/fsm/secsignsignatureext/app/utils/services/SigningService",
    "com/tns/fsm/secsignsignatureext/app/utils/services/UserService"
], (Controller, JSONModel, MessageBox, MessageToast, ContextService, AttachmentService, SigningService, UserService) => {
    "use strict";

    const PENDING_KEY = "pendingSigning";

    return Controller.extend("com.tns.fsm.secsignsignatureext.app.controller.SecSignSignatureExt", {

        // ── Init ───────────────────────────────────────────────────────────

        onInit() {
            this.getView().setModel(new JSONModel({
                busy: true,
                contextLoaded: false,
                showError: false,
                context: {},
                user: null,
                attachments: [],
                attachmentsBusy: false,
                attachmentsLoaded: false,
                selectedCount: 0,
                pdfUrl: null,
                pdfFileName: ""
            }), "view");

            this._loadContext();
        },

        // ── i18n helpers ───────────────────────────────────────────────────

        /**
         * Convenience accessor for the i18n resource bundle.
         * Reads from the owner component (where the manifest declares the model)
         * so it is available even before view-level model propagation completes.
         * @returns {sap.base.i18n.ResourceBundle}
         * @private
         */
        _i18n() {
            return this.getOwnerComponent().getModel("i18n").getResourceBundle();
        },

        /**
         * Formatter: "N item(s)" for the attachment count badge.
         * @param {Array} attachments
         * @returns {string}
         */
        formatItemCount(attachments) {
            const count = Array.isArray(attachments) ? attachments.length : 0;
            return this._i18n().getText("itemCount", [count]);
        },

        /**
         * Formatter: "Sign Selected (N)" for the batch sign button.
         * @param {number} count
         * @returns {string}
         */
        formatSignSelected(count) {
            return this._i18n().getText("signSelected", [count || 0]);
        },

        // ── Context ────────────────────────────────────────────────────────

        async _loadContext() {
            const oModel = this.getView().getModel("view");

            try {
                const context = await ContextService.getContext();

                // Apply FSM locale before translatable content renders.
                this._setAppLanguage(context.language || context.locale);

                oModel.setProperty("/context", context);
                oModel.setProperty("/contextLoaded", true);
                oModel.setProperty("/busy", false);

                console.log("[View1] Context loaded:", {
                    source: context.source, user: context.userName,
                    objectType: context.objectType, cloudId: context.cloudId
                });

                // Enrich the header with the logged-in user's profile (non-blocking).
                this._loadUser(context.userName);

                if (context.cloudId && context.cloudId !== "N/A") {
                    await this._loadAttachments(context.cloudId);
                } else {
                    console.warn("[View1] No cloudId – skipping attachment load");
                }

                this._checkSigningReturn();

            } catch (error) {
                console.warn("[View1] Context unavailable:", error.message);
                // Still check for a pending signing return even if context failed
                // (session may have expired while user was on the SecSign portal).
                this._checkSigningReturn();
                oModel.setProperty("/showError", true);
                oModel.setProperty("/busy", false);
            }
        },

        /**
         * Set application language based on FSM context.
         * Normalizes 'de-DE' -> 'de' and only switches if different.
         * Must run before the views/tables with translatable text render.
         * @param {string} language - Language code (e.g., 'de', 'en')
         * @private
         */
        _setAppLanguage(language) {
            if (!language || language === "N/A") return;

            const langCode = language.toLowerCase().split("-")[0].split("_")[0];
            const currentLang = sap.ui.getCore().getConfiguration().getLanguage();
            const currentLangCode = currentLang.toLowerCase().split("-")[0].split("_")[0];

            if (langCode !== currentLangCode) {
                console.log(`[View1] Setting language to '${langCode}' (from FSM context)`);
                sap.ui.getCore().getConfiguration().setLanguage(langCode);
            }
        },

        // ── User ───────────────────────────────────────────────────────────

        /**
         * Resolve the logged-in user's profile and store it on the model for
         * the header. Non-blocking: a lookup failure just leaves the header
         * showing the plain user name.
         * @param {string} userName
         * @private
         */
        _loadUser(userName) {
            if (!userName || userName === "N/A") return;

            const oModel = this.getView().getModel("view");

            UserService.getUserByName(userName)
                .then(user => {
                    if (user) {
                        oModel.setProperty("/user", user);
                        console.log("[View1] User loaded | email:", user.email);
                    }
                })
                .catch(error => {
                    console.warn("[View1] User lookup failed:", error.message);
                });
        },

        // ── Attachments ────────────────────────────────────────────────────

        async _loadAttachments(objectId) {
            const oModel = this.getView().getModel("view");
            oModel.setProperty("/attachmentsBusy", true);

            try {
                const attachments = await AttachmentService.loadAttachments(objectId);
                oModel.setProperty("/attachments", attachments);
                oModel.setProperty("/attachmentsLoaded", true);

            } catch (error) {
                console.error("[View1] Attachment load failed:", error.message);
                oModel.setProperty("/attachmentsLoaded", true);

            } finally {
                oModel.setProperty("/attachmentsBusy", false);
            }
        },

        // ── Sign (single row) ──────────────────────────────────────────────

        onSignPress(oEvent) {
            const oCtx = oEvent.getSource().getBindingContext("view");
            const oAttachment = oCtx.getObject();

            console.log("[View1] Sign pressed | file:", oAttachment.fileName);
            this._startSigning([{ id: oAttachment.id, fileName: oAttachment.fileName }]);
        },

        // ── Sign (selected rows) ───────────────────────────────────────────

        onSignSelectedPress() {
            const oTable = this.byId("attachmentsTable");
            const selected = oTable.getSelectedItems();

            const documents = selected
                .map(i => i.getBindingContext("view").getObject())
                .filter(a => !a.signed) // don't re-sign already-signed docs
                .map(a => ({ id: a.id, fileName: a.fileName }));

            if (documents.length === 0) {
                MessageToast.show(this._i18n().getText("selectUnsignedFirst"));
                return;
            }

            console.log("[View1] Sign selected pressed | count:", documents.length);
            this._startSigning(documents);
        },

        /**
         * Shared entry point for single and multi-document signing.
         * Starts one SecSign workflow for all documents, persists the batch,
         * then navigates to the signing portal.
         * @param {Array} documents - [{ id, fileName }]
         * @private
         */
        _startSigning(documents) {
            const oModel = this.getView().getModel("view");
            const oContext = oModel.getProperty("/context");

            oModel.setProperty("/attachmentsBusy", true);

            SigningService.triggerSigning(documents, oContext)
                .then(result => {
                    console.log("[View1] Signing trigger OK | portfolioId:", result.portfolioid);

                    if (!result?.workflowstepurl) {
                        oModel.setProperty("/attachmentsBusy", false);
                        MessageBox.error(this._i18n().getText("signingNoUrl"));
                        return;
                    }

                    // Persist the batch so the return handler can finalize + match.
                    localStorage.setItem(PENDING_KEY, JSON.stringify({
                        portfolioId: result.portfolioid,
                        objectId: oContext.cloudId,
                        documents: result.documents // [{ attachmentId, fileName }]
                    }));
                    console.log("[View1] Saved pending batch | portfolioId:", result.portfolioid,
                        "| docs:", result.documents?.length);

                    window.location.href = result.workflowstepurl;
                })
                .catch(error => {
                    console.error("[View1] Signing failed:", error.message);
                    oModel.setProperty("/attachmentsBusy", false);
                    MessageBox.error(this._i18n().getText("signingFailed"), {
                        title: this._i18n().getText("signingFailedTitle"),
                        details: error.message
                    });
                });
        },

        // ── Return from signing portal ─────────────────────────────────────

        _checkSigningReturn() {
            const params = new URLSearchParams(window.location.search);
            const pendingRaw = localStorage.getItem(PENDING_KEY);
            const pending = pendingRaw ? JSON.parse(pendingRaw) : null;

            // Always clean the URL back to just the session param.
            const cleanUrl = () => {
                const sessionKey = params.get("session");
                const url = window.location.pathname
                    + (sessionKey ? `?session=${encodeURIComponent(sessionKey)}` : "")
                    + window.location.hash;
                window.history.replaceState({}, document.title, url);
            };

            if (!pending) return;

            console.log("[View1] Returned from signing portal | portfolioId:", pending.portfolioId);

            // Clear immediately so it doesn't re-trigger on the next load.
            localStorage.removeItem(PENDING_KEY);

            const oModel = this.getView().getModel("view");
            oModel.setProperty("/attachmentsBusy", true);

            AttachmentService.finalizeSigned(pending.portfolioId, pending.documents)
                .then(result => {
                    if (result.signed && result.signedAttachmentIds.length > 0) {
                        console.log("[View1] Signed + saved | ids:", result.signedAttachmentIds);
                        const count = result.signedAttachmentIds.length;
                        MessageToast.show(
                            count === 1
                                ? this._i18n().getText("docSignedSaved")
                                : this._i18n().getText("docsSignedSaved", [count]),
                            { duration: 5000 }
                        );
                    } else {
                        // Not signed — user likely went back or declined. Nothing changed.
                        console.log("[View1] Not signed | state:", result.state);
                        MessageToast.show(this._i18n().getText("signingNotCompleted"), { duration: 6000 });
                    }

                    // Reload so the table reflects the real UDF state from FSM.
                    const objectId = pending.objectId || oModel.getProperty("/context/cloudId");
                    if (objectId) {
                        this._loadAttachments(objectId).finally(() => oModel.setProperty("/attachmentsBusy", false));
                    } else {
                        oModel.setProperty("/attachmentsBusy", false);
                    }
                })
                .catch(error => {
                    console.error("[View1] Finalize failed:", error.message);
                    oModel.setProperty("/attachmentsBusy", false);
                    MessageBox.error(this._i18n().getText("finalizeFailed", [error.message]));
                })
                .finally(cleanUrl);
        },

        // ── Selection ──────────────────────────────────────────────────────

        onSelectionChange() {
            const count = this.byId("attachmentsTable").getSelectedItems().length;
            this.getView().getModel("view").setProperty("/selectedCount", count);
            console.log("[View1] Selection changed | selected:", count);
        },

        /**
         * Fires whenever the table finishes (re)rendering its rows.
         * Hides the MultiSelect checkbox on already-signed rows so signed
         * attachments cannot be selected for signing.
         * (SAPUI5 has no declarative per-row checkbox toggle — this is the
         * documented programmatic approach.)
         */
        onTableUpdateFinished(oEvent) {
            const oTable = oEvent.getSource();

            oTable.getItems().forEach(oItem => {
                const oCtx = oItem.getBindingContext("view");
                if (!oCtx) return;

                const bSigned = oCtx.getProperty("signed") === true;
                const oCheckbox = oItem.getMultiSelectControl
                    ? oItem.getMultiSelectControl(true)
                    : null;

                if (oCheckbox) {
                    oCheckbox.setVisible(!bSigned);
                    // Defensively drop any lingering selection on a signed row.
                    if (bSigned && oItem.getSelected()) {
                        oItem.setSelected(false);
                    }
                }
            });

            // Selection may have changed if a signed row was deselected above.
            this.getView().getModel("view").setProperty(
                "/selectedCount",
                oTable.getSelectedItems().length
            );
        },

        // ── PDF Viewer ─────────────────────────────────────────────────────

        onFileNamePress(oEvent) {
            const oAttachment = oEvent.getSource().getBindingContext("view").getObject();
            const oModel = this.getView().getModel("view");

            oModel.setProperty("/pdfUrl", AttachmentService.getPdfUrl(oAttachment.id));
            oModel.setProperty("/pdfFileName", oAttachment.fileName);

            console.log("[View1] PDF opened:", oAttachment.fileName);
            this.byId("pdfPanel").getDomRef()?.scrollIntoView({ behavior: "smooth" });
        },

        onClosePdf() {
            const oModel = this.getView().getModel("view");
            oModel.setProperty("/pdfUrl", null);
            oModel.setProperty("/pdfFileName", "");
        }

    });
});