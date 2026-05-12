sap.ui.define([
    "sap/ui/core/mvc/Controller",
    "sap/ui/model/json/JSONModel",
    "sap/m/MessageBox",
    "sap/m/MessageToast",
    "com/tng/fsm/secsignsignatureext/app/utils/services/ContextService",
    "com/tng/fsm/secsignsignatureext/app/utils/services/AttachmentService",
    "com/tng/fsm/secsignsignatureext/app/utils/services/SigningService"
], (Controller, JSONModel, MessageBox, MessageToast, ContextService, AttachmentService, SigningService) => {
    "use strict";

    return Controller.extend("com.tng.fsm.secsignsignatureext.app.controller.SecSignSignatureExt", {

        // ── Init ───────────────────────────────────────────────────────────

        onInit() {
            this.getView().setModel(new JSONModel({
                busy:              true,
                contextLoaded:     false,
                showError:         false,
                context:           {},
                attachments:       [],
                attachmentsBusy:   false,
                attachmentsLoaded: false,
                selectedCount:     0,
                pdfUrl:            null,
                pdfFileName:       ""
            }), "view");

            this._loadContext();
        },

        // ── Context ────────────────────────────────────────────────────────

        async _loadContext() {
            const oModel = this.getView().getModel("view");

            try {
                const context = await ContextService.getContext();

                oModel.setProperty("/context", context);
                oModel.setProperty("/contextLoaded", true);
                oModel.setProperty("/busy", false);

                console.log("[SecSignSignatureExt] Context loaded:", {
                    source: context.source, user: context.userName,
                    objectType: context.objectType, cloudId: context.cloudId
                });
                console.log("[SecSignSignatureExt] AuthToken:", context.authToken);

                if (context.cloudId && context.cloudId !== "N/A") {
                    await this._loadAttachments(context.cloudId);
                } else {
                    console.warn("[SecSignSignatureExt] No cloudId – skipping attachment load");
                }

                this._checkSigningReturn();

            } catch (error) {
                console.warn("[SecSignSignatureExt] Context unavailable:", error.message);
                // Still check for pending signing return even if context failed
                // (session may have expired while user was on SecSign portal)
                this._checkSigningReturn();
                oModel.setProperty("/showError", true);
                oModel.setProperty("/busy", false);
            }
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
                console.error("[SecSignSignatureExt] Attachment load failed:", error.message);
                oModel.setProperty("/attachmentsLoaded", true);

            } finally {
                oModel.setProperty("/attachmentsBusy", false);
            }
        },

        // ── Sign ───────────────────────────────────────────────────────────

        onSignPress(oEvent) {
            const oCtx        = oEvent.getSource().getBindingContext("view");
            const oModel      = oCtx.getModel();
            const oAttachment = oCtx.getObject();
            const oContext    = oModel.getProperty("/context");

            console.log("[SecSignSignatureExt] Sign pressed | file:", oAttachment.fileName);

            SigningService.triggerSigning(oAttachment, oContext)
                .then(result => {
                    console.log("[SecSignSignatureExt] Signing trigger OK | result:", result);

                    if (result?.workflowstepurl) {
                        console.log("[SecSignSignatureExt] Navigating to signing portal:", result.workflowstepurl);
                        // Save signing context before navigating — needed to retrieve signed PDF on return
                        const oContext = oModel.getProperty("/context");
                        localStorage.setItem("pendingSigning", JSON.stringify({
                            portfolioId:  result.portfolioid,
                            attachmentId: oAttachment.id,
                            objectId:     oContext.cloudId
                        }));
                        console.log("[SecSignSignatureExt] Saved pendingSigning to localStorage | portfolioId:", result.portfolioid);
                        window.location.href = result.workflowstepurl;
                    } else {
                        console.warn("[SecSignSignatureExt] No workflowstepurl – marking signed locally");
                        MessageBox.success("Signed!", {
                            title:   "Document Signed",
                            details: JSON.stringify(result, null, 2),
                            onClose: () => oModel.setProperty(oCtx.getPath() + "/signed", true)
                        });
                    }
                })
                .catch(error => {
                    console.error("[SecSignSignatureExt] Signing failed:", error.message);
                    MessageBox.error("Signing failed", { title: "Error", details: error.message });
                });
        },

        // ── Return from signing portal ─────────────────────────────────────

        _checkSigningReturn() {
            const params     = new URLSearchParams(window.location.search);
            const pendingRaw = localStorage.getItem("pendingSigning");
            const pending    = pendingRaw ? JSON.parse(pendingRaw) : null;

            if (!pending) return;

            console.log("[SecSignSignatureExt] Returned from signing portal | portfolioId:", pending.portfolioId);

            // Clear immediately so it doesn't re-trigger on next load
            localStorage.removeItem("pendingSigning");

            const oModel = this.getView().getModel("view");
            oModel.setProperty("/attachmentsBusy", true);

            AttachmentService.uploadSignedPdf(
                pending.portfolioId,
                pending.attachmentId
            )
                .then(result => {
                    console.log("[SecSignSignatureExt] Signed PDF saved | attachmentId:", result.attachmentId);
                    MessageToast.show("Document signed and saved successfully", { duration: 5000 });
                    // Reload table so signed status (UDF) is reflected immediately
                    const objectId = pending.objectId
                        || this.getView().getModel("view").getProperty("/context/cloudId");
                    if (objectId) this._loadAttachments(objectId).finally(() => {
                        oModel.setProperty("/attachmentsBusy", false);
                    }); else oModel.setProperty("/attachmentsBusy", false);
                })
                .catch(error => {
                    console.error("[SecSignSignatureExt] Signed PDF upload failed:", error.message);
                    oModel.setProperty("/attachmentsBusy", false);
                    MessageBox.error("Signed PDF could not be saved: " + error.message);
                });

            // Clean URL — keep only session param
            const sessionKey = params.get("session");
            const cleanUrl   = window.location.pathname
                + (sessionKey ? `?session=${encodeURIComponent(sessionKey)}` : "")
                + window.location.hash;
            window.history.replaceState({}, document.title, cleanUrl);
        },

        // ── Merge ──────────────────────────────────────────────────────────

        onSelectionChange() {
            const count = this.byId("attachmentsTable").getSelectedItems().length;
            this.getView().getModel("view").setProperty("/selectedCount", count);
            console.log("[SecSignSignatureExt] Selection changed | selected:", count);
        },

        onMergePress() {
            const oTable   = this.byId("attachmentsTable");
            const oModel   = this.getView().getModel("view");
            const selected = oTable.getSelectedItems();

            const attachmentIds = selected.map(i => i.getBindingContext("view").getProperty("id"));
            const fileNames     = selected.map(i => i.getBindingContext("view").getProperty("fileName"));

            console.log("[SecSignSignatureExt] Merge pressed | ids:", attachmentIds, "| files:", fileNames);

            oModel.setProperty("/pdfUrl", null);
            oModel.setProperty("/pdfFileName", "Merging...");
            oModel.setProperty("/attachmentsBusy", true);

            AttachmentService.mergePdfs(attachmentIds)
                .then(url => {
                    oModel.setProperty("/pdfUrl", url);
                    oModel.setProperty("/pdfFileName", `Merged (${fileNames.join(" + ")})`);
                    oModel.setProperty("/attachmentsBusy", false);
                    console.log("[SecSignSignatureExt] Merge complete | url:", url);
                    this.byId("pdfPanel").getDomRef()?.scrollIntoView({ behavior: "smooth" });
                })
                .catch(error => {
                    console.error("[SecSignSignatureExt] Merge failed:", error.message);
                    oModel.setProperty("/attachmentsBusy", false);
                    oModel.setProperty("/pdfFileName", "");
                    MessageBox.error("Merge failed: " + error.message);
                });
        },

        // ── PDF Viewer ─────────────────────────────────────────────────────

        onFileNamePress(oEvent) {
            const oAttachment = oEvent.getSource().getBindingContext("view").getObject();
            const oModel      = this.getView().getModel("view");

            oModel.setProperty("/pdfUrl",      AttachmentService.getPdfUrl(oAttachment.id));
            oModel.setProperty("/pdfFileName", oAttachment.fileName);

            console.log("[SecSignSignatureExt] PDF opened:", oAttachment.fileName);
            this.byId("pdfPanel").getDomRef()?.scrollIntoView({ behavior: "smooth" });
        },

        onClosePdf() {
            const oModel = this.getView().getModel("view");
            oModel.setProperty("/pdfUrl", null);
            oModel.setProperty("/pdfFileName", "");
        }

    });
});