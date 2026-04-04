/**
 * Callable (Cloud Functions gen 1): hapus pengguna Auth + dokumen users/{uid}.
 * Gen 1 menghindari Artifact Registry yang wajib Blaze pada gen 2 — cocok untuk proyek Spark jika masih didukung.
 */
const functions = require("firebase-functions/v1");
const admin = require("firebase-admin");

admin.initializeApp();

/** Samakan dengan UI: role bisa "admin", "Admin", atau spasi. */
function normalizeRole(value) {
  if (value == null) return "";
  return String(value).toLowerCase().trim();
}

/** Admin jika: field Firestore role = admin, atau custom claim admin/token.role (opsional). */
function callerIsAdmin(callerSnap, token) {
  if (token && token.admin === true) return true;
  const claimRole = token && token.role != null ? normalizeRole(token.role) : "";
  if (claimRole === "admin") return true;
  if (!callerSnap.exists) return false;
  const data = callerSnap.data();
  const fromDoc = normalizeRole(data.role ?? data.Role);
  return fromDoc === "admin";
}

exports.deleteAuthUser = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "Anda harus login.");
  }

  const callerUid = context.auth.uid;
  const targetUid = data && data.uid;
  const token = context.auth.token || {};

  if (!targetUid || typeof targetUid !== "string") {
    throw new functions.https.HttpsError("invalid-argument", "Parameter uid tidak valid.");
  }

  if (targetUid === callerUid) {
    throw new functions.https.HttpsError(
      "failed-precondition",
      "Tidak dapat menghapus akun Anda sendiri dari sini."
    );
  }

  const db = admin.firestore();
  const auth = admin.auth();

  const callerSnap = await db.doc(`users/${callerUid}`).get();

  if (!callerIsAdmin(callerSnap, token)) {
    if (!callerSnap.exists) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "Tidak ada dokumen Firestore users/" +
          callerUid +
          " (ID dokumen harus sama dengan UID di Authentication). " +
          "Tanpa dokumen ini server tidak bisa memverifikasi admin. Buat dokumen dengan field role: \"admin\"."
      );
    }
    const snapData = callerSnap.data();
    const raw = snapData.role ?? snapData.Role;
    throw new functions.https.HttpsError(
      "permission-denied",
      `Server membaca role Anda sebagai "${raw == null ? "(kosong)" : String(raw)}". ` +
        'Gunakan nama field "role" (huruf kecil) berisi teks admin di users/' +
        callerUid +
        ", lalu logout dan login lagi."
    );
  }

  const targetSnap = await db.doc(`users/${targetUid}`).get();

  if (!targetSnap.exists) {
    try {
      await auth.deleteUser(targetUid);
      return { ok: true, note: "auth-only" };
    } catch (e) {
      if (e.code === "auth/user-not-found") {
        throw new functions.https.HttpsError("not-found", "Pengguna tidak ditemukan.");
      }
      throw new functions.https.HttpsError("internal", e.message || "Gagal menghapus akun.");
    }
  }

  try {
    await auth.deleteUser(targetUid);
  } catch (e) {
    if (e.code !== "auth/user-not-found") {
      throw new functions.https.HttpsError("internal", e.message || "Gagal menghapus akun login.");
    }
  }

  await db.doc(`users/${targetUid}`).delete();
  return { ok: true };
});
