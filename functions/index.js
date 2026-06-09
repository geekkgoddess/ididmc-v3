/**
 * ================================================================
 *  I DID MY CHORES — Firebase Cloud Functions
 *  Requires: Firebase Blaze plan (pay-as-you-go)
 *  Install:  npm install firebase-functions firebase-admin nodemailer exif-parser
 * ================================================================
 */

const {onSchedule}        = require("firebase-functions/v2/scheduler");
const {onObjectFinalized} = require("firebase-functions/v2/storage");
const functions           = require("firebase-functions");
const admin               = require("firebase-admin");
const nodemailer          = require("nodemailer");
const crypto              = require("crypto");       // built-in Node.js — no install needed
const ExifParser          = require("exif-parser");  // npm install exif-parser

admin.initializeApp();
const db = admin.firestore();

// ── Email transporter (uses Gmail App Password) ─────────────────
// Set these in Firebase environment:
// firebase functions:config:set gmail.email="you@gmail.com" gmail.password="your_app_password"
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.GMAIL_EMAIL,
    pass: process.env.GMAIL_PASSWORD,
  },
});


// ================================================================
//  STEP 2A — BUG FIX: PHOTO UPLOAD
//  Problem:  Netlify Forms times out on large files, causing a
//            race condition where the Firestore write succeeds but
//            the form response errors, confusing the client.
//  Solution: Upload directly to Firebase Storage, store the
//            download URL in Firestore. No more Netlify form needed.
// ================================================================

/**
 * Cloud Function: generateUploadToken
 * Called by the kid dashboard BEFORE uploading a photo.
 * Returns a signed URL the client uses to upload directly to Storage.
 * This removes Netlify Forms from the photo flow entirely.
 *
 * How it works:
 *   Client → calls this function → gets signed URL
 *   Client → uploads file directly to Storage using signed URL
 *   Client → notifies Firestore with the Storage path
 *   Parent → views photo via Firestore download URL
 */
exports.generateUploadToken = functions.https.onCall(async (data, context) => {
  // data.householdId  — which household is submitting
  // data.kidName      — which kid
  // data.choreId      — which chore
  // data.contentType  — file MIME type (e.g. "image/jpeg")

  const {householdId, kidName, choreId, contentType} = data;

  // Validate inputs — never trust client data
  if (!householdId || !kidName || !choreId || !contentType) {
    throw new functions.https.HttpsError(
        "invalid-argument",
        "Missing required fields.",
    );
  }

  // Only allow image uploads
  if (!contentType.startsWith("image/")) {
    throw new functions.https.HttpsError(
        "invalid-argument",
        "Only image uploads are allowed.",
    );
  }

  // Build a unique storage path for this photo
  // Format: photos/{householdId}/{kidName}/{choreId}/{timestamp}.jpg
  const today = new Date().toISOString().split("T")[0];
  const timestamp = Date.now();
  const filePath = `photos/${householdId}/${kidName}/${choreId}/${today}_${timestamp}`;

  // Create a signed URL valid for 10 minutes
  // The client uploads directly — our server never touches the file bytes
  const bucket = admin.storage().bucket();
  const file = bucket.file(filePath);

  const [signedUrl] = await file.getSignedUrl({
    version: "v4",
    action: "write",
    expires: Date.now() + 10 * 60 * 1000, // 10 minutes
    contentType,
  });

  return {signedUrl, filePath};
});


/**
 * Cloud Function: getPhotoDownloadUrl
 * After a kid uploads a photo, the parent needs a viewable URL.
 * Firebase Storage download URLs don't expire (unlike signed write URLs).
 */
exports.getPhotoDownloadUrl = functions.https.onCall(async (data, context) => {
  const {filePath} = data;
  if (!filePath) {
    throw new functions.https.HttpsError("invalid-argument", "Missing filePath.");
  }
  const bucket = admin.storage().bucket();
  const file = bucket.file(filePath);
  const [url] = await file.getDownloadURL();
  return {downloadUrl: url};
});


// ================================================================
//  STEP 2B — BUG FIX: CHORE CONCURRENCY CONTROL
//  Problem:  Two kids can claim the same shared chore at the same
//            millisecond. Both writes succeed. Both get paid.
//  Solution: Firestore Transaction + status state machine.
//
//  State machine:
//    "available"  →  kid taps claim
//    "pending"    →  kid is filling out form / uploading photo
//    "submitted"  →  photo uploaded, awaiting parent approval
//    "approved"   →  parent approved, balance updated
//    "rejected"   →  parent rejected, chore returns to "available"
// ================================================================

/**
 * Cloud Function: claimChore
 * Called when a kid taps a chore. Uses a Firestore transaction to
 * atomically read the current status AND write the new status.
 * If two kids call this at the same time, only one wins.
 *
 * The transaction guarantees:
 *   1. Read the chore status
 *   2. If still "available", set to "pending" with claimedBy = kidName
 *   3. If already "pending"/"submitted"/"approved", throw an error
 *   All three steps happen atomically — no race condition possible.
 */
exports.claimChore = functions.https.onRequest(async (req, res) => {
  // Enable CORS
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(204).send();
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).send('Method not allowed');
    return;
  }

  const {householdId, choreId, choreType, kidName} = req.body;

  // Build the document path based on whether it's a daily or weekly chore
  const today = new Date().toISOString().split("T")[0];
  const weekStart = getWeekStart();
  const claimDocId = choreType === "daily" ?
    `daily_${householdId}_${today}` :
    `weekly_${householdId}_${weekStart}`;

  const claimRef = db.collection("chore_claims").doc(claimDocId);

  try {
    // runTransaction retries automatically if there's a conflict
    const result = await db.runTransaction(async (transaction) => {
      // Step 1: Read the current state of this chore claim doc
      const claimSnap = await transaction.get(claimRef);
      const existing = claimSnap.exists ? claimSnap.data() : {};

      // Step 2: Check if this specific chore is already claimed
      const choreStatus = existing[`${choreId}_status`];

      if (choreStatus && choreStatus !== "available" && choreStatus !== "rejected") {
        // Someone else already has it — throw so the client gets a clear error
        throw new Error(`CLAIMED_BY:${existing[`${choreId}_claimedBy`]}`);
      }

      // Step 3: Atomically mark as pending with a 15-minute expiry
      // The expiry prevents a stuck "pending" if a kid abandons the form
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 min

      transaction.set(
          claimRef,
          {
            [`${choreId}_status`]: "pending",
            [`${choreId}_claimedBy`]: kidName,
            [`${choreId}_pendingAt`]: admin.firestore.Timestamp.now(),
            [`${choreId}_expiresAt`]: admin.firestore.Timestamp.fromDate(expiresAt),
          },
          {merge: true}, // Don't overwrite other chores in the same doc
      );

      return {success: true, claimedBy: kidName};
    });

    res.json(result);
  } catch (err) {
    if (err.message.startsWith("CLAIMED_BY:")) {
      const claimedBy = err.message.replace("CLAIMED_BY:", "");
      res.status(409).json({error: "already-exists", message: `This chore was just claimed by ${claimedBy}.`});
    } else {
      res.status(500).json({error: "internal", message: err.message});
    }
  }
});


/**
 * Scheduled Function: releaseExpiredClaims
 * Runs every 20 minutes. Finds chores stuck in "pending" longer than
 * 15 minutes (kid abandoned the form) and releases them back to "available".
 *
 * This prevents a chore from being locked forever if a kid backs out.
 */
exports.releaseExpiredClaims = onSchedule("every 20 minutes", async (event) => {
      const now = admin.firestore.Timestamp.now();
      const claimsRef = db.collection("chore_claims");

      // Query all claim docs (they're small, this is fine for this scale)
      const snap = await claimsRef.get();

      const batch = db.batch(); // Batch writes are atomic and efficient
      let releaseCount = 0;

      snap.forEach((doc) => {
        const data = doc.data();
        const updates = {};

        // Check every field that ends in "_status"
        Object.entries(data).forEach(([key, value]) => {
          if (key.endsWith("_status") && value === "pending") {
            const choreId = key.replace("_status", "");
            const expiresAt = data[`${choreId}_expiresAt`];

            // If the pending lock has expired, release it
            if (expiresAt && expiresAt.toMillis() < now.toMillis()) {
              updates[`${choreId}_status`] = "available";
              updates[`${choreId}_claimedBy`] = null;
              updates[`${choreId}_pendingAt`] = null;
              updates[`${choreId}_expiresAt`] = null;
              releaseCount++;
            }
          }
        });

        if (Object.keys(updates).length > 0) {
          batch.update(doc.ref, updates);
        }
      });

      await batch.commit();
      console.log(`Released ${releaseCount} expired chore claims.`);
      return null;
    });


// ================================================================
//  STEP 2C — DAILY SUMMARY EMAIL (10:00 PM cron)
//  Sends one consolidated email per household at 10 PM every day.
//  No more per-submission emails — cleaner for parents and kids.
// ================================================================

/**
 * Scheduled Function: sendDailySummary
 * Runs at 10:00 PM Eastern every day.
 * Loops over all households and sends a summary to each parent.
 *
 * MATH:
 *   completionRate = (choresDone / choresAvailable) * 100
 *   pointsEarned   = sum of pointValue for each approved submission today
 *   dailyTarget    = totalChores / numberOfKids  (the Q formula)
 */
exports.sendDailySummary = onSchedule({schedule:"0 22 * * *",timeZone:"America/New_York"}, async (event) => {
      const today = new Date().toISOString().split("T")[0];

      // Fetch all households
      const householdsSnap = await db.collection("households").get();

      // Process each household independently
      const emailPromises = householdsSnap.docs.map(async (hDoc) => {
        const household = hDoc.data();
        const hId = hDoc.id;

        // Skip households with no email, no kids, or daily summary disabled
        if (!household.ownerEmail || !household.kids?.length) return;
        if ((household.emailSettings || {}).dailySummary === false) return;

        // Fetch today's approved submissions for this household
        const subsSnap = await db.collection("submissions")
            .where("householdId", "==", hId)
            .where("date", "==", today)
            .get();

        const submissions = subsSnap.docs.map((d) => d.data());

        // ── Calculate stats per kid ──────────────────────────────
        // T = total daily chores available
        const T = household.chores?.filter((c) => c.freq === "daily").length || 0;
        // K = number of kids
        const K = household.kids?.length || 1;
        // Q = individual daily quota
        const Q = Math.ceil(T / K);

        // Build per-kid stats
        const kidStats = {};
        household.kids.forEach((kid) => {
          kidStats[kid.name] = {completed: 0, points: 0, chores: []};
        });

        submissions.forEach((sub) => {
          if (sub.status === "approved" && kidStats[sub.kidName]) {
            kidStats[sub.kidName].completed++;
            kidStats[sub.kidName].points += (sub.points || 0);
            kidStats[sub.kidName].chores.push(sub.choreName);
          }
        });

        // ── Build email HTML ─────────────────────────────────────
        const kidRows = Object.entries(kidStats).map(([name, stats]) => {
        // completionPct = (chores done / individual quota) * 100
          const pct = Q > 0 ? Math.min(Math.round((stats.completed / Q) * 100), 100) : 0;
          const barWidth = pct;
          return `
          <tr>
            <td style="padding:12px;border-bottom:1px solid #eee">
              <strong>${name}</strong><br>
              <small>${stats.chores.join(", ") || "No chores completed"}</small>
            </td>
            <td style="padding:12px;border-bottom:1px solid #eee;text-align:center">
              ${stats.completed} / ${Q}
            </td>
            <td style="padding:12px;border-bottom:1px solid #eee;text-align:center">
              <strong style="color:#2B7A78">${stats.points} pts</strong>
            </td>
            <td style="padding:12px;border-bottom:1px solid #eee">
              <div style="background:#eee;border-radius:4px;height:10px;width:100%">
                <div style="background:#2B7A78;height:10px;border-radius:4px;width:${barWidth}%"></div>
              </div>
              <small>${pct}% of daily goal</small>
            </td>
          </tr>`;
        }).join("");

        const totalCompleted = Object.values(kidStats).reduce((s, k) => s + k.completed, 0);
        const totalAvailable = T;

        const html = `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px">
          <h2 style="color:#2B7A78">🧹 I Did My Chores — Daily Summary</h2>
          <p style="color:#666">${household.name} · ${formatDate(today)}</p>

          <div style="background:#f9f7f4;padding:16px;border-radius:8px;margin:20px 0">
            <strong>Household Total:</strong>
            ${totalCompleted} of ${totalAvailable} chores completed today
            (${totalAvailable > 0 ? Math.round((totalCompleted/totalAvailable)*100) : 0}%)
          </div>

          <table style="width:100%;border-collapse:collapse">
            <thead>
              <tr style="background:#2B7A78;color:white">
                <th style="padding:12px;text-align:left">Kid</th>
                <th style="padding:12px">Done / Goal</th>
                <th style="padding:12px">Points</th>
                <th style="padding:12px;text-align:left">Progress</th>
              </tr>
            </thead>
            <tbody>${kidRows}</tbody>
          </table>

          <p style="color:#999;font-size:12px;margin-top:24px">
            — I Did My Chores · A She Got Sheets product by Joanna Hodge
          </p>
        </div>`;

        await transporter.sendMail({
          from: `"I Did My Chores" <${process.env.GMAIL_EMAIL}>`,
          to: household.ownerEmail,
          subject: `🧹 Daily Summary — ${household.name} — ${formatDate(today)}`,
          html,
        });

        // Save summary to Firestore for historical reports
        await db.collection("daily_summaries").doc(`${hId}_${today}`).set({
          householdId: hId,
          date: today,
          kidStats,
          totalCompleted,
          totalAvailable,
          sentAt: admin.firestore.Timestamp.now(),
        });
      });

      await Promise.all(emailPromises);
      console.log(`Daily summaries sent for ${householdsSnap.size} households.`);
      return null;
    });


// ================================================================
//  STEP 2D — WEEKLY PAYDAY SUMMARY (every Sunday 6:00 PM)
//  Sends a 7-day breakdown with point-to-dollar conversion.
//  Formula: payoutAmount = (totalPoints / 100) * dollarMultiplier
//  e.g. 350 points × ($5.00 / 100 pts) = $17.50 payout
// ================================================================

// Runs daily at 6 PM ET — each household picks its own payday via emailSettings.weeklyDay
exports.sendWeeklyPayday = onSchedule({schedule:"0 18 * * *",timeZone:"America/New_York"}, async (event) => {
      // Determine today's day name (lowercase) in Eastern time
      const weekdays = ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"];
      const todayDayName = weekdays[new Date().getDay()];

      const householdsSnap = await db.collection("households").get();

      const emailPromises = householdsSnap.docs.map(async (hDoc) => {
        const household = hDoc.data();
        const hId = hDoc.id;
        const es  = household.emailSettings || {};

        if (!household.ownerEmail || !household.kids?.length) return;
        // Skip if weekly payday emails are disabled
        if (es.weeklySummary === false) return;
        // Skip if today isn't this household's chosen payday (default: friday)
        const payday = es.weeklyDay || "friday";
        if (todayDayName !== payday) return;

        // pointMultiplier: how many dollars per 100 points
        // e.g. household.pointMultiplier = 5 means 100 pts = $5.00
        const multiplier = household.pointMultiplier || 5;

        // Fetch the last 7 daily summaries
        const sevenDaysAgo = new Date();
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
        const sevenDaysAgoStr = sevenDaysAgo.toISOString().split("T")[0];

        const summariesSnap = await db.collection("daily_summaries")
            .where("householdId", "==", hId)
            .where("date", ">=", sevenDaysAgoStr)
            .orderBy("date", "asc")
            .get();

        const summaries = summariesSnap.docs.map((d) => d.data());

        // Aggregate weekly totals per kid
        const weeklyTotals = {};
        household.kids.forEach((kid) => {
          weeklyTotals[kid.name] = {totalPoints: 0, dailyLogs: []};
        });

        summaries.forEach((summary) => {
          Object.entries(summary.kidStats || {}).forEach(([kidName, stats]) => {
            if (weeklyTotals[kidName]) {
              weeklyTotals[kidName].totalPoints += stats.points || 0;
              weeklyTotals[kidName].dailyLogs.push({
                date: summary.date,
                points: stats.points || 0,
                completed: stats.completed || 0,
              });
            }
          });
        });

        // Build payday rows
        // FORMULA: payout = (totalPoints / 100) * multiplier
        const kidPayRows = Object.entries(weeklyTotals).map(([name, data]) => {
          const payout = ((data.totalPoints / 100) * multiplier).toFixed(2);
          const dailyBreakdown = data.dailyLogs.map((log) =>
            `<tr style="font-size:13px">
            <td style="padding:6px 12px;color:#888">${formatDate(log.date)}</td>
            <td style="padding:6px 12px;text-align:center">${log.completed} chores</td>
            <td style="padding:6px 12px;text-align:center">${log.points} pts</td>
          </tr>`,
          ).join("");

          return `
          <div style="background:#f9f7f4;border-radius:12px;padding:20px;margin-bottom:20px">
            <h3 style="margin:0 0 4px;color:#2C2C2C">${name}</h3>
            <p style="margin:0 0 12px;color:#666">Weekly total: <strong>${data.totalPoints} points</strong></p>
            <div style="background:#2B7A78;color:white;padding:12px 16px;border-radius:8px;display:inline-block;margin-bottom:16px">
              💰 Payout: <strong>$${payout}</strong>
              <small style="opacity:.8;margin-left:8px">(${data.totalPoints} pts ÷ 100 × $${multiplier})</small>
            </div>
            <table style="width:100%;border-collapse:collapse">
              <thead><tr style="color:#999;font-size:12px">
                <th style="padding:6px 12px;text-align:left">Date</th>
                <th style="padding:6px 12px">Chores</th>
                <th style="padding:6px 12px">Points</th>
              </tr></thead>
              <tbody>${dailyBreakdown || "<tr><td colspan='3' style='padding:12px;color:#999;text-align:center'>No activity this week</td></tr>"}</tbody>
            </table>
          </div>`;
        }).join("");

        const html = `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px">
          <h2 style="color:#2B7A78">💰 Weekly Payday Summary</h2>
          <p style="color:#666">${household.name} · Week ending ${formatDate(new Date().toISOString().split("T")[0])}</p>
          <p style="color:#888;font-size:13px">Point rate: 100 points = $${multiplier}.00</p>
          ${kidPayRows}
          <p style="color:#999;font-size:12px;margin-top:24px">
            Log in to your parent dashboard to approve payouts.<br>
            — I Did My Chores · A She Got Sheets product
          </p>
        </div>`;

        await transporter.sendMail({
          from: `"I Did My Chores" <${process.env.GMAIL_EMAIL}>`,
          to: household.ownerEmail,
          subject: `💰 Payday Summary — ${household.name}`,
          html,
        });
      });

      await Promise.all(emailPromises);
      return null;
    });


// ================================================================
//  HELPER FUNCTIONS
// ================================================================

function getWeekStart() {
  const d = new Date();
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  return new Date(new Date(d).setDate(diff)).toISOString().split("T")[0];
}

function formatDate(str) {
  const d = new Date(str + "T00:00:00");
  return d.toLocaleDateString("en-US", {weekday: "short", month: "short", day: "numeric"});
}


// ================================================================
//  PHOTO FRAUD DETECTION
//  Triggered every time a file lands in Firebase Storage.
//  Runs two checks on every chore photo:
//
//  1. EXIF date check
//     Reads the photo's DateTimeOriginal EXIF field. If the photo
//     was taken on a PREVIOUS day (not today), it was pre-taken —
//     reject it. Uses today's date from the storage path so the
//     check stays accurate regardless of server timezone drift.
//
//  2. Duplicate hash check
//     Computes a SHA-256 fingerprint of the raw file bytes. If the
//     same fingerprint is already in the `photo_hashes` collection,
//     the kid uploaded the same image twice — reject it.
//
//  On rejection: the submission is marked `rejected_fraud` so the
//  parent sees it flagged in the Approvals tab, and the photo is
//  deleted from Storage to free space.
//  On clean pass: the hash is stored for future dedup checks.
//
//  Storage path format:
//    photos/{householdId}/{kidName}/{choreId}/{YYYY-MM-DD}_{timestamp}.{ext}
// ================================================================

exports.detectPhotoFraud = onObjectFinalized({ bucket: "i-did-my-chores.firebasestorage.app" }, async (event) => {
  const object   = event.data;
  const filePath = object.name; // e.g. "photos/UID/Alex/choreId/2026-06-09_1234567890.jpg"

  // Only process files in the photos/ folder — ignore everything else
  if (!filePath || !filePath.startsWith("photos/")) return null;

  // ── Parse householdId, kidName, uploadDate from the path ────
  // Path format: photos/{householdId}/{kidName}/{choreId}/{date}_{timestamp}.{ext}
  const parts = filePath.split("/");
  if (parts.length < 5) {
    console.warn("Unexpected photo path format, skipping fraud check:", filePath);
    return null;
  }
  const householdId = parts[1];
  const kidName     = parts[2];
  // Extract the date portion from the filename (format: "YYYY-MM-DD_timestamp.ext")
  const filename    = parts[4] || "";
  const uploadDate  = filename.split("_")[0]; // "YYYY-MM-DD"

  if (!uploadDate || !/^\d{4}-\d{2}-\d{2}$/.test(uploadDate)) {
    console.warn("Could not parse upload date from filename, skipping:", filename);
    return null;
  }

  console.log(`Photo fraud check: ${filePath} | uploadDate: ${uploadDate}`);

  // ── Download the file bytes ──────────────────────────────────
  const bucket   = admin.storage().bucket(object.bucket);
  const fileRef  = bucket.file(filePath);
  let fileBuffer;
  try {
    const [contents] = await fileRef.download();
    fileBuffer = contents;
  } catch (err) {
    console.error("Could not download file for fraud check:", err);
    return null;
  }

  // ── Check 1: EXIF date vs upload date ───────────────────────
  // Only JPEG files contain EXIF — skip non-JPEG silently
  let fraudReason = null;
  const contentType = object.contentType || "";
  if (contentType.startsWith("image/jpeg") || contentType.startsWith("image/jpg")) {
    try {
      const parser    = ExifParser.create(fileBuffer);
      const exifData  = parser.parse();
      const dateTime  = exifData.tags?.DateTimeOriginal; // Unix timestamp or undefined

      if (dateTime) {
        // DateTimeOriginal is a Unix timestamp (seconds)
        const photoDate = new Date(dateTime * 1000).toISOString().split("T")[0];

        if (photoDate < uploadDate) {
          // Photo was taken BEFORE today — pre-taken, not a live submission
          fraudReason = `EXIF date mismatch: photo taken ${photoDate}, submitted on ${uploadDate}`;
          console.warn(`FRAUD DETECTED (EXIF): ${filePath} — ${fraudReason}`);
        }
      }
      // If no EXIF date found, give the kid the benefit of the doubt — pass
    } catch (exifErr) {
      // Corrupted or missing EXIF — not conclusive evidence of fraud, continue
      console.log("Could not parse EXIF (not necessarily fraud):", exifErr.message);
    }
  }

  // ── Check 2: Duplicate hash ──────────────────────────────────
  // Compute SHA-256 of the raw bytes. Store / check in photo_hashes collection.
  const hash       = crypto.createHash("sha256").update(fileBuffer).digest("hex");
  const hashDocRef = db.collection("photo_hashes").doc(hash);
  const hashSnap   = await hashDocRef.get();

  if (!fraudReason && hashSnap.exists()) {
    const prior = hashSnap.data();
    fraudReason = `Duplicate photo: already submitted by ${prior.kidName} on ${prior.uploadDate}`;
    console.warn(`FRAUD DETECTED (duplicate hash): ${filePath} — ${fraudReason}`);
  }

  // ── On fraud: flag submission + delete file ──────────────────
  if (fraudReason) {
    // Small delay — the client creates the submission doc AFTER the upload completes,
    // so wait a couple of seconds before querying for it.
    await new Promise(r => setTimeout(r, 3000));

    // Find the matching submission by storage path
    const submQuery = await db.collection("submissions")
      .where("photoStoragePath", "==", filePath)
      .limit(1)
      .get();

    if (!submQuery.empty) {
      const submDoc = submQuery.docs[0];
      await submDoc.ref.update({
        status:      "rejected_fraud",
        fraudReason: fraudReason,
        flaggedAt:   admin.firestore.FieldValue.serverTimestamp(),
      });
      console.log(`Submission ${submDoc.id} marked rejected_fraud`);
    } else {
      console.warn("No matching submission found for fraudulent photo:", filePath);
    }

    // Delete the fraudulent photo from Storage
    try {
      await fileRef.delete();
      console.log("Fraudulent photo deleted:", filePath);
    } catch (delErr) {
      console.error("Could not delete fraudulent photo:", delErr);
    }

    return null;
  }

  // ── On clean: store hash to catch future duplicates ──────────
  await hashDocRef.set({
    filePath:   filePath,
    householdId: householdId,
    kidName:    kidName,
    uploadDate: uploadDate,
    storedAt:   admin.firestore.FieldValue.serverTimestamp(),
  });
  console.log(`Photo passed fraud checks, hash stored: ${hash.slice(0, 12)}…`);
  return null;
});
