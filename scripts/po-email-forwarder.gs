/**
 * Google Apps Script: forward vendor purchase-order PDFs into the
 * Production Manager app (section 5's pending-PO list).
 *
 * Works standalone (searches Gmail) or appended to an existing script that
 * already files PO emails into the Drive folder. Setup:
 *   1. script.google.com → New project → paste this file.
 *   2. Set APP_URL to your deployment.
 *   3. Triggers (clock icon) → Add trigger → sendNewPurchaseOrders,
 *      time-driven, every hour.
 * Processed messages are labelled so nothing is sent twice.
 */
var APP_URL = "https://productionmgr.vercel.app";
var GMAIL_QUERY = 'has:attachment filename:pdf subject:("purchase order" OR "PO")';
var DONE_LABEL = "PM-app-sent";

function sendNewPurchaseOrders() {
  var label = GmailApp.getUserLabelByName(DONE_LABEL) || GmailApp.createLabel(DONE_LABEL);
  var threads = GmailApp.search(GMAIL_QUERY + " -label:" + DONE_LABEL, 0, 20);
  threads.forEach(function (thread) {
    thread.getMessages().forEach(function (msg) {
      msg.getAttachments().forEach(function (att) {
        if (att.getContentType() !== "application/pdf") return;
        var payload = {
          filename: att.getName(),
          pdfBase64: Utilities.base64Encode(att.getBytes()),
        };
        var res = UrlFetchApp.fetch(APP_URL + "/api/inventory-counts", {
          method: "post",
          contentType: "application/json",
          payload: JSON.stringify(payload),
          muteHttpExceptions: true,
        });
        Logger.log(att.getName() + " -> " + res.getResponseCode());
      });
    });
    thread.addLabel(label);
  });
}

/** Alternative: watch the Drive folder the POs are already filed into. */
var DRIVE_FOLDER_ID = "1OcdqY9C97jcWpSysuXCtZwDa3HsaAfVt";

function sendNewDrivePos() {
  var props = PropertiesService.getScriptProperties();
  var folder = DriveApp.getFolderById(DRIVE_FOLDER_ID);
  var files = folder.getFiles();
  while (files.hasNext()) {
    var file = files.next();
    if (file.getMimeType() !== "application/pdf") continue;
    if (props.getProperty("sent-" + file.getId())) continue;
    var payload = {
      filename: file.getName(),
      pdfBase64: Utilities.base64Encode(file.getBlob().getBytes()),
    };
    var res = UrlFetchApp.fetch(APP_URL + "/api/inventory-counts", {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify(payload),
      muteHttpExceptions: true,
    });
    Logger.log(file.getName() + " -> " + res.getResponseCode());
    props.setProperty("sent-" + file.getId(), "1");
  }
}
