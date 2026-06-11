/**
 * ================================================================
 *  I DID MY CHORES — Firebase Cloud Functions
 *  Requires: Firebase Blaze plan (pay-as-you-go)
 *  Install:  npm install firebase-functions firebase-admin nodemailer exif-parser
 * ================================================================
 */

const {onSchedule}          = require("firebase-functions/v2/scheduler");
const {onObjectFinalized}   = require("firebase-functions/v2/storage");
const {onDocumentCreated}   = require("firebase-functions/v2/firestore");
const functions             = require("firebase-functions");
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

  const today = getTodayEt();
  let chore = {id: choreId, freq: choreType === "daily" ? "daily" : "weekly"};
  try {
    const hSnap = await db.collection("households").doc(householdId).get();
    const household = hSnap.exists ? hSnap.data() : {};
    chore = (household.chores || []).find((c) => c.id === choreId) || chore;
  } catch (err) {
    console.warn("Could not load household chore frequency, using request type:", err.message);
  }
  const claimDocId = getClaimDocIdForChore(householdId, chore, today);

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
exports.sendDailySummary = onSchedule({schedule:"0 22 * * *",timeZone:"America/New_York",secrets:["GMAIL_EMAIL","GMAIL_PASSWORD"]}, async (event) => {
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
        const Q = getDailyChoreTarget(household, T, K);

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
          const pct = Q > 0 ? Math.min(Math.round((stats.completed / Q) * 100), 100) : 0;
          const choreLine = stats.chores.length ? stats.chores.join(", ") : "No chores completed today";
          return `
          <tr>
            <td style="padding:14px;border-bottom:1px solid #f0f0f0;vertical-align:top">
              <div style="font-weight:700;font-size:15px;color:#111111">${name}</div>
              <div style="font-size:12px;color:#888888;margin-top:3px">${choreLine}</div>
            </td>
            <td style="padding:14px;border-bottom:1px solid #f0f0f0;text-align:center;vertical-align:middle">
              <span style="font-size:15px;font-weight:700;color:#111111">${stats.completed}</span>
              <span style="color:#aaaaaa;font-weight:400"> / ${Q}</span>
            </td>
            <td style="padding:14px;border-bottom:1px solid #f0f0f0;text-align:center;vertical-align:middle">
              <span style="background:#fef9e7;color:#b38600;font-weight:700;font-size:13px;padding:4px 10px;border-radius:6px">${stats.points} pts</span>
            </td>
            <td style="padding:14px;border-bottom:1px solid #f0f0f0;vertical-align:middle;min-width:90px">
              <div style="background:#eeeeee;border-radius:999px;height:8px;width:100%">
                <div style="background:linear-gradient(90deg,#f5c842,#fb923c);height:8px;border-radius:999px;width:${pct}%"></div>
              </div>
              <div style="font-size:11px;color:#aaaaaa;margin-top:4px">${pct}%</div>
            </td>
          </tr>`;
        }).join("");

        const totalCompleted = Object.values(kidStats).reduce((s, k) => s + k.completed, 0);
        const totalAvailable = T;

        const html = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f0ede8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f0ede8;padding:32px 16px">
<tr><td align="center">
<table cellpadding="0" cellspacing="0" style="width:100%;max-width:600px">

  <!-- Header -->
  <tr>
    <td style="background:#111111;border-radius:14px 14px 0 0;padding:32px 32px 24px;text-align:center">
      <div style="font-size:36px;line-height:1">🧹</div>
      <div style="color:#f5c842;font-size:22px;font-weight:800;letter-spacing:-0.3px;margin-top:10px">I Did My Chores</div>
      <div style="color:#666666;font-size:11px;margin-top:6px;text-transform:uppercase;letter-spacing:2px">Daily Summary</div>
    </td>
  </tr>

  <!-- Body -->
  <tr>
    <td style="background:#ffffff;padding:28px 32px">

      <p style="margin:0 0 22px;font-size:16px;color:#333333">
        <strong style="color:#111111">${household.name}</strong>
        &nbsp;&nbsp;<span style="color:#dddddd">|</span>&nbsp;&nbsp;
        <span style="color:#888888">${formatDate(today)}</span>
      </p>

      <!-- Household total banner -->
      <table width="100%" cellpadding="0" cellspacing="0" style="border-left:4px solid #f5c842;background:#fffdf5;border-radius:0 8px 8px 0;margin-bottom:24px">
        <tr>
          <td style="padding:16px 20px">
            <div style="font-size:11px;color:#aaaaaa;margin-bottom:4px;text-transform:uppercase;letter-spacing:.8px">Household Total</div>
            <div style="font-size:28px;font-weight:800;color:#111111;line-height:1">
              ${totalCompleted}<span style="font-size:15px;color:#aaaaaa;font-weight:400"> of ${totalAvailable} chores completed</span>
            </div>
            <div style="margin-top:10px;background:#e5e5e5;border-radius:999px;height:8px">
              <div style="background:linear-gradient(90deg,#f5c842,#fb923c);height:8px;border-radius:999px;width:${totalAvailable > 0 ? Math.round((totalCompleted/totalAvailable)*100) : 0}%"></div>
            </div>
            <div style="font-size:12px;color:#aaaaaa;margin-top:5px">${totalAvailable > 0 ? Math.round((totalCompleted/totalAvailable)*100) : 0}% complete</div>
          </td>
        </tr>
      </table>

      <!-- Per-kid table -->
      <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">
        <thead>
          <tr style="background:#111111">
            <th style="padding:10px 14px;text-align:left;color:#f5c842;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.8px">Kid</th>
            <th style="padding:10px 14px;text-align:center;color:#f5c842;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.8px">Done</th>
            <th style="padding:10px 14px;text-align:center;color:#f5c842;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.8px">Points</th>
            <th style="padding:10px 14px;text-align:left;color:#f5c842;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.8px">Progress</th>
          </tr>
        </thead>
        <tbody>${kidRows}</tbody>
      </table>

      <!-- CTA -->
      <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:28px">
        <tr>
          <td align="center">
            <a href="https://ididmc.com/app/pages/parent-dashboard.html"
               style="background:#f5c842;color:#111111;text-decoration:none;font-weight:700;font-size:14px;padding:13px 30px;border-radius:10px;display:inline-block;letter-spacing:.2px">
              Open Dashboard &#8594;
            </a>
          </td>
        </tr>
      </table>

    </td>
  </tr>

  <!-- Footer -->
  <tr>
    <td style="background:#f9f9f9;border-top:1px solid #eeeeee;border-radius:0 0 14px 14px;padding:20px 32px;text-align:center">
      <p style="margin:0;font-size:12px;color:#bbbbbb;line-height:1.8">
        I Did My Chores &nbsp;&middot;&nbsp; A She Got Sheets product by Joanna Hodge<br>
        <a href="https://ididmc.com" style="color:#f5c842;text-decoration:none">ididmc.com</a>
      </p>
    </td>
  </tr>

</table>
</td></tr>
</table>
</body>
</html>`;

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
exports.sendWeeklyPayday = onSchedule({schedule:"0 18 * * *",timeZone:"America/New_York",secrets:["GMAIL_EMAIL","GMAIL_PASSWORD"]}, async (event) => {
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
          const dailyBreakdown = data.dailyLogs.length
            ? data.dailyLogs.map((log) =>
                `<tr>
                  <td style="padding:8px 14px;font-size:13px;color:#666666;border-bottom:1px solid #f5f5f5">${formatDate(log.date)}</td>
                  <td style="padding:8px 14px;font-size:13px;color:#666666;text-align:center;border-bottom:1px solid #f5f5f5">${log.completed} chores</td>
                  <td style="padding:8px 14px;font-size:13px;color:#888888;text-align:center;border-bottom:1px solid #f5f5f5">${log.points} pts</td>
                </tr>`
              ).join("")
            : `<tr><td colspan="3" style="padding:14px;font-size:13px;color:#bbbbbb;text-align:center">No activity this week</td></tr>`;

          return `
          <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;border:1px solid #eeeeee;border-radius:10px;overflow:hidden">
            <tr>
              <td style="background:#fffdf5;padding:16px 20px;border-bottom:1px solid #eeeeee;vertical-align:middle">
                <div style="font-size:17px;font-weight:800;color:#111111">${name}</div>
                <div style="font-size:13px;color:#888888;margin-top:3px">${data.totalPoints} points this week</div>
              </td>
              <td style="background:#fffdf5;padding:16px 20px;text-align:right;border-bottom:1px solid #eeeeee;vertical-align:middle;white-space:nowrap">
                <div style="background:#f5c842;color:#111111;font-weight:800;font-size:22px;padding:8px 18px;border-radius:8px;display:inline-block">
                  $${payout}
                </div>
                <div style="font-size:11px;color:#aaaaaa;margin-top:5px">${data.totalPoints} pts &divide; 100 &times; $${multiplier}</div>
              </td>
            </tr>
            <tr>
              <td colspan="2" style="padding:0">
                <table width="100%" cellpadding="0" cellspacing="0">
                  <thead>
                    <tr style="background:#fafafa">
                      <th style="padding:8px 14px;text-align:left;font-size:11px;color:#aaaaaa;text-transform:uppercase;letter-spacing:.5px;font-weight:600;border-bottom:1px solid #f0f0f0">Date</th>
                      <th style="padding:8px 14px;text-align:center;font-size:11px;color:#aaaaaa;text-transform:uppercase;letter-spacing:.5px;font-weight:600;border-bottom:1px solid #f0f0f0">Chores</th>
                      <th style="padding:8px 14px;text-align:center;font-size:11px;color:#aaaaaa;text-transform:uppercase;letter-spacing:.5px;font-weight:600;border-bottom:1px solid #f0f0f0">Points</th>
                    </tr>
                  </thead>
                  <tbody>${dailyBreakdown}</tbody>
                </table>
              </td>
            </tr>
          </table>`;
        }).join("");

        const weekEndStr  = new Date().toISOString().split("T")[0];
        const _weekStart  = new Date(); _weekStart.setDate(_weekStart.getDate() - 6);
        const weekStartStr = _weekStart.toISOString().split("T")[0];

        const html = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f0ede8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f0ede8;padding:32px 16px">
<tr><td align="center">
<table cellpadding="0" cellspacing="0" style="width:100%;max-width:600px">

  <!-- Header -->
  <tr>
    <td style="background:#111111;border-radius:14px 14px 0 0;padding:32px 32px 24px;text-align:center">
      <div style="font-size:36px;line-height:1">💰</div>
      <div style="color:#f5c842;font-size:22px;font-weight:800;letter-spacing:-0.3px;margin-top:10px">I Did My Chores</div>
      <div style="color:#666666;font-size:11px;margin-top:6px;text-transform:uppercase;letter-spacing:2px">Payday Summary</div>
    </td>
  </tr>

  <!-- Body -->
  <tr>
    <td style="background:#ffffff;padding:28px 32px">

      <p style="margin:0 0 4px;font-size:16px;color:#333333">
        <strong style="color:#111111">${household.name}</strong>
      </p>
      <p style="margin:0 0 24px;font-size:13px;color:#999999">
        ${formatDate(weekStartStr)} &ndash; ${formatDate(weekEndStr)}
        &nbsp;&middot;&nbsp; 100 pts = $${multiplier}.00
      </p>

      ${kidPayRows}

      <!-- CTA -->
      <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:8px">
        <tr>
          <td align="center">
            <a href="https://ididmc.com/app/pages/parent-dashboard.html"
               style="background:#f5c842;color:#111111;text-decoration:none;font-weight:700;font-size:14px;padding:13px 30px;border-radius:10px;display:inline-block;letter-spacing:.2px">
              Review &amp; Approve Payouts &#8594;
            </a>
          </td>
        </tr>
      </table>

    </td>
  </tr>

  <!-- Footer -->
  <tr>
    <td style="background:#f9f9f9;border-top:1px solid #eeeeee;border-radius:0 0 14px 14px;padding:20px 32px;text-align:center">
      <p style="margin:0;font-size:12px;color:#bbbbbb;line-height:1.8">
        I Did My Chores &nbsp;&middot;&nbsp; A She Got Sheets product by Joanna Hodge<br>
        <a href="https://ididmc.com" style="color:#f5c842;text-decoration:none">ididmc.com</a>
      </p>
    </td>
  </tr>

</table>
</td></tr>
</table>
</body>
</html>`;

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
//  KID LITE API
//  Plain HTTP endpoints for the fallback kid dashboard. These avoid
//  the Firebase browser SDK on older iOS/iPadOS devices.
// ================================================================

exports.getKidLiteDashboard = functions.https.onRequest(async (req, res) => {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).send("");
  if (req.method !== "POST") return res.status(405).json({error: "method-not-allowed"});

  try {
    const {householdId, kidName, pin} = req.body || {};
    if (!householdId) return res.status(400).json({error: "missing-household"});

    const hSnap = await db.collection("households").doc(householdId).get();
    if (!hSnap.exists) return res.status(404).json({error: "household-not-found"});

    const household = hSnap.data();
    const kids = (household.kids || []).map((kid) => ({
      name: kid.name,
      color: kid.color || "#f5c842",
    }));

    if (!kidName || !pin) {
      return res.json({
        householdName: household.name || "I Did My Chores",
        kids,
      });
    }

    const kid = (household.kids || []).find((k) => k.name === kidName);
    if (!kid || String(kid.pin) !== String(pin)) {
      return res.status(403).json({error: "bad-pin"});
    }

    const today = getTodayEt();
    const payPeriod = getPayPeriodForHousehold(household, today);
    const visibleChores = (household.chores || [])
      .filter((chore) => chore && (chore.assignedTo === "any" || chore.assignedTo === kidName))
      .map((chore) => sanitizeChore(chore));
    const claimDocIds = [...new Set(visibleChores.map((chore) =>
      getClaimDocIdForChore(householdId, chore, today)
    ))];
    const [claimSnaps, subsSnap] = await Promise.all([
      Promise.all(claimDocIds.map((id) => db.collection("chore_claims").doc(id).get())),
      db.collection("submissions")
        .where("householdId", "==", householdId)
        .where("kidName", "==", kidName)
        .where("payPeriod", "==", payPeriod)
        .where("status", "in", ["approved", "pending"])
        .get(),
    ]);

    const dailyClaimed = {};
    const weeklyClaimed = {};
    claimSnaps.forEach((snap) => {
      if (!snap.exists) return;
      const data = snap.data();
      if (snap.id.startsWith("daily_")) {
        Object.assign(dailyClaimed, data);
      } else {
        Object.assign(weeklyClaimed, data);
      }
    });
    const submissions = subsSnap.docs.map((d) => ({id: d.id, ...d.data()}));
    const stats = calculateKidStats(submissions, today);

    res.json({
      householdName: household.name || "I Did My Chores",
      kid: {name: kid.name, color: kid.color || "#f5c842"},
      kids,
      today,
      weekStart: getWeekStartForDate(today),
      payPeriod,
      compModel: household.compModel || "points",
      compSettings: household.compSettings || {},
      approvalMode: household.approvalMode || "manual",
      pointMultiplier: household.pointMultiplier || 5,
      ptoToday: ((household.ptoSchedule || {})[kidName] || []).includes(today),
      chores: visibleChores,
      dailyClaimed,
      weeklyClaimed,
      stats,
      recentSubmissions: submissions
        .sort((a, b) => String(b.timestamp || "").localeCompare(String(a.timestamp || "")))
        .slice(0, 20)
        .map((s) => ({
          id: s.id,
          choreName: s.choreName || "Chore",
          date: s.date || "",
          status: s.status || "pending",
          points: s.points || 0,
          bonusPoints: s.bonusPoints || 0,
          flatPayValue: s.flatPayValue || 0,
          timestamp: s.timestamp || "",
        })),
    });
  } catch (err) {
    console.error("getKidLiteDashboard error:", err);
    res.status(500).json({error: "internal", message: err.message});
  }
});

exports.submitKidLiteChore = functions.https.onRequest(async (req, res) => {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).send("");
  if (req.method !== "POST") return res.status(405).json({error: "method-not-allowed"});

  try {
    const {
      householdId,
      kidName,
      pin,
      choreId,
      choreType,
      completedSubTasks,
      photoDataUrl,
    } = req.body || {};

    if (!householdId || !kidName || !pin || !choreId || !photoDataUrl) {
      return res.status(400).json({error: "missing-fields"});
    }

    const hRef = db.collection("households").doc(householdId);
    const hSnap = await hRef.get();
    if (!hSnap.exists) return res.status(404).json({error: "household-not-found"});

    const household = hSnap.data();
    const kid = (household.kids || []).find((k) => k.name === kidName);
    if (!kid || String(kid.pin) !== String(pin)) {
      return res.status(403).json({error: "bad-pin"});
    }

    const chore = (household.chores || []).find((c) => c.id === choreId);
    if (!chore) return res.status(404).json({error: "chore-not-found"});
    if (chore.assignedTo !== "any" && chore.assignedTo !== kidName) {
      return res.status(403).json({error: "not-assigned"});
    }

    const today = getTodayEt();
    const payPeriod = getPayPeriodForHousehold(household, today);
    const type = chore.freq || (choreType === "daily" ? "daily" : "weekly");
    const weekStart = getWeekStartForDate(today);
    const claimDocId = getClaimDocIdForChore(householdId, chore, today);
    const claimRef = db.collection("chore_claims").doc(claimDocId);

    await db.runTransaction(async (transaction) => {
      const claimSnap = await transaction.get(claimRef);
      const existing = claimSnap.exists ? claimSnap.data() : {};
      const status = existing[`${choreId}_status`];
      const claimedBy = existing[`${choreId}_claimedBy`];
      if (status && status !== "available" && status !== "rejected" && claimedBy !== kidName) {
        throw new Error(`CLAIMED_BY:${claimedBy || "someone else"}`);
      }
      if (status === "submitted" || status === "approved") {
        throw new Error("ALREADY_SUBMITTED");
      }
      transaction.set(claimRef, {
        [`${choreId}_status`]: "pending",
        [`${choreId}_claimedBy`]: kidName,
        [`${choreId}_pendingAt`]: admin.firestore.Timestamp.now(),
      }, {merge: true});
    });

    const photo = parsePhotoDataUrl(photoDataUrl);
    if (!photo.contentType.startsWith("image/")) {
      return res.status(400).json({error: "photo-type"});
    }
    if (photo.buffer.length > 6 * 1024 * 1024) {
      return res.status(400).json({error: "photo-too-large"});
    }

    const ext = photo.contentType.includes("png") ? "png" : "jpg";
    const timestamp = Date.now();
    const storagePath = `photos/${householdId}/${kidName}/${choreId}/${today}_${timestamp}.${ext}`;
    const token = crypto.randomUUID();
    const bucket = admin.storage().bucket();
    await bucket.file(storagePath).save(photo.buffer, {
      metadata: {
        contentType: photo.contentType,
        metadata: {
          firebaseStorageDownloadTokens: token,
        },
      },
    });

    const photoDownloadUrl =
      `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/` +
      `${encodeURIComponent(storagePath)}?alt=media&token=${token}`;
    const status = (household.approvalMode === "automatic" || household.approvalMode === "auto") ? "approved" : "pending";

    await db.collection("submissions").add({
      householdId,
      kidName,
      choreId,
      choreName: chore.name,
      points: chore.pointValue || 0,
      bonusPoints: 0,
      freq: type,
      status,
      exceeded: false,
      bonusAmount: 0,
      flatPayValue: chore.flatPayValue || 0,
      photoStoragePath: storagePath,
      photoDownloadUrl,
      completedSubTasks: Array.isArray(completedSubTasks) ? completedSubTasks : [],
      date: today,
      weekStart,
      payPeriod,
      timestamp: new Date().toISOString(),
      source: "kid-lite",
    });

    await claimRef.set({
      [`${choreId}_status`]: "submitted",
      [`${choreId}_claimedBy`]: kidName,
      [`${choreId}_submittedAt`]: admin.firestore.Timestamp.now(),
    }, {merge: true});

    res.json({
      success: true,
      status,
      points: chore.pointValue || 0,
      flatPayValue: chore.flatPayValue || 0,
      choreName: chore.name,
    });
  } catch (err) {
    console.error("submitKidLiteChore error:", err);
    if (err.message && err.message.startsWith("CLAIMED_BY:")) {
      return res.status(409).json({
        error: "already-claimed",
        message: `This chore was already claimed by ${err.message.replace("CLAIMED_BY:", "")}.`,
      });
    }
    if (err.message === "ALREADY_SUBMITTED") {
      return res.status(409).json({error: "already-submitted", message: "This chore was already submitted."});
    }
    res.status(500).json({error: "internal", message: err.message});
  }
});


// ================================================================
//  HELPER FUNCTIONS
// ================================================================

function setCors(res) {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");
}

function getTodayEt() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + days);
  return d.toISOString().split("T")[0];
}

function getWeekStartForDate(dateStr) {
  const d = new Date(`${dateStr}T00:00:00`);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  return new Date(new Date(d).setDate(diff)).toISOString().split("T")[0];
}

function getClaimDocIdForChore(householdId, chore, todayStr) {
  const freq = (chore.freq || "daily").replace("_", "-");
  if (freq === "daily") return `daily_${householdId}_${todayStr}`;
  if (freq === "weekly") return `weekly_${householdId}_${getWeekStartForDate(todayStr)}`;
  if (freq === "biweekly") return `biweekly_${householdId}_${getRollingPeriodStart(todayStr, 14)}`;
  if (freq === "monthly") return `monthly_${householdId}_${todayStr.slice(0, 8)}01`;
  if (freq === "quarterly") {
    const month = Number(todayStr.slice(5, 7));
    const quarterStartMonth = String(Math.floor((month - 1) / 3) * 3 + 1).padStart(2, "0");
    return `quarterly_${householdId}_${todayStr.slice(0, 5)}${quarterStartMonth}-01`;
  }
  if (freq === "biannual") {
    const month = Number(todayStr.slice(5, 7));
    const halfStartMonth = month <= 6 ? "01" : "07";
    return `biannual_${householdId}_${todayStr.slice(0, 5)}${halfStartMonth}-01`;
  }
  if (freq === "annual") return `annual_${householdId}_${todayStr.slice(0, 4)}-01-01`;
  return `weekly_${householdId}_${getWeekStartForDate(todayStr)}`;
}

function getRollingPeriodStart(todayStr, days) {
  const anchorStr = "2026-01-05"; // Monday anchor for stable biweekly buckets.
  const anchor = new Date(`${anchorStr}T00:00:00`);
  const today = new Date(`${todayStr}T00:00:00`);
  const diff = Math.floor((today - anchor) / 86400000);
  const num = Math.floor(Math.max(diff, 0) / days);
  return addDays(anchorStr, num * days);
}

function getPayPeriodForHousehold(household, todayStr) {
  const freq = household.payCycle || household.payFrequency || "weekly";
  if (freq === "monthly") return todayStr.slice(0, 8) + "01";
  if (freq === "semimonthly") {
    return `${todayStr.slice(0, 8)}${Number(todayStr.slice(8, 10)) <= 15 ? "01" : "16"}`;
  }
  if (freq === "asneeded") {
    return household.currentPeriodStart || household.payPeriodStart || todayStr;
  }
  const days = freq === "biweekly" ? 14 : 7;
  const startStr = household.payPeriodStart || todayStr;
  const start = new Date(`${startStr}T00:00:00`);
  const today = new Date(`${todayStr}T00:00:00`);
  const diff = Math.floor((today - start) / 86400000);
  const num = Math.floor(Math.max(diff, 0) / days);
  return addDays(startStr, num * days);
}

function calculateKidStats(submissions, today) {
  const stats = {
    pointsToday: 0,
    pointsPeriod: 0,
    flatToday: 0,
    flatPeriod: 0,
    dailyDoneCount: 0,
  };
  submissions.forEach((s) => {
    const pts = (s.points || 0) + (s.bonusPoints || 0);
    const flat = s.flatPayValue || 0;
    stats.pointsPeriod += pts;
    stats.flatPeriod += flat;
    if (s.date === today) {
      stats.pointsToday += pts;
      stats.flatToday += flat;
      stats.dailyDoneCount++;
    }
  });
  return stats;
}

function getDailyChoreTarget(household, totalDailyChores, kidCount) {
  const cs = household.compSettings || {};
  const configured = cs.choreMinForFullDay || cs.choreMin || cs.dailyChoreTarget;
  if (configured && configured > 0) return configured;
  return Math.ceil((totalDailyChores || 0) / (kidCount || 1));
}

function sanitizeChore(chore) {
  return {
    id: chore.id,
    name: chore.name || "Chore",
    desc: chore.desc || "",
    freq: chore.freq || "daily",
    assignedTo: chore.assignedTo || "any",
    pointValue: chore.pointValue || 0,
    flatPayValue: chore.flatPayValue || 0,
    subTasks: Array.isArray(chore.subTasks) ? chore.subTasks.map((task) => ({
      id: task.id,
      label: task.label || "",
      order: task.order || 0,
    })) : [],
  };
}

function parsePhotoDataUrl(dataUrl) {
  const match = String(dataUrl).match(/^data:([^;]+);base64,(.+)$/);
  if (!match) throw new Error("Invalid photo data.");
  return {
    contentType: match[1],
    buffer: Buffer.from(match[2], "base64"),
  };
}

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


// ================================================================
//  EMAIL #7 — WELCOME EMAIL
//  Triggered: call sendWelcomeEmail({ email, householdName }) from
//  your onboarding Cloud Function or via a Firestore onCreate trigger
//  on the households collection.
// ================================================================
async function sendWelcomeEmail({ email, householdName }) {
  const year = new Date().getFullYear();
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Welcome to I Did My Chores!</title>
</head>
<body style="margin:0;padding:0;background:#111111;font-family:'Helvetica Neue',Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#111111">
  <tr>
    <td align="center" style="padding:32px 16px 0">

      <!-- Card -->
      <table width="600" cellpadding="0" cellspacing="0" border="0"
             style="max-width:600px;background:#1a1a1a;border-radius:16px;overflow:hidden">

        <!-- Header gradient bar -->
        <tr>
          <td height="5" style="background:linear-gradient(90deg,#f5c842,#fb923c);font-size:0;line-height:0">&nbsp;</td>
        </tr>

        <!-- Hero -->
        <tr>
          <td align="center" style="padding:40px 40px 32px;background:#1a1a1a">
            <div style="font-size:36px;margin-bottom:8px">🧹</div>
            <h1 style="margin:0 0 8px;font-size:26px;font-weight:800;color:#f0ede8;letter-spacing:-0.3px">
              Welcome to I Did My Chores!
            </h1>
            <p style="margin:0;font-size:15px;color:#9ca3af;line-height:1.5">
              You're all set, ${householdName || 'your household'} — let's make chore day pay day.
            </p>
          </td>
        </tr>

        <!-- Divider -->
        <tr><td style="padding:0 40px"><div style="height:1px;background:#2a2a2a"></div></td></tr>

        <!-- Three steps -->
        <tr>
          <td style="padding:32px 40px">
            <p style="margin:0 0 20px;font-size:13px;font-weight:700;color:#f5c842;
                       letter-spacing:0.08em;text-transform:uppercase">Get started in 3 steps</p>

            <!-- Step 1 -->
            <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:20px">
              <tr>
                <td width="40" valign="top" style="padding-top:2px">
                  <div style="width:32px;height:32px;border-radius:50%;
                               background:linear-gradient(135deg,#f5c842,#fb923c);
                               color:#000;font-size:14px;font-weight:800;
                               text-align:center;line-height:32px">1</div>
                </td>
                <td style="padding-left:12px">
                  <div style="font-size:14px;font-weight:700;color:#f0ede8;margin-bottom:4px">Add your kids</div>
                  <div style="font-size:13px;color:#9ca3af;line-height:1.5">
                    Each kid gets a name, a color, and a 4-digit PIN so they can log in from any device.
                  </div>
                </td>
              </tr>
            </table>

            <!-- Step 2 -->
            <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:20px">
              <tr>
                <td width="40" valign="top" style="padding-top:2px">
                  <div style="width:32px;height:32px;border-radius:50%;
                               background:linear-gradient(135deg,#f5c842,#fb923c);
                               color:#000;font-size:14px;font-weight:800;
                               text-align:center;line-height:32px">2</div>
                </td>
                <td style="padding-left:12px">
                  <div style="font-size:14px;font-weight:700;color:#f0ede8;margin-bottom:4px">Create chores</div>
                  <div style="font-size:13px;color:#9ca3af;line-height:1.5">
                    Assign point values or flat pay — mix and match however works for your family.
                  </div>
                </td>
              </tr>
            </table>

            <!-- Step 3 -->
            <table width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td width="40" valign="top" style="padding-top:2px">
                  <div style="width:32px;height:32px;border-radius:50%;
                               background:linear-gradient(135deg,#f5c842,#fb923c);
                               color:#000;font-size:14px;font-weight:800;
                               text-align:center;line-height:32px">3</div>
                </td>
                <td style="padding-left:12px">
                  <div style="font-size:14px;font-weight:700;color:#f0ede8;margin-bottom:4px">Share the kid link</div>
                  <div style="font-size:13px;color:#9ca3af;line-height:1.5">
                    Send your kids the household link from Settings → Share with Kids. They log in with their PIN and start earning.
                  </div>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- CTA -->
        <tr>
          <td align="center" style="padding:0 40px 40px">
            <a href="https://ididmc.com/app/pages/parent-dashboard.html"
               style="display:inline-block;background:linear-gradient(90deg,#f5c842,#fb923c);
                      color:#000;font-size:15px;font-weight:800;text-decoration:none;
                      padding:14px 32px;border-radius:10px;letter-spacing:-0.2px">
              Open My Dashboard →
            </a>
          </td>
        </tr>

        <!-- Footer gradient bar -->
        <tr>
          <td height="4" style="background:linear-gradient(90deg,#f5c842,#fb923c);font-size:0;line-height:0">&nbsp;</td>
        </tr>

        <!-- Footer text -->
        <tr>
          <td align="center" style="padding:24px 40px;background:#111111">
            <p style="margin:0 0 6px;font-size:12px;color:#6b7280">
              You're receiving this because you created an account at
              <a href="https://ididmc.com" style="color:#f5c842;text-decoration:none">ididmc.com</a>.
            </p>
            <p style="margin:0;font-size:12px;color:#6b7280">
              © ${year} I Did My Chores. All rights reserved.
            </p>
          </td>
        </tr>

      </table>
    </td>
  </tr>
</table>
</body>
</html>`;

  await transporter.sendMail({
    from:    `"I Did My Chores" <${process.env.GMAIL_EMAIL}>`,
    to:      email,
    subject: "Welcome to I Did My Chores! 🧹",
    html,
  });
  console.log(`Welcome email sent to ${email}`);
}

// ── Cloud Function trigger: fires when a new household is created ─
// Requires onboarding to write onboardingComplete: true at save time.
exports.onHouseholdCreated = onDocumentCreated('households/{uid}', async (event) => {
  const uid  = event.params.uid;
  const data = event.data.data();
  if (!data.onboardingComplete) return null;   // skip partial / in-progress documents
  try {
    const userRecord = await admin.auth().getUser(uid);
    if (userRecord.email) {
      await sendWelcomeEmail({ email: userRecord.email, householdName: data.name });
    }
  } catch (e) {
    console.error('Welcome email trigger error:', e);
  }
  return null;
});


// ================================================================
//  EMAIL #8 — SUBSCRIBER / NEWSLETTER EMAIL
//  Firestore trigger: write a document to subscribers/{email}
//  with optional field { firstName: "..." } to fire this email.
// ================================================================
async function sendSubscriberEmail({ email, firstName }) {
  const year = new Date().getFullYear();
  const greeting = firstName ? `Hey ${firstName}!` : "Hey there!";
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>You're on the list!</title>
</head>
<body style="margin:0;padding:0;background:#111111;font-family:'Helvetica Neue',Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#111111">
  <tr>
    <td align="center" style="padding:32px 16px 0">

      <!-- Card -->
      <table width="600" cellpadding="0" cellspacing="0" border="0"
             style="max-width:600px;background:#1a1a1a;border-radius:16px;overflow:hidden">

        <!-- Header gradient bar -->
        <tr>
          <td height="5" style="background:linear-gradient(90deg,#f5c842,#fb923c);font-size:0;line-height:0">&nbsp;</td>
        </tr>

        <!-- Hero -->
        <tr>
          <td align="center" style="padding:40px 40px 28px;background:#1a1a1a">
            <div style="font-size:36px;margin-bottom:8px">✉️</div>
            <h1 style="margin:0 0 8px;font-size:26px;font-weight:800;color:#f0ede8;letter-spacing:-0.3px">
              You're on the list!
            </h1>
            <p style="margin:0;font-size:15px;color:#9ca3af;line-height:1.5">
              ${greeting} Thanks for subscribing to I Did My Chores updates.
            </p>
          </td>
        </tr>

        <!-- Divider -->
        <tr><td style="padding:0 40px"><div style="height:1px;background:#2a2a2a"></div></td></tr>

        <!-- What to expect -->
        <tr>
          <td style="padding:32px 40px">
            <p style="margin:0 0 16px;font-size:13px;font-weight:700;color:#f5c842;
                       letter-spacing:0.08em;text-transform:uppercase">What you'll get</p>

            <table width="100%" cellpadding="0" cellspacing="0" border="0">
              <!-- Row 1 -->
              <tr>
                <td width="36" valign="top" align="center" style="padding-bottom:16px">
                  <span style="font-size:20px">🚀</span>
                </td>
                <td style="padding-left:12px;padding-bottom:16px">
                  <div style="font-size:14px;font-weight:700;color:#f0ede8;margin-bottom:2px">Early access to new features</div>
                  <div style="font-size:13px;color:#9ca3af">Be the first to try new chore types, reward systems, and automations.</div>
                </td>
              </tr>
              <!-- Row 2 -->
              <tr>
                <td width="36" valign="top" align="center" style="padding-bottom:16px">
                  <span style="font-size:20px">💡</span>
                </td>
                <td style="padding-left:12px;padding-bottom:16px">
                  <div style="font-size:14px;font-weight:700;color:#f0ede8;margin-bottom:2px">Tips for busy families</div>
                  <div style="font-size:13px;color:#9ca3af">Practical ideas for building chore habits that actually stick.</div>
                </td>
              </tr>
              <!-- Row 3 -->
              <tr>
                <td width="36" valign="top" align="center">
                  <span style="font-size:20px">🎉</span>
                </td>
                <td style="padding-left:12px">
                  <div style="font-size:14px;font-weight:700;color:#f0ede8;margin-bottom:2px">No spam — ever</div>
                  <div style="font-size:13px;color:#9ca3af">We only send emails worth reading. Unsubscribe any time, no questions asked.</div>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- CTA -->
        <tr>
          <td align="center" style="padding:0 40px 40px">
            <p style="margin:0 0 20px;font-size:14px;color:#9ca3af;line-height:1.6;text-align:center">
              Ready to put chores on autopilot? Create a free account and your kids can start earning today.
            </p>
            <a href="https://ididmc.com/login.html?signup=true"
               style="display:inline-block;background:linear-gradient(90deg,#f5c842,#fb923c);
                      color:#000;font-size:15px;font-weight:800;text-decoration:none;
                      padding:14px 32px;border-radius:10px;letter-spacing:-0.2px">
              Create Free Account →
            </a>
          </td>
        </tr>

        <!-- Footer gradient bar -->
        <tr>
          <td height="4" style="background:linear-gradient(90deg,#f5c842,#fb923c);font-size:0;line-height:0">&nbsp;</td>
        </tr>

        <!-- Footer text -->
        <tr>
          <td align="center" style="padding:24px 40px;background:#111111">
            <p style="margin:0 0 6px;font-size:12px;color:#6b7280">
              You subscribed at
              <a href="https://ididmc.com" style="color:#f5c842;text-decoration:none">ididmc.com</a>.
            </p>
            <p style="margin:0;font-size:12px;color:#6b7280">
              © ${year} I Did My Chores ·
              <a href="https://ididmc.com/unsubscribe" style="color:#6b7280;text-decoration:underline">Unsubscribe</a>
            </p>
          </td>
        </tr>

      </table>
    </td>
  </tr>
</table>
</body>
</html>`;

  await transporter.sendMail({
    from:    `"I Did My Chores" <${process.env.GMAIL_EMAIL}>`,
    to:      email,
    subject: "You're on the list! ✉️",
    html,
  });
  console.log(`Subscriber email sent to ${email}`);
}

// ── Cloud Function trigger: fires when a new subscriber document is created ─
// Write { firstName: "..." } to subscribers/{email} to trigger this.
exports.onSubscriberCreated = onDocumentCreated('subscribers/{email}', async (event) => {
  const email     = event.params.email;
  const firstName = (event.data.data() || {}).firstName || '';
  try {
    await sendSubscriberEmail({ email, firstName });
  } catch (e) {
    console.error('Subscriber email trigger error:', e);
  }
  return null;
});
