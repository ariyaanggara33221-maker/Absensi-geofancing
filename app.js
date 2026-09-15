/**
 * app.js — AbsensiGeo Telkomsat Regional 6
 * Firebase Auth + Firestore + Geofencing (Haversine)
 */
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-app.js";
import {
  getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged,
  createUserWithEmailAndPassword,
  reauthenticateWithCredential,
  EmailAuthProvider,
  updatePassword,
  sendPasswordResetEmail
} from "https://www.gstatic.com/firebasejs/10.9.0/firebase-auth.js";
import {
  getFirestore, collection, addDoc, getDocs, doc, getDoc, setDoc,
  deleteDoc, query, orderBy, where, serverTimestamp, limit, writeBatch
} from "https://www.gstatic.com/firebasejs/10.9.0/firebase-firestore.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-functions.js";

// ═══════════════════════════════════════════════
// 1. FIREBASE CONFIG  (dari .env via Vite)
// ═══════════════════════════════════════════════
const firebaseConfig = {
  apiKey:            import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain:        import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId:         import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket:     import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId:             import.meta.env.VITE_FIREBASE_APP_ID,
};

const app       = initializeApp(firebaseConfig);
const auth      = getAuth(app);
const db        = getFirestore(app);
const functions = getFunctions(app);

// ═══════════════════════════════════════════════
// 2. KONFIGURASI GEOFENCING  ← dimuat dari Firestore
// ═══════════════════════════════════════════════
// Default fallback (akan ditimpa data dari Firestore)
let OFFICE = { lat: 3.636487, lng: 98.778440, name: "Telkomsat Regional 6" };
let RADIUS_M = 100;
let WORK_START = "08:00";
let WORK_END = "17:00";
let LATE_GRACE_MIN = 15;

// Muat konfigurasi kantor dari Firestore
async function loadOfficeConfig() {
  try {
    const snap = await getDoc(doc(db, "settings", "geofence"));
    if (snap.exists()) {
      const d = snap.data();
      OFFICE   = { lat: d.lat, lng: d.lng, name: d.name || "Telkomsat Regional 6" };
      RADIUS_M = d.radius || 100;
      if (d.workStart)  WORK_START = String(d.workStart).slice(0, 5);
      if (d.workEnd)    WORK_END = String(d.workEnd).slice(0, 5);
      if (typeof d.lateGraceMinutes === "number" && d.lateGraceMinutes >= 0) {
        LATE_GRACE_MIN = d.lateGraceMinutes;
      }
    }
  } catch (e) {
    console.warn("loadOfficeConfig: Menggunakan default. Error:", e.message);
  }
}

// ═══════════════════════════════════════════════
// 3. STATE
// ═══════════════════════════════════════════════
let currentUser   = null;
let currentRole   = null;
let currentProfile= null;
let userLatLng    = null;
let currentDist   = null;
let map           = null;
let officeMarker  = null;
let userMarker    = null;
let geoCircle     = null;
let todayAttendance = {
  hasCheckedIn: false,
  hasCheckedOut: false,
  checkInTime: null,
  checkOutTime: null,
  checkInStatus: null,
};

// ═══════════════════════════════════════════════
// 4. HELPERS
// ═══════════════════════════════════════════════
function showToast(msg, type = "success") {
  const c = document.getElementById("toastContainer");
  const t = document.createElement("div");
  const icons = { success: "fa-circle-check", error: "fa-circle-xmark", warning: "fa-triangle-exclamation" };
  t.className = `toast ${type}`;
  t.innerHTML = `<i class="fas ${icons[type]||"fa-info-circle"} toast-icon"></i><span>${msg}</span>`;
  c.appendChild(t);
  setTimeout(() => { t.classList.add("toast-out"); setTimeout(() => t.remove(), 350); }, 4000);
}

function showLoader() { document.getElementById("globalLoader").classList.remove("hide"); }
function hideLoader() { document.getElementById("globalLoader").classList.add("hide"); }

function formatDate(ts) {
  if (!ts) return "—";
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleDateString("id-ID", { day:"2-digit", month:"short", year:"numeric" });
}
function formatTime(ts) {
  if (!ts) return "—";
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleTimeString("id-ID", { hour:"2-digit", minute:"2-digit", second:"2-digit" });
}
/** Tanggal lokal YYYY-MM-DD (hindari bug UTC vs WIB untuk field `date` & filter hari ini) */
function ymdLocal(d = new Date()) {
  const x = d instanceof Date ? d : (d && d.toDate ? d.toDate() : new Date(d));
  if (Number.isNaN(x.getTime())) return "";
  const y = x.getFullYear();
  const m = String(x.getMonth() + 1).padStart(2, "0");
  const day = String(x.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

const MONTH_NAMES_ID = [
  "Januari", "Februari", "Maret", "April", "Mei", "Juni",
  "Juli", "Agustus", "September", "Oktober", "November", "Desember"
];

function monthDateBounds(ym) {
  if (!ym || !/^\d{4}-\d{2}$/.test(ym)) return null;
  const [y, mo] = ym.split("-").map(Number);
  const start = `${y}-${String(mo).padStart(2, "0")}-01`;
  const lastD = new Date(y, mo, 0).getDate();
  const end = `${y}-${String(mo).padStart(2, "0")}-${String(lastD).padStart(2, "0")}`;
  return { start, end };
}

function formatMonthLabelId(ym) {
  const b = monthDateBounds(ym);
  if (!b) return ym;
  const mo = parseInt(ym.split("-")[1], 10);
  const y = ym.split("-")[0];
  return `${MONTH_NAMES_ID[mo - 1] || ym} ${y}`;
}

function escapeHtml(s) {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function parseHHMM(s) {
  if (!s || typeof s !== "string") return { h: 8, m: 0 };
  const p = s.trim().split(":");
  const a = parseInt(p[0], 10);
  const b = parseInt(p[1], 10);
  return { h: Number.isNaN(a) ? 8 : a, m: Number.isNaN(b) ? 0 : b };
}
function formatTimeHM(ts) {
  if (!ts) return "—";
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" });
}
/** Lama di kantor: dari jam masuk (check-in pertama) sampai jam pulang (check-out terakhir). */
function formatDurationAtOffice(ciTs, coTs) {
  if (!ciTs || !coTs) return "—";
  const t0 = ciTs.toDate ? ciTs.toDate() : new Date(ciTs);
  const t1 = coTs.toDate ? coTs.toDate() : new Date(coTs);
  const ms = t1.getTime() - t0.getTime();
  if (Number.isNaN(ms) || ms < 0) return "—";
  if (ms < 60000) return "< 1 menit";
  const totalMin = Math.floor(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m} menit`;
  if (m === 0) return `${h} jam`;
  return `${h} jam ${m} menit`;
}
/** Gabungkan dokumen absensi → satu baris per (tanggal + uid) */
function aggregateAttendanceByDay(docs) {
  const map = new Map();
  for (const docSnap of docs) {
    const data = docSnap.data();
    const ts = data.timestamp?.toDate?.();
    if (!ts) continue;
    const dateStr = /^\d{4}-\d{2}-\d{2}$/.test(data.date || "") ? data.date : ymdLocal(ts);
    const key = `${dateStr}|${data.uid || ""}`;
    if (!map.has(key)) {
      map.set(key, {
        dateStr,
        uid: data.uid,
        email: data.email || "",
        displayName: data.displayName || "",
        ci: null,
        co: null,
        ciMs: Infinity,
        coMs: -Infinity,
        ciStatus: null,
        coStatus: null,
        ciDist: null,
        coDist: null,
      });
    }
    const row = map.get(key);
    const ms = ts.getTime();
    if (data.type === "Check In") {
      if (ms < row.ciMs) {
        row.ciMs = ms;
        row.ci = data.timestamp;
        row.ciStatus = data.status;
        row.ciDist = data.distanceMeters;
      }
    }
    if (data.type === "Check Out") {
      if (ms > row.coMs) {
        row.coMs = ms;
        row.co = data.timestamp;
        row.coStatus = data.status;
        row.coDist = data.distanceMeters;
      }
    }
  }
  return Array.from(map.values()).sort((a, b) => {
    if (a.dateStr !== b.dateStr) return b.dateStr.localeCompare(a.dateStr);
    return (a.displayName || a.email || "").localeCompare(b.displayName || b.email || "");
  });
}
function chipClassForStatus(s) {
  if (s === "Hadir") return "chip-valid";
  if (s === "Terlambat") return "chip-late";
  if (s === "Ditolak") return "chip-rejected";
  return "chip-valid";
}

/**
 * Absensi per uid: hanya equality pada `uid` → tidak butuh indeks komposit Firestore.
 * Urutan terbaru dulu dibuat di klien (setelah getDocs).
 */
async function fetchAttendanceDocsByUid(uid, maxEvents = 3000) {
  const q = query(collection(db, "attendance"), where("uid", "==", uid));
  const snap = await getDocs(q);
  const sorted = snap.docs.sort((a, b) => {
    const ta = a.data().timestamp?.toDate?.()?.getTime() ?? 0;
    const tb = b.data().timestamp?.toDate?.()?.getTime() ?? 0;
    return tb - ta;
  });
  return sorted.length > maxEvents ? sorted.slice(0, maxEvents) : sorted;
}

function sortDocsByTimestampDesc(docs) {
  return docs.sort((a, b) => {
    const ta = a.data().timestamp?.toDate?.()?.getTime() ?? 0;
    const tb = b.data().timestamp?.toDate?.()?.getTime() ?? 0;
    return tb - ta;
  });
}

/** Ambil dokumen absensi dalam rentang tanggal `date` (YYYY-MM-DD) untuk satu bulan. */
async function fetchAttendanceDocsInMonth(ym, uidOptional) {
  const bounds = monthDateBounds(ym);
  if (!bounds) return [];
  const { start, end } = bounds;
  if (uidOptional) {
    const q = query(
      collection(db, "attendance"),
      where("uid", "==", uidOptional),
      where("date", ">=", start),
      where("date", "<=", end)
    );
    const snap = await getDocs(q);
    return sortDocsByTimestampDesc(snap.docs);
  }
  const q = query(
    collection(db, "attendance"),
    where("date", ">=", start),
    where("date", "<=", end),
    limit(8000)
  );
  const snap = await getDocs(q);
  return sortDocsByTimestampDesc(snap.docs);
}

function getGreeting() {
  const h = new Date().getHours();
  if (h < 11) return "Selamat Pagi ☀️";
  if (h < 15) return "Selamat Siang 🕛";
  if (h < 18) return "Selamat Sore 🌤";
  return "Selamat Malam 🌙";
}

// Haversine
function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 +
            Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) *
            Math.sin(dLng/2)**2;
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)));
}

// Confirm modal
let confirmCallback = null;
function askConfirm(title, msg, cb) {
  document.getElementById("confirmTitle").textContent   = title;
  document.getElementById("confirmMessage").textContent = msg;
  confirmCallback = cb;
  document.getElementById("confirmModal").classList.add("show");
}
function closeConfirm() { document.getElementById("confirmModal").classList.remove("show"); }
document.getElementById("confirmOk").addEventListener("click", () => {
  closeConfirm();
  if (confirmCallback) confirmCallback();
});
window.closeConfirm = closeConfirm;

// ═══════════════════════════════════════════════
// 5. CLOCK & DATES
// ═══════════════════════════════════════════════
function startClock() {
  const tick = () => {
    const now = new Date();
    const el = document.getElementById("topbarClock");
    if (el) el.textContent = now.toLocaleTimeString("id-ID");
  };
  tick();
  setInterval(tick, 1000);
}

function updateTopbarDate() {
  const el = document.getElementById("topbarDate");
  if (el) el.textContent = new Date().toLocaleDateString("id-ID", {
    weekday: "long", day: "numeric", month: "long", year: "numeric"
  });
}

// ═══════════════════════════════════════════════
// 6. LOGIN / FLOATING DOTS ANIMATION
// ═══════════════════════════════════════════════
function spawnDots() {
  const container = document.getElementById("floatingDots");
  if (!container) return;
  for (let i = 0; i < 22; i++) {
    const dot = document.createElement("div");
    dot.className = "fdot";
    const size = Math.random() * 10 + 4;
    const driftX = (Math.random() - 0.5) * 36;
    dot.style.cssText = `
      width:${size}px; height:${size}px;
      left:${Math.random()*100}%;
      top:${Math.random()*100}%;
      animation-duration:${Math.random()*14+6}s;
      animation-delay:${Math.random()*8}s;
      --dot-dx:${driftX}px;
    `;
    container.appendChild(dot);
  }
}

// ═══════════════════════════════════════════════
// 7. AUTH STATE
// ═══════════════════════════════════════════════
onAuthStateChanged(auth, async (user) => {
  if (user) {
    currentUser = user;
    const ok = await loadUserProfile(user.uid);
    if (!ok) {
      hideLoader();
      return;
    }
    showApp();
  } else {
    currentUser = null;
    currentRole = null;
    showLogin();
  }
  hideLoader();
});

async function showApp() {
  document.getElementById("loginPage").classList.remove("active");
  document.getElementById("mainApp").style.display = "flex";
  await loadOfficeConfig(); // Muat koordinat kantor dari Firestore
  applyRole();
  fillUserUI();
  startClock();
  updateTopbarDate();
  updateDashboardGeoInfo();
  loadDashboard();
  checkTodayAbsenStatus();
  initReportMonthDefaults();
}

function initReportMonthDefaults() {
  const yms = new Date().toISOString().slice(0, 7);
  const a = document.getElementById("adminReportMonth");
  const m = document.getElementById("myReportMonth");
  if (a && !a.value) a.value = yms;
  if (m && !m.value) m.value = yms;
}

async function loadUserProfile(uid) {
  try {
    // 1. Cek apakah akun ini telah dihapus oleh Admin
    let isDeleted = false;
    try {
      const delSnap = await getDoc(doc(db, "deleted_accounts", uid));
      isDeleted = delSnap.exists();
    } catch (_) {}

    if (isDeleted) {
      await signOut(auth);
      showToast("Akun Anda telah dinonaktifkan atau dihapus oleh Administrator.", "error");
      showLogin();
      return false;
    }

    const snap = await getDoc(doc(db, "users", uid));
    if (snap.exists()) {
      currentProfile = snap.data();
      const rawRole = currentProfile.role ?? currentProfile.Role;
      const r = String(rawRole ?? "karyawan").toLowerCase().trim();
      currentRole    = r === "admin" ? "admin" : "karyawan";
    } else {
      // Profile belum ada dan bukan akun terhapus: buat default
      currentProfile = { name: currentUser.email.split("@")[0], role: "karyawan", email: currentUser.email };
      await setDoc(doc(db, "users", uid), { ...currentProfile, uid, createdAt: serverTimestamp() });
      currentRole = "karyawan";
    }
    return true;
  } catch (e) {
    console.error("loadUserProfile error:", e);
    currentRole = "karyawan";
    currentProfile = { name: currentUser?.email || "User", role: "karyawan", email: currentUser?.email };
    return true;
  }
}

function showLogin() {
  document.getElementById("loginPage").classList.add("active");
  document.getElementById("mainApp").style.display = "none";
  spawnDots();
}

// ═══════════════════════════════════════════════
// 8. ROLE SYSTEM
// ═══════════════════════════════════════════════
function applyRole() {
  const isAdmin = currentRole === "admin";
  document.body.classList.toggle("is-admin", isAdmin);
  document.body.classList.toggle("is-karyawan", !isAdmin);
  const mainApp = document.getElementById("mainApp");
  if (mainApp) mainApp.classList.toggle("main-app--admin", isAdmin);

  const brandTitle = document.getElementById("sidebarBrandTitle");
  if (brandTitle) brandTitle.textContent = isAdmin ? "AbsensiGeo Admin" : "AbsensiGeo";
  const brandSub = document.querySelector(".sidebar-brand-text span");
  if (brandSub) {
    brandSub.textContent = isAdmin ? "Regional 6 · Kontrol Penuh" : "Telkomsat Regional 6";
  }
  const welcomeIc = document.querySelector("#welcomeBannerIcon");
  if (welcomeIc) {
    welcomeIc.className = isAdmin ? "fas fa-user-shield" : "fas fa-hand-wave";
  }

  const roleBadge = document.getElementById("sidebarRole");
  if (roleBadge) {
    roleBadge.textContent = isAdmin ? "Admin" : "Karyawan";
    roleBadge.classList.toggle("admin", isAdmin);
  }
}

function fillUserUI() {
  const name  = currentProfile?.name || currentUser.email;
  const email = currentUser.email;
  const initials = name.charAt(0).toUpperCase();

  document.getElementById("sidebarName").textContent  = name;
  document.getElementById("sidebarAvatar").textContent = initials;
  document.getElementById("topbarAvatar").textContent  = initials;

  document.getElementById("greetingText").textContent = getGreeting();
  document.getElementById("welcomeName").textContent  = name;
  document.getElementById("welcomeDate").textContent  = new Date().toLocaleDateString("id-ID", {
    weekday:"long", day:"numeric", month:"long", year:"numeric"
  });
  const hint = document.getElementById("welcomeRoleHint");
  if (hint) {
    hint.textContent = currentRole === "admin"
      ? "Anda masuk sebagai Administrator — memantau seluruh aktivitas dan pengaturan sistem."
      : "Berikut ringkasan absensi pribadi Anda hari ini dan statistik kehadiran.";
  }
}

// ═══════════════════════════════════════════════
// 9. NAVIGATION
// ═══════════════════════════════════════════════
const VIEW_TITLES = {
  viewDashboard:   "Dashboard",
  viewAbsensi:     "Area Absensi",
  viewRiwayat:     "Riwayat Saya",
  viewAllAbsensi:  "Semua Absensi (Admin)",
  viewManageUsers: "Kelola Karyawan (Admin)",
  viewGeoSettings: "Pengaturan Geofence (Admin)",
};

function setSidebarOpen(open) {
  const sb = document.getElementById("sidebar");
  const bd = document.getElementById("sidebarBackdrop");
  if (!sb) return;
  sb.classList.toggle("open", !!open);
  if (bd) {
    bd.classList.toggle("show", !!open);
    bd.setAttribute("aria-hidden", open ? "false" : "true");
  }
}

document.querySelectorAll(".nav-btn[data-view]").forEach(btn => {
  btn.addEventListener("click", () => {
    const viewId = btn.dataset.view;
    switchView(viewId);
    if (window.innerWidth <= 900) setSidebarOpen(false);
  });
});

function switchView(viewId) {
  // Deactivate all nav btns & views
  document.querySelectorAll(".nav-btn[data-view]").forEach(b => b.classList.remove("active"));
  document.querySelectorAll(".view").forEach(v => v.classList.remove("active"));

  // Activate target
  const btn  = document.querySelector(`.nav-btn[data-view="${viewId}"]`);
  const view = document.getElementById(viewId);
  if (btn)  btn.classList.add("active");
  if (view) view.classList.add("active");

  document.getElementById("topbarTitle").textContent = VIEW_TITLES[viewId] || "";

  // Lazy load
  if (viewId === "viewAbsensi")     initAbsensiView();
  if (viewId === "viewRiwayat") {
    loadMyHistory();
    initReportMonthDefaults();
  }
  if (viewId === "viewAllAbsensi") {
    loadAllAttendance();
    fillAdminReportUserOptions();
  }
  if (viewId === "viewManageUsers") loadUsers();
  if (viewId === "viewGeoSettings") initGeoSettingsView();
}

// Hamburger + sidebar backdrop (tutup saat klik luar menu)
document.getElementById("hamburger").addEventListener("click", toggleSidebar);
function toggleSidebar() {
  const sb = document.getElementById("sidebar");
  if (!sb) return;
  setSidebarOpen(!sb.classList.contains("open"));
}
window.toggleSidebar = toggleSidebar;

document.getElementById("sidebarBackdrop")?.addEventListener("click", () => setSidebarOpen(false));

// ═══════════════════════════════════════════════
// 10. PASSWORD TOGGLE
// ═══════════════════════════════════════════════
window.togglePass = function() {
  const inp  = document.getElementById("loginPassword");
  const icon = document.getElementById("eyeIcon");
  if (inp.type === "password") { inp.type = "text";     icon.className = "fas fa-eye-slash"; }
  else                         { inp.type = "password"; icon.className = "fas fa-eye"; }
};

// ═══════════════════════════════════════════════
// 11. LOGIN FORM
// ═══════════════════════════════════════════════
document.getElementById("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!import.meta.env.VITE_FIREBASE_API_KEY) {
    showToast("Harap isi file .env dengan konfigurasi Firebase!", "error"); return;
  }
  const email = document.getElementById("loginEmail").value.trim();
  const pass  = document.getElementById("loginPassword").value;
  const btnInner = document.getElementById("btnLoginInner");
  btnInner.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Memverifikasi...`;
  try {
    await signInWithEmailAndPassword(auth, email, pass);
    showToast("Login berhasil! Selamat Datang 👋", "success");
  } catch (err) {
    console.error("Login error:", err.code, err.message);
    let msg = `Login gagal: ${err.code}`;
    if (err.code === "auth/invalid-credential" || err.code === "auth/wrong-password" || err.code === "auth/user-not-found")
      msg = "Email atau password salah. Coba lagi.";
    if (err.code === "auth/too-many-requests")
      msg = "Terlalu banyak percobaan. Coba beberapa saat lagi.";
    showToast(msg, "error");
  } finally {
    btnInner.innerHTML = `<i class="fas fa-arrow-right-to-bracket"></i> Masuk ke Sistem`;
  }
});

// ═══════════════════════════════════════════════
// 11b. LUPA PASSWORD (RESET PASSWORD VIA EMAIL)
// ═══════════════════════════════════════════════
function openForgotPasswordModal() {
  const loginEmailVal = document.getElementById("loginEmail")?.value?.trim() || "";
  const forgotInput = document.getElementById("forgotEmail");
  if (forgotInput) {
    if (loginEmailVal) {
      forgotInput.value = loginEmailVal;
    }
    setTimeout(() => forgotInput.focus(), 100);
  }
  const modal = document.getElementById("forgotPasswordModal");
  if (modal) {
    modal.classList.add("show");
    modal.setAttribute("aria-hidden", "false");
  }
}

function closeForgotPasswordModal() {
  const modal = document.getElementById("forgotPasswordModal");
  if (modal) {
    modal.classList.remove("show");
    modal.setAttribute("aria-hidden", "true");
  }
}

window.openForgotPasswordModal = openForgotPasswordModal;
window.closeForgotPasswordModal = closeForgotPasswordModal;

const forgotModalEl = document.getElementById("forgotPasswordModal");
if (forgotModalEl) {
  forgotModalEl.addEventListener("click", (e) => {
    if (e.target === forgotModalEl) {
      closeForgotPasswordModal();
    }
  });
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && forgotModalEl?.classList.contains("show")) {
    closeForgotPasswordModal();
  }
});

const forgotForm = document.getElementById("forgotPasswordForm");
if (forgotForm) {
  forgotForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!import.meta.env.VITE_FIREBASE_API_KEY) {
      showToast("Harap konfigurasi Firebase di file .env!", "error");
      return;
    }
    const emailInput = document.getElementById("forgotEmail");
    const email = emailInput?.value?.trim().toLowerCase();
    if (!email) {
      showToast("Silakan masukkan alamat email akun Anda.", "warning");
      return;
    }

    const btnInner = document.getElementById("btnSubmitForgotInner");
    const origHtml = btnInner ? btnInner.innerHTML : "";
    if (btnInner) {
      btnInner.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Mengirim...`;
    }

    try {
      await sendPasswordResetEmail(auth, email);
      closeForgotPasswordModal();
      if (emailInput) emailInput.value = "";
      showToast(`Tautan reset password berhasil dikirim ke ${email}. Silakan periksa kotak masuk atau spam email Anda.`, "success");
    } catch (err) {
      console.error("sendPasswordResetEmail error:", err.code, err.message);
      let msg = `Gagal mengirim link reset: ${err.code}`;
      if (err.code === "auth/user-not-found") {
        msg = "Email tidak terdaftar di sistem. Pastikan email Anda sudah benar.";
      } else if (err.code === "auth/invalid-email") {
        msg = "Format alamat email tidak valid.";
      } else if (err.code === "auth/missing-email") {
        msg = "Silakan masukkan alamat email.";
      } else if (err.code === "auth/too-many-requests") {
        msg = "Terlalu banyak permintaan reset kata sandi. Silakan coba beberapa saat lagi.";
      } else if (err.code === "auth/network-request-failed") {
        msg = "Gagal terhubung ke server. Periksa jaringan internet Anda.";
      }
      showToast(msg, "error");
    } finally {
      if (btnInner) {
        btnInner.innerHTML = origHtml;
      }
    }
  });
}

// ═══════════════════════════════════════════════
// 12. LOGOUT
// ═══════════════════════════════════════════════
window.handleLogout = function() {
  askConfirm("Keluar dari Sistem", "Apakah Anda yakin ingin keluar?", async () => {
    await signOut(auth);
    showToast("Berhasil keluar.", "success");
  });
};

// ═══════════════════════════════════════════════
// 13. DASHBOARD
// ═══════════════════════════════════════════════
async function loadDashboard() {
  const titleEl = document.getElementById("activityFeedTitle");
  if (titleEl) {
    titleEl.textContent = currentRole === "admin"
      ? "Aktivitas Terakhir (Semua Karyawan)"
      : "Aktivitas Terakhir";
  }
  if (currentRole === "admin") {
    await Promise.all([loadAdminDashboardStats(), loadTodayStatus(), loadAdminActivityFeed()]);
  } else {
    await Promise.all([loadDashboardStats(), loadTodayStatus(), loadActivityFeed()]);
  }
}

async function loadAdminDashboardStats() {
  const statsRow = document.getElementById("statsRow");
  if (!statsRow || !currentUser) return;
  try {
    const usersSnap = await getDocs(collection(db, "users"));
    let totalUsers = 0;
    usersSnap.forEach(d => {
      const u = d.data();
      if (u.deleted !== true && u.status !== "nonaktif" && u.role !== "nonaktif" && u.role !== "deleted") {
        totalUsers++;
      }
    });

    const today = ymdLocal();
    const qToday = query(collection(db, "attendance"), orderBy("timestamp", "desc"), limit(600));
    const todaySnap = await getDocs(qToday);
    let hadir = 0, terlambat = 0, totalRec = 0;
    todaySnap.forEach(docSnap => {
      const data = docSnap.data();
      const ts = data.timestamp?.toDate?.();
      if (!ts || ymdLocal(ts) !== today) return;
      totalRec++;
      const s = data.status;
      if (s === "Hadir")     hadir++;
      if (s === "Terlambat") terlambat++;
    });

    const STATS = [
      { label: "Pengguna Terdaftar", val: totalUsers,     icon: "fa-users",         cls: "sc-red" },
      { label: "Catatan Absensi Hari Ini", val: totalRec, icon: "fa-clipboard-list", cls: "sc-green" },
      { label: "Hadir (Hari Ini)", val: hadir,            icon: "fa-circle-check",  cls: "sc-amber" },
      { label: "Terlambat (Hari Ini)", val: terlambat,    icon: "fa-clock",         cls: "sc-blue" },
    ];
    statsRow.innerHTML = STATS.map(s => `
      <div class="stat-card ${s.cls}">
        <div class="stat-icon"><i class="fas ${s.icon}"></i></div>
        <div class="stat-info">
          <div class="stat-num">${s.val}</div>
          <div class="stat-label">${s.label}</div>
        </div>
      </div>
    `).join("");
  } catch (e) {
    console.error("loadAdminDashboardStats:", e);
  }
}

async function loadAdminActivityFeed() {
  const feed = document.getElementById("activityFeed");
  if (!feed || !currentUser) return;
  try {
    const q = query(
      collection(db, "attendance"),
      orderBy("timestamp", "desc"),
      limit(8)
    );
    const snap = await getDocs(q);
    if (snap.empty) {
      feed.innerHTML = `<div class="empty-state"><i class="fas fa-inbox"></i><p>Belum ada aktivitas absensi</p></div>`;
      return;
    }
    feed.innerHTML = snap.docs.map(d => {
      const data = d.data();
      const isIn  = data.type === "Check In";
      const isErr = data.status === "Ditolak";
      const dotCls = isErr ? "dot-err" : isIn ? "dot-in" : "dot-out";
      const icon   = isErr ? "fa-xmark" : isIn ? "fa-sign-in-alt" : "fa-sign-out-alt";
      const who = data.displayName || data.email || "—";
      return `
        <div class="activity-item">
          <div class="activity-dot ${dotCls}"><i class="fas ${icon}"></i></div>
          <div class="activity-text">
            <h4>${data.type} — <span class="status-chip ${isErr?"chip-rejected":data.status==="Terlambat"?"chip-late":"chip-valid"}">${data.status}</span></h4>
            <p><strong>${who}</strong> · Jarak: ${data.distanceMeters}m</p>
          </div>
          <span class="activity-time">${formatDate(data.timestamp)} ${formatTime(data.timestamp)}</span>
        </div>
      `;
    }).join("");
  } catch (e) {
    console.error("loadAdminActivityFeed:", e);
  }
}

async function loadDashboardStats() {
  const statsRow = document.getElementById("statsRow");
  if (!statsRow || !currentUser) return;

  try {
    const q = query(collection(db, "attendance"), where("uid", "==", currentUser.uid));
    const snap = await getDocs(q);
    let hadirCount = 0, terlambatCount = 0, ditolakCount = 0;
    snap.forEach(d => {
      const s = d.data().status;
      if (s === "Hadir")     hadirCount++;
      if (s === "Terlambat") terlambatCount++;
      if (s === "Ditolak")   ditolakCount++;
    });
    const totalDays = hadirCount + terlambatCount;

    const STATS = [
      { label:"Total Hadir",    val: totalDays,     icon:"fa-calendar-check",    cls:"sc-red" },
      { label:"Tepat Waktu",    val: hadirCount,     icon:"fa-circle-check",      cls:"sc-green" },
      { label:"Terlambat",      val: terlambatCount, icon:"fa-clock",             cls:"sc-amber" },
      { label:"Absensi Ditolak",val: ditolakCount,   icon:"fa-circle-xmark",      cls:"sc-blue" },
    ];

    statsRow.innerHTML = STATS.map(s => `
      <div class="stat-card ${s.cls}">
        <div class="stat-icon"><i class="fas ${s.icon}"></i></div>
        <div class="stat-info">
          <div class="stat-num">${s.val}</div>
          <div class="stat-label">${s.label}</div>
        </div>
      </div>
    `).join("");
  } catch (e) {
    console.error("loadDashboardStats:", e);
  }
}

async function loadTodayStatus() {
  if (!currentUser) return;
  const today = ymdLocal();
  try {
    const docs = await fetchAttendanceDocsByUid(currentUser.uid, 500);
    let ciTime = null, coTime = null;
    let ciMs = Infinity, coMs = -Infinity;
    docs.forEach(docSnap => {
      const data = docSnap.data();
      const ts = data.timestamp?.toDate?.();
      if (!ts || ymdLocal(ts) !== today) return;
      const ms = ts.getTime();
      if (data.type === "Check In" && ms < ciMs) {
        ciMs = ms;
        ciTime = data.timestamp;
      }
      if (data.type === "Check Out" && ms > coMs) {
        coMs = ms;
        coTime = data.timestamp;
      }
    });
    const inStr = ciTime ? formatTimeHM(ciTime) : "--:--";
    const outStr = coTime ? formatTimeHM(coTime) : "--:--";
    document.getElementById("dashCheckIn").textContent     = inStr;
    document.getElementById("dashCheckOut").textContent      = outStr;
    document.getElementById("dashCheckInSub").textContent   = ciTime ? `Jam masuk ${inStr} · tercatat` : "Belum jam masuk hari ini";
    document.getElementById("dashCheckOutSub").textContent  = coTime ? `Jam pulang ${outStr} · tercatat` : "Belum jam pulang hari ini";
  } catch (e) {
    console.error("loadTodayStatus:", e);
  }
}

async function loadActivityFeed() {
  const feed = document.getElementById("activityFeed");
  if (!feed || !currentUser) return;
  try {
    const docs = await fetchAttendanceDocsByUid(currentUser.uid, 80);
    const recent = docs.slice(0, 6);
    if (!recent.length) { feed.innerHTML = `<div class="empty-state"><i class="fas fa-inbox"></i><p>Belum ada aktivitas absensi</p></div>`; return; }
    feed.innerHTML = recent.map(d => {
      const data = d.data();
      const isIn  = data.type === "Check In";
      const isErr = data.status === "Ditolak";
      const dotCls = isErr ? "dot-err" : isIn ? "dot-in" : "dot-out";
      const icon   = isErr ? "fa-xmark" : isIn ? "fa-sign-in-alt" : "fa-sign-out-alt";
      return `
        <div class="activity-item">
          <div class="activity-dot ${dotCls}"><i class="fas ${icon}"></i></div>
          <div class="activity-text">
            <h4>${data.type} — <span class="status-chip ${isErr?"chip-rejected":data.status==="Terlambat"?"chip-late":"chip-valid"}">${data.status}</span></h4>
            <p>${data.displayName || data.email} · Jarak: ${data.distanceMeters}m</p>
          </div>
          <span class="activity-time">${formatDate(data.timestamp)} ${formatTime(data.timestamp)}</span>
        </div>
      `;
    }).join("");
  } catch (e) {
    console.error("loadActivityFeed:", e);
  }
}

// ═══════════════════════════════════════════════
// 14. ABSENSI VIEW — MAP + GPS
// ═══════════════════════════════════════════════
function initAbsensiView() {
  if (!map) {
    map = L.map("mapContainer").setView([OFFICE.lat, OFFICE.lng], 16);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19, attribution: "© OpenStreetMap"
    }).addTo(map);

    // Office marker
    officeMarker = L.marker([OFFICE.lat, OFFICE.lng], {
      icon: L.divIcon({
        className: "",
        html: `<div style="background:#dc2626;color:#fff;width:36px;height:36px;border-radius:50%;
                      display:flex;align-items:center;justify-content:center;font-size:16px;
                      border:3px solid #fff;box-shadow:0 4px 12px rgba(220,38,38,.5);">
                 <i class="fas fa-building"></i></div>`,
        iconSize: [36, 36], iconAnchor: [18, 18]
      })
    }).addTo(map).bindPopup("<b>📍 Kantor Telkomsat Regional 6</b><br>Medan, Sumatera Utara");

    // Geofence circle
    geoCircle = L.circle([OFFICE.lat, OFFICE.lng], {
      radius: RADIUS_M, color: "#dc2626", fillColor: "#dc2626", fillOpacity: .12, weight: 2, dashArray: "8 4"
    }).addTo(map);
  } else {
    map.invalidateSize();
  }
  checkTodayAbsenStatus();
  getUserGPS();
}

// ═══════════════════════════════════════════════
// 14b. VALIDASI ALUR ABSENSI HARIAN (CHECK IN & CHECK OUT)
// ═══════════════════════════════════════════════
async function checkTodayAbsenStatus() {
  if (!currentUser) return;
  const today = ymdLocal();
  try {
    const docs = await fetchAttendanceDocsByUid(currentUser.uid, 200);
    let hasCI = false;
    let hasCO = false;
    let ciTime = null;
    let coTime = null;
    let ciStatus = null;
    let ciMs = Infinity;
    let coMs = -Infinity;

    docs.forEach(docSnap => {
      const data = docSnap.data();
      const ts = data.timestamp?.toDate?.();
      const dateStr = data.date || (ts ? ymdLocal(ts) : "");
      if (dateStr !== today) return;

      // Percobaan absensi yang ditolak tidak dihitung sebagai absensi sah
      if (data.status === "Ditolak") return;

      const ms = ts ? ts.getTime() : 0;
      if (data.type === "Check In" && ms < ciMs) {
        hasCI = true;
        ciMs = ms;
        ciTime = data.timestamp;
        ciStatus = data.status;
      }
      if (data.type === "Check Out" && ms > coMs) {
        hasCO = true;
        coMs = ms;
        coTime = data.timestamp;
      }
    });

    todayAttendance = {
      hasCheckedIn: hasCI,
      hasCheckedOut: hasCO,
      checkInTime: ciTime,
      checkOutTime: coTime,
      checkInStatus: ciStatus
    };

    updateAbsensiButtonsUI();
  } catch (err) {
    console.error("checkTodayAbsenStatus error:", err);
  }
}

function updateAbsensiButtonsUI() {
  const btnIn = document.getElementById("btnCheckIn");
  const btnOut = document.getElementById("btnCheckOut");
  const subIn = document.getElementById("subCheckIn");
  const subOut = document.getElementById("subCheckOut");
  const banner = document.getElementById("todayAbsenBanner");
  const bannerTitle = document.getElementById("bannerTitle");
  const bannerDesc = document.getElementById("bannerDesc");

  if (!btnIn || !btnOut) return;

  const inside = currentDist !== null && currentDist <= RADIUS_M;

  // Kasus 1: Check In dan Check Out sudah selesai hari ini
  if (todayAttendance.hasCheckedIn && todayAttendance.hasCheckedOut) {
    btnIn.disabled = true;
    btnOut.disabled = true;
    btnIn.classList.add("btn-completed");
    btnOut.classList.add("btn-completed");
    if (subIn) subIn.textContent = `Tercatat (${formatTimeHM(todayAttendance.checkInTime)})`;
    if (subOut) subOut.textContent = `Tercatat (${formatTimeHM(todayAttendance.checkOutTime)})`;

    if (banner) {
      banner.className = "today-absen-status-banner banner-completed";
      if (bannerTitle) bannerTitle.textContent = "Absensi Hari Ini Lengkap! 🎉";
      if (bannerDesc) bannerDesc.textContent = `Masuk: ${formatTimeHM(todayAttendance.checkInTime)} (${todayAttendance.checkInStatus}) · Pulang: ${formatTimeHM(todayAttendance.checkOutTime)}. Sampai jumpa besok!`;
    }
    return;
  }

  // Kasus 2: Sudah Check In, Tinggal Check Out
  if (todayAttendance.hasCheckedIn && !todayAttendance.hasCheckedOut) {
    btnIn.disabled = true;
    btnIn.classList.add("btn-completed");
    if (subIn) subIn.textContent = `Tercatat (${formatTimeHM(todayAttendance.checkInTime)} - ${todayAttendance.checkInStatus})`;

    btnOut.classList.remove("btn-completed");
    btnOut.disabled = !inside;
    if (subOut) {
      subOut.textContent = inside ? "Klik untuk Selesai Kerja" : "Harus dalam radius kantor";
    }

    if (banner) {
      banner.className = "today-absen-status-banner banner-ongoing";
      if (bannerTitle) bannerTitle.textContent = `Sudah Check In: ${formatTimeHM(todayAttendance.checkInTime)} (${todayAttendance.checkInStatus})`;
      if (bannerDesc) bannerDesc.textContent = "Anda sudah check in hari ini. Silakan klik Check Out saat jam kerja selesai.";
    }
    return;
  }

  // Kasus 3: Belum Check In sama sekali hari ini
  btnIn.classList.remove("btn-completed");
  btnIn.disabled = !inside;
  if (subIn) {
    subIn.textContent = inside ? "Masuk Kerja" : "Harus dalam radius kantor";
  }

  btnOut.classList.remove("btn-completed");
  btnOut.disabled = true; // Tidak boleh check out sebelum check in
  if (subOut) {
    subOut.textContent = "Harus Check In dulu";
  }

  if (banner) {
    banner.className = "today-absen-status-banner banner-initial";
    if (bannerTitle) bannerTitle.textContent = "Belum Check In Hari Ini";
    if (bannerDesc) bannerDesc.textContent = inside
      ? "Anda berada dalam radius kantor. Silakan klik tombol CHECK IN."
      : `Dekati area kantor (radius ≤ ${RADIUS_M}m) untuk dapat melakukan Check In.`;
  }
}

function getUserGPS() {
  resetGeoStatus("loading");
  if (!navigator.geolocation) {
    setGeoStatus("error", "GPS Tidak Didukung", "Browser Anda tidak mendukung Geolokasi.");
    return;
  }
  navigator.geolocation.getCurrentPosition(
    pos => {
      userLatLng = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      currentDist = haversine(userLatLng.lat, userLatLng.lng, OFFICE.lat, OFFICE.lng);
      document.getElementById("coordLat").textContent = userLatLng.lat.toFixed(6);
      document.getElementById("coordLng").textContent = userLatLng.lng.toFixed(6);
      updateUserMarker();
      updateGeoStatusUI();
    },
    err => {
      console.error("GPS error:", err);
      setGeoStatus("error", "Gagal Mendapatkan GPS",
        err.code === 1 ? "Izin lokasi ditolak. Aktifkan akses lokasi." :
        err.code === 2 ? "Posisi tidak tersedia." : "Waktu habis. Coba lagi.");
    },
    { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 }
  );
}

function updateUserMarker() {
  if (!map || !userLatLng) return;
  if (userMarker) {
    userMarker.setLatLng([userLatLng.lat, userLatLng.lng]);
  } else {
    userMarker = L.marker([userLatLng.lat, userLatLng.lng], {
      icon: L.divIcon({
        className: "",
        html: `<div style="background:#3b82f6;color:#fff;width:32px;height:32px;border-radius:50%;
                      display:flex;align-items:center;justify-content:center;font-size:14px;
                      border:3px solid #fff;box-shadow:0 4px 12px rgba(59,130,246,.5);
                      animation:geoGlow 2s infinite;">
                 <i class="fas fa-person"></i></div>`,
        iconSize: [32, 32], iconAnchor: [16, 16]
      })
    }).addTo(map).bindPopup("📍 Lokasi Anda Sekarang");
  }
  const bounds = L.latLngBounds([[OFFICE.lat, OFFICE.lng], [userLatLng.lat, userLatLng.lng]]);
  map.fitBounds(bounds, { padding: [60, 60] });
}

function updateGeoStatusUI() {
  if (currentDist === null) return;
  const inside = currentDist <= RADIUS_M;
  const icon   = document.getElementById("geoStatusIcon");
  icon.className = `geo-status-icon ${inside ? "inside" : "outside"}`;
  icon.innerHTML = `<i class="fas ${inside ? "fa-check-circle" : "fa-times-circle"}"></i>`;
  document.getElementById("geoStatusTitle").textContent = inside ? "✅ Dalam Radius Geofence" : "❌ Di Luar Radius";
  document.getElementById("geoStatusDesc").textContent  = inside
    ? `Anda berjarak ${currentDist}m dari kantor. Absensi diizinkan!`
    : `Anda berjarak ${currentDist}m dari kantor. Harus ≤ ${RADIUS_M}m.`;
  document.getElementById("geoDistTxt").textContent = `${currentDist} meter`;

  // Update tombol sesuai alur absensi hari ini & lokasi GPS
  updateAbsensiButtonsUI();
  document.getElementById("absensiResult").style.display = "none";
}

function resetGeoStatus(state) {
  const icon = document.getElementById("geoStatusIcon");
  if (state === "loading") {
    icon.className = "geo-status-icon";
    icon.innerHTML = `<i class="fas fa-satellite fa-spin"></i>`;
    document.getElementById("geoStatusTitle").textContent = "Mendeteksi Lokasi...";
    document.getElementById("geoStatusDesc").textContent  = "Mohon tunggu, mengambil sinyal GPS";
  }
  document.getElementById("btnCheckIn").disabled  = true;
  document.getElementById("btnCheckOut").disabled = true;
}

function setGeoStatus(type, title, desc) {
  const icon = document.getElementById("geoStatusIcon");
  icon.className = `geo-status-icon ${type === "error" ? "outside" : ""}`;
  icon.innerHTML = `<i class="fas ${type==="error" ? "fa-exclamation-triangle" : "fa-info-circle"}"></i>`;
  document.getElementById("geoStatusTitle").textContent = title;
  document.getElementById("geoStatusDesc").textContent  = desc;
  showToast(title + " — " + desc, "warning");
}

// Refresh GPS
document.getElementById("btnRefreshGPS").addEventListener("click", () => {
  if (!map) { initAbsensiView(); return; }
  getUserGPS();
});

// ═══════════════════════════════════════════════
// 15. ABSENSI — CHECK IN / CHECK OUT
// ═══════════════════════════════════════════════
async function recordAbsensi(type) {
  if (!currentUser || !userLatLng || currentDist === null) {
    showToast("Lokasi belum terdeteksi. Klik 'Perbarui'.", "warning"); return;
  }

  // Validasi alur harian: Cegah absensi ganda
  if (type === "Check In") {
    if (todayAttendance.hasCheckedIn) {
      showToast(`Anda sudah melakukan Check In hari ini (${formatTimeHM(todayAttendance.checkInTime)}). Tinggal lakukan Check Out saat pulang kerja.`, "warning");
      return;
    }
  }

  if (type === "Check Out") {
    if (!todayAttendance.hasCheckedIn) {
      showToast("Anda belum melakukan Check In hari ini! Silakan Check In terlebih dahulu.", "warning");
      return;
    }
    if (todayAttendance.hasCheckedOut) {
      showToast(`Anda sudah melakukan Check Out hari ini (${formatTimeHM(todayAttendance.checkOutTime)}). Absensi hari ini sudah lengkap!`, "warning");
      return;
    }
  }

  const inside = currentDist <= RADIUS_M;
  const now    = new Date();
  const today  = ymdLocal(now);

  const { h: sh, m: sm } = parseHHMM(WORK_START);
  const deadline = new Date(now.getFullYear(), now.getMonth(), now.getDate(), sh, sm + LATE_GRACE_MIN, 0, 0);
  let status = inside ? "Hadir" : "Ditolak";
  if (inside && type === "Check In" && now.getTime() > deadline.getTime()) {
    status = "Terlambat";
  }

  const payload = {
    uid:           currentUser.uid,
    email:         currentUser.email,
    displayName:   currentProfile?.name || currentUser.email,
    department:    currentProfile?.department || "—",
    type,
    status,
    date:          today,
    distanceMeters: currentDist,
    lat:           userLatLng.lat,
    lng:           userLatLng.lng,
    timestamp:     serverTimestamp(),
  };

  showLoader();
  try {
    await addDoc(collection(db, "attendance"), payload);
    const resultEl   = document.getElementById("absensiResult");
    const resultIcon = document.getElementById("resultIcon");
    const resultMsg  = document.getElementById("resultMsg");
    resultEl.style.display = "block";

    if (status === "Ditolak") {
      resultIcon.innerHTML = "❌";
      resultMsg.textContent = `Ditolak! Anda berjarak ${currentDist}m, melebihi batas ${RADIUS_M}m.`;
      resultMsg.style.color = "#dc2626";
      showToast("Absensi DITOLAK — Di luar radius geofence!", "error");
    } else {
      resultIcon.innerHTML = status === "Terlambat" ? "⚠️" : "✅";
      resultMsg.textContent = `${type} berhasil! Status: ${status}. Jarak: ${currentDist}m.`;
      resultMsg.style.color = status === "Terlambat" ? "#d97706" : "#16a34a";
      showToast(`${type} berhasil — ${status}`, "success");

      // Perbarui status lokal seketika
      const nowTs = new Date();
      if (type === "Check In") {
        todayAttendance.hasCheckedIn = true;
        todayAttendance.checkInTime = nowTs;
        todayAttendance.checkInStatus = status;
      } else if (type === "Check Out") {
        todayAttendance.hasCheckedOut = true;
        todayAttendance.checkOutTime = nowTs;
      }
      updateAbsensiButtonsUI();
    }
    await checkTodayAbsenStatus();
    await loadTodayStatus();
    await loadDashboard();
  } catch (e) {
    console.error("recordAbsensi error:", e);
    showToast("Gagal menyimpan absensi: " + e.message, "error");
  } finally {
    hideLoader();
  }
}

document.getElementById("btnCheckIn").addEventListener("click",  () => recordAbsensi("Check In"));
document.getElementById("btnCheckOut").addEventListener("click", () => recordAbsensi("Check Out"));

// ═══════════════════════════════════════════════
// 16. RIWAYAT SAYA
// ═══════════════════════════════════════════════
async function loadMyHistory() {
  const tbody = document.getElementById("myHistoryBody");
  tbody.innerHTML = `<tr class="history-span-row"><td colspan="8" class="td-loading"><i class="fas fa-spinner fa-spin"></i> Memuat...</td></tr>`;
  try {
    const docs = await fetchAttendanceDocsByUid(currentUser.uid, 4000);
    const rows = aggregateAttendanceByDay(docs).filter(r => r.uid === currentUser.uid);
    if (!rows.length) {
      tbody.innerHTML = `<tr class="history-span-row"><td colspan="8" class="td-loading">Belum ada data absensi.</td></tr>`;
      return;
    }
    let html = "", i = 1;
    for (const r of rows) {
      const ciChip = r.ciStatus ? chipClassForStatus(r.ciStatus) : "";
      const coChip = r.coStatus ? chipClassForStatus(r.coStatus) : "";
      const jarak = `${r.ciDist != null ? r.ciDist + " m" : "—"} / ${r.coDist != null ? r.coDist + " m" : "—"}`;
      const tgl = r.dateStr.split("-").reverse().join("/");
      const jm = r.ci ? formatTimeHM(r.ci) : "—";
      const jp = r.co ? formatTimeHM(r.co) : "—";
      const sm = r.ciStatus ? `<span class="status-chip ${ciChip}">${r.ciStatus}</span>` : "—";
      const sp = r.coStatus ? `<span class="status-chip ${coChip}">${r.coStatus}</span>` : "—";
      const dur = formatDurationAtOffice(r.ci, r.co);
      html += `
        <tr class="history-day-row">
          <td data-label="No">${i++}</td>
          <td data-label="Tanggal">${tgl}</td>
          <td class="td-time" data-label="Jam masuk">${jm}</td>
          <td class="td-time" data-label="Jam pulang">${jp}</td>
          <td class="td-duration" data-label="Lama di kantor">${dur}</td>
          <td data-label="Status masuk">${sm}</td>
          <td data-label="Status pulang">${sp}</td>
          <td class="td-muted td-jarak" data-label="Jarak (masuk / pulang)">${jarak}</td>
        </tr>`;
    }
    tbody.innerHTML = html;
  } catch (e) {
    console.error("loadMyHistory:", e);
    tbody.innerHTML = `<tr class="history-span-row"><td colspan="8" class="td-loading" style="color:red;">Error: ${e.message}</td></tr>`;
  }
}

// ═══════════════════════════════════════════════
// 17. SEMUA ABSENSI (ADMIN)
// ═══════════════════════════════════════════════
window.loadAllAttendance = async function() {
  if (currentRole !== "admin") return;
  const tbody     = document.getElementById("allAbsensiBody");
  const summaryEl = document.getElementById("adminAbsensiSummary");
  const monthInput= document.getElementById("filterAllAbsensiMonth");

  // Inisialisasi default filter bulan ke bulan berjalan jika belum diisi
  if (monthInput && !monthInput.value) {
    const now = new Date();
    monthInput.value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  }

  const filterM   = monthInput ? monthInput.value : "";
  const filterD   = document.getElementById("filterDate")?.value || "";
  const filterE   = document.getElementById("filterEmployee")?.value?.toLowerCase()?.trim() || "";
  tbody.innerHTML = `<tr><td colspan="10" class="td-loading"><i class="fas fa-spinner fa-spin"></i> Memuat data absensi...</td></tr>`;
  if (summaryEl) summaryEl.innerHTML = "";
  try {
    const q = query(collection(db, "attendance"), orderBy("timestamp", "desc"), limit(1500));
    const snap = await getDocs(q);
    let agg = aggregateAttendanceByDay(snap.docs);
    agg = agg.filter(r => {
      // Filter per bulan berjalan / bulan terpilih (YYYY-MM)
      if (filterM && !r.dateStr.startsWith(filterM)) return false;
      // Filter tanggal spesifik jika diisi (YYYY-MM-DD)
      if (filterD && r.dateStr !== filterD) return false;
      // Filter nama atau email karyawan
      if (filterE && !((r.displayName || "").toLowerCase().includes(filterE) || (r.email || "").toLowerCase().includes(filterE))) return false;
      return true;
    });

    let nHadir = 0, nLate = 0, nReject = 0;
    for (const r of agg) {
      const s = r.ciStatus;
      if (s === "Hadir")     nHadir++;
      if (s === "Terlambat") nLate++;
      if (s === "Ditolak")   nReject++;
    }
    let html = "", i = 1;
    for (const r of agg) {
      const ciChip = r.ciStatus ? chipClassForStatus(r.ciStatus) : "";
      const coChip = r.coStatus ? chipClassForStatus(r.coStatus) : "";
      const dur = formatDurationAtOffice(r.ci, r.co);
      html += `
        <tr>
          <td>${i++}</td>
          <td>${r.displayName || "—"}</td>
          <td>${r.email || "—"}</td>
          <td>${r.dateStr.split("-").reverse().join("/")}</td>
          <td class="td-time">${r.ci ? formatTimeHM(r.ci) : "—"}</td>
          <td class="td-time">${r.co ? formatTimeHM(r.co) : "—"}</td>
          <td class="td-duration">${dur}</td>
          <td>${r.ciStatus ? `<span class="status-chip ${ciChip}">${r.ciStatus}</span>` : "—"}</td>
          <td>${r.coStatus ? `<span class="status-chip ${coChip}">${r.coStatus}</span>` : "—"}</td>
          <td class="td-muted">${r.ciDist != null ? r.ciDist + " m" : "—"} / ${r.coDist != null ? r.coDist + " m" : "—"}</td>
        </tr>`;
    }
    if (summaryEl && agg.length) {
      const monthLabel = filterM ? formatMonthLabelId(filterM) : "Semua Bulan";
      summaryEl.innerHTML = `
        <div class="abs-summary-grid">
          <div class="abs-sum-item"><span>Periode (${monthLabel})</span><strong>${agg.length} Hari Kerja</strong></div>
          <div class="abs-sum-item sum-ok"><span>Masuk tepat waktu</span><strong>${nHadir}</strong></div>
          <div class="abs-sum-item sum-late"><span>Masuk terlambat</span><strong>${nLate}</strong></div>
          <div class="abs-sum-item sum-bad"><span>Masuk ditolak</span><strong>${nReject}</strong></div>
        </div>`;
    } else if (summaryEl) {
      const monthLabel = filterM ? formatMonthLabelId(filterM) : "periode ini";
      summaryEl.innerHTML = `<div class="abs-summary-empty">Tidak ada data absensi untuk ${monthLabel}.</div>`;
    }
    tbody.innerHTML = html || `<tr><td colspan="10" class="td-loading">Data absensi tidak ditemukan untuk filter ini.</td></tr>`;
  } catch (e) {
    console.error("loadAllAttendance:", e);
    tbody.innerHTML = `<tr><td colspan="10" class="td-loading" style="color:red;">Error: ${e.message}</td></tr>`;
  }
};

window.resetAllAbsensiFilters = function() {
  const monthInput = document.getElementById("filterAllAbsensiMonth");
  if (monthInput) {
    const now = new Date();
    monthInput.value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  }
  const dateInput = document.getElementById("filterDate");
  if (dateInput) dateInput.value = "";
  const empInput = document.getElementById("filterEmployee");
  if (empInput) empInput.value = "";
  loadAllAttendance();
};

// ═══════════════════════════════════════════════
// 17a. BERSIHKAN DATA ABSENSI BULANAN (ADMIN)
// ═══════════════════════════════════════════════
window.openPurgeAttendanceModal = function() {
  if (currentRole !== "admin") return;
  const purgeMonthInput = document.getElementById("purgeMonthInput");
  if (purgeMonthInput) {
    const currentFilterM = document.getElementById("filterAllAbsensiMonth")?.value;
    const now = new Date();
    purgeMonthInput.value = currentFilterM || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  }
  const modal = document.getElementById("purgeAttendanceModal");
  if (modal) modal.classList.add("show");
};

window.closePurgeAttendanceModal = function() {
  const modal = document.getElementById("purgeAttendanceModal");
  if (modal) modal.classList.remove("show");
};

const purgeModalEl = document.getElementById("purgeAttendanceModal");
if (purgeModalEl) {
  purgeModalEl.addEventListener("click", (e) => {
    if (e.target === purgeModalEl) window.closePurgeAttendanceModal();
  });
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && purgeModalEl?.classList.contains("show")) {
    window.closePurgeAttendanceModal();
  }
});

window.handlePurgeAttendanceSubmit = async function(e) {
  if (e) e.preventDefault();
  if (currentRole !== "admin") return;
  const purgeMonthInput = document.getElementById("purgeMonthInput");
  const ym = purgeMonthInput?.value?.trim();
  if (!ym || !/^\d{4}-\d{2}$/.test(ym)) {
    showToast("Pilih bulan yang valid (format YYYY-MM)!", "warning");
    return;
  }

  const monthLabel = formatMonthLabelId(ym);
  askConfirm(
    "Hapus Data Absensi Bulanan",
    `Apakah Anda YAKIN ingin menghapus seluruh data absensi untuk bulan "${monthLabel}"? Pastikan Anda sudah mengunduh Laporan PDF sebagai arsip, karena data tidak dapat dipulihkan!`,
    async () => {
      const btnInner = document.getElementById("btnConfirmPurgeInner");
      const origHtml = btnInner ? btnInner.innerHTML : "";
      if (btnInner) btnInner.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Menghapus...`;
      showLoader();
      try {
        const q = query(collection(db, "attendance"), orderBy("timestamp", "desc"), limit(3000));
        const snap = await getDocs(q);
        const toDeleteIds = [];
        for (const docSnap of snap.docs) {
          const data = docSnap.data();
          const dStr = data.date || (data.timestamp?.toDate ? ymdLocal(data.timestamp) : "");
          if (dStr && dStr.startsWith(ym)) {
            toDeleteIds.push(docSnap.id);
          }
        }

        if (toDeleteIds.length === 0) {
          hideLoader();
          window.closePurgeAttendanceModal();
          showToast(`Tidak ditemukan data absensi untuk bulan ${monthLabel}.`, "warning");
          return;
        }

        let batch = writeBatch(db);
        let bCount = 0;
        let deletedTotal = 0;

        for (const docId of toDeleteIds) {
          batch.delete(doc(db, "attendance", docId));
          bCount++;
          deletedTotal++;
          if (bCount === 450) {
            await batch.commit();
            batch = writeBatch(db);
            bCount = 0;
          }
        }
        if (bCount > 0) {
          await batch.commit();
        }

        hideLoader();
        window.closePurgeAttendanceModal();
        showToast(`Berhasil membersihkan ${deletedTotal} rekaman absensi bulan ${monthLabel}!`, "success");
        await loadAllAttendance();
        if (typeof loadDashboard === "function") {
          loadDashboard();
        }
      } catch (err) {
        console.error("handlePurgeAttendanceSubmit error:", err);
        hideLoader();
        showToast("Gagal membersihkan data absensi: " + err.message, "error");
      } finally {
        if (btnInner) btnInner.innerHTML = origHtml;
      }
    }
  );
};

// ═══════════════════════════════════════════════
// 17b. LAPORAN BULANAN (cetak & PDF) — admin & karyawan
// ═══════════════════════════════════════════════

function buildMonthlyReportInnerHtml(opts) {
  const { mode, ym, rows, subtitle, generatedBy } = opts;
  const monthTitle = formatMonthLabelId(ym);
  let nHadir = 0;
  let nLate = 0;
  let nReject = 0;
  for (const r of rows) {
    const s = r.ciStatus;
    if (s === "Hadir") nHadir++;
    if (s === "Terlambat") nLate++;
    if (s === "Ditolak") nReject++;
  }
  const colEmpty = mode === "admin" ? 10 : 8;
  let tableHead = "";
  let tableBody = "";
  if (mode === "admin") {
    tableHead = `<tr>
      <th class="th-num">#</th>
      <th class="th-name">Nama</th>
      <th class="th-email">Email</th>
      <th class="th-date">Tanggal</th>
      <th class="th-time">Masuk</th>
      <th class="th-time">Pulang</th>
      <th class="th-dur">Lama</th>
      <th class="th-status">St. Masuk</th>
      <th class="th-status">St. Pulang</th>
      <th class="th-dist">Jarak (m)</th>
    </tr>`;
    let i = 1;
    for (const r of rows) {
      const tgl = r.dateStr.split("-").reverse().join("/");
      const jm = r.ci ? formatTimeHM(r.ci) : "—";
      const jp = r.co ? formatTimeHM(r.co) : "—";
      const dur = formatDurationAtOffice(r.ci, r.co);
      const jarak = `${r.ciDist != null ? r.ciDist + "m" : "—"} / ${r.coDist != null ? r.coDist + "m" : "—"}`;
      const ciChip = r.ciStatus ? `<span class="report-chip chip-${r.ciStatus === "Hadir" ? "ok" : r.ciStatus === "Terlambat" ? "late" : "bad"}">${escapeHtml(r.ciStatus)}</span>` : "—";
      const coChip = r.coStatus ? `<span class="report-chip chip-${r.coStatus === "Hadir" ? "ok" : r.coStatus === "Terlambat" ? "late" : "bad"}">${escapeHtml(r.coStatus)}</span>` : "—";

      tableBody += `<tr>
        <td class="td-num">${i++}</td>
        <td class="td-name"><strong>${escapeHtml(r.displayName || "—")}</strong></td>
        <td class="td-email">${escapeHtml(r.email || "—")}</td>
        <td class="td-date">${tgl}</td>
        <td class="td-time">${jm}</td>
        <td class="td-time">${jp}</td>
        <td class="td-dur">${escapeHtml(dur)}</td>
        <td class="td-status">${ciChip}</td>
        <td class="td-status">${coChip}</td>
        <td class="td-dist">${escapeHtml(jarak)}</td>
      </tr>`;
    }
  } else {
    tableHead = `<tr>
      <th class="th-num">#</th>
      <th class="th-date">Tanggal</th>
      <th class="th-time">Masuk</th>
      <th class="th-time">Pulang</th>
      <th class="th-dur">Lama di Kantor</th>
      <th class="th-status">St. Masuk</th>
      <th class="th-status">St. Pulang</th>
      <th class="th-dist">Jarak (m)</th>
    </tr>`;
    let i = 1;
    for (const r of rows) {
      const tgl = r.dateStr.split("-").reverse().join("/");
      const jm = r.ci ? formatTimeHM(r.ci) : "—";
      const jp = r.co ? formatTimeHM(r.co) : "—";
      const dur = formatDurationAtOffice(r.ci, r.co);
      const jarak = `${r.ciDist != null ? r.ciDist + "m" : "—"} / ${r.coDist != null ? r.coDist + "m" : "—"}`;
      const ciChip = r.ciStatus ? `<span class="report-chip chip-${r.ciStatus === "Hadir" ? "ok" : r.ciStatus === "Terlambat" ? "late" : "bad"}">${escapeHtml(r.ciStatus)}</span>` : "—";
      const coChip = r.coStatus ? `<span class="report-chip chip-${r.coStatus === "Hadir" ? "ok" : r.coStatus === "Terlambat" ? "late" : "bad"}">${escapeHtml(r.coStatus)}</span>` : "—";

      tableBody += `<tr>
        <td class="td-num">${i++}</td>
        <td class="td-date">${tgl}</td>
        <td class="td-time">${jm}</td>
        <td class="td-time">${jp}</td>
        <td class="td-dur">${escapeHtml(dur)}</td>
        <td class="td-status">${ciChip}</td>
        <td class="td-status">${coChip}</td>
        <td class="td-dist">${escapeHtml(jarak)}</td>
      </tr>`;
    }
  }
  if (!tableBody) {
    tableBody = `<tr><td colspan="${colEmpty}" style="text-align:center;padding:20px;color:#64748b;">Tidak ada data absensi untuk periode ini.</td></tr>`;
  }

  const officeLine = escapeHtml(OFFICE.name || "Telkomsat Regional 6");
  const sub = subtitle ? `${escapeHtml(subtitle)}<br>` : "";
  const by = generatedBy ? ` · ${escapeHtml(generatedBy)}` : "";
  const isLandscape = mode === "admin";
  const innerClass = isLandscape ? "report-sheet-inner report-sheet-inner--admin" : "report-sheet-inner";

  return `
  <div class="${innerClass}" id="reportSheetInner">
    <div class="report-sheet__brand">
      <div class="report-sheet__brand-icon"><i class="fas fa-satellite-dish"></i></div>
      <div class="report-sheet__brand-text">
        <h1>AbsensiGeo</h1>
        <p>${officeLine} · Laporan Kehadiran Karyawan</p>
      </div>
    </div>
    <h2 class="report-sheet__title">Laporan Bulanan — ${escapeHtml(monthTitle)}</h2>
    <p class="report-sheet__meta">
      ${sub}
      Dibuat: ${escapeHtml(new Date().toLocaleString("id-ID", { dateStyle: "long", timeStyle: "short" }))}${by}
    </p>
    <div class="report-sheet__summary">
      <span>Baris (hari kerja): <strong>${rows.length}</strong></span>
      <span class="sum-ok">Hadir: ${nHadir}</span>
      <span class="sum-late">Terlambat: ${nLate}</span>
      <span class="sum-bad">Ditolak: ${nReject}</span>
    </div>
    <div class="report-table-wrap">
      <table class="report-table" border="1" cellpadding="6" cellspacing="0">
        <thead>${tableHead}</thead>
        <tbody>${tableBody}</tbody>
      </table>
    </div>
    <p class="report-footnote">
      Ringkasan per tanggal per orang (check-in pertama &amp; check-out terakhir hari itu). Dokumen dari sistem AbsensiGeo; arsip resmi administrasi.
    </p>
  </div>`;
}

function openReportModal() {
  const modal = document.getElementById("reportModal");
  if (!modal) return;
  modal.classList.add("report-modal--open");
  modal.setAttribute("aria-hidden", "false");
  const sheet = document.getElementById("reportPrintRoot");
  if (sheet) {
    sheet.scrollTop = 0;
    sheet.scrollLeft = 0;
  }
  const wrap = sheet?.querySelector(".report-table-wrap");
  if (wrap) {
    wrap.scrollLeft = 0;
  }
}

function closeReportModal() {
  const modal = document.getElementById("reportModal");
  if (!modal) return;
  modal.classList.remove("report-modal--open");
  modal.setAttribute("aria-hidden", "true");
}

async function fillAdminReportUserOptions() {
  const sel = document.getElementById("adminReportUser");
  if (!sel || currentRole !== "admin") return;
  const prev = sel.value;
  sel.innerHTML = '<option value="">Semua karyawan</option>';
  try {
    const snap = await getDocs(collection(db, "users"));
    const arr = [];
    snap.forEach(d => {
      const u = d.data();
      if (u.deleted === true || u.status === "nonaktif" || u.role === "nonaktif" || u.role === "deleted") return;
      arr.push({ uid: d.id, name: u.name || u.email || d.id, email: u.email || "" });
    });
    arr.sort((a, b) => a.name.localeCompare(b.name, "id"));
    for (const o of arr) {
      const opt = document.createElement("option");
      opt.value = o.uid;
      opt.textContent = o.email ? `${o.name} (${o.email})` : o.name;
      sel.appendChild(opt);
    }
    if (prev && [...sel.options].some(op => op.value === prev)) sel.value = prev;
  } catch (e) {
    console.error("fillAdminReportUserOptions:", e);
  }
}

async function runAdminMonthlyReport() {
  if (currentRole !== "admin") return;
  const ym = document.getElementById("adminReportMonth")?.value;
  const uid = document.getElementById("adminReportUser")?.value?.trim() || "";
  if (!ym) {
    showToast("Pilih bulan laporan.", "warning");
    return;
  }
  showLoader();
  try {
    await loadOfficeConfig();
    const docs = await fetchAttendanceDocsInMonth(ym, uid || null);
    let agg = aggregateAttendanceByDay(docs);
    agg.sort((a, b) => {
      if (a.dateStr !== b.dateStr) return b.dateStr.localeCompare(a.dateStr);
      return (a.displayName || a.email || "").localeCompare(b.displayName || b.email || "", "id");
    });
    const sel = document.getElementById("adminReportUser");
    const optLabel = uid && sel ? (sel.options[sel.selectedIndex]?.text || uid) : "Semua karyawan";
    const subtitle = uid ? `Cakupan: ${optLabel}` : "Cakupan: semua karyawan";
    const html = buildMonthlyReportInnerHtml({
      mode: "admin",
      ym,
      rows: agg,
      subtitle,
      generatedBy: currentProfile?.name || currentUser?.email || "Admin"
    });
    window.__reportPdfName = `laporan-absensi-${ym}${uid ? "-user" : "-semua"}`;
    window.__reportMode = "admin";
    window.__reportOrientation = "landscape";
    document.getElementById("reportPrintRoot").innerHTML = html;
    openReportModal();
    showToast("Laporan siap. Gunakan Cetak atau Unduh PDF.", "success");
  } catch (e) {
    console.error("runAdminMonthlyReport:", e);
    const msg = e.message || String(e);
    if (msg.includes("index") || e.code === "failed-precondition") {
      showToast("Butuh indeks Firestore untuk query bulanan. Deploy indeks (lihat firestore.indexes.json) dan tunggu hingga aktif.", "error");
    } else {
      showToast("Gagal memuat laporan: " + msg, "error");
    }
  } finally {
    hideLoader();
  }
}

async function runMyMonthlyReport() {
  if (!currentUser) return;
  const ym = document.getElementById("myReportMonth")?.value;
  if (!ym) {
    showToast("Pilih bulan laporan.", "warning");
    return;
  }
  showLoader();
  try {
    await loadOfficeConfig();
    const docs = await fetchAttendanceDocsInMonth(ym, currentUser.uid);
    let agg = aggregateAttendanceByDay(docs).filter(r => r.uid === currentUser.uid);
    agg.sort((a, b) => b.dateStr.localeCompare(a.dateStr));
    const html = buildMonthlyReportInnerHtml({
      mode: "self",
      ym,
      rows: agg,
      subtitle: `Karyawan: ${currentProfile?.name || currentUser.email}`,
      generatedBy: currentProfile?.name || currentUser.email
    });
    window.__reportPdfName = `laporan-absensi-saya-${ym}`;
    window.__reportMode = "self";
    window.__reportOrientation = "portrait";
    document.getElementById("reportPrintRoot").innerHTML = html;
    openReportModal();
    showToast("Laporan siap. Cetak atau unduh PDF untuk arsip Anda.", "success");
  } catch (e) {
    console.error("runMyMonthlyReport:", e);
    const msg = e.message || String(e);
    if (msg.includes("index") || e.code === "failed-precondition") {
      showToast("Butuh indeks Firestore. Deploy firestore.indexes.json (uid + date) lalu coba lagi.", "error");
    } else {
      showToast("Gagal memuat laporan: " + msg, "error");
    }
  } finally {
    hideLoader();
  }
}

function downloadReportAsPdf() {
  const el = document.getElementById("reportPrintRoot");
  const target = el?.querySelector(".report-sheet-inner");
  if (!el || !target) {
    showToast("Buka laporan terlebih dahulu (Buat laporan / Pratinjau).", "warning");
    return;
  }
  const w = typeof html2pdf !== "undefined" ? html2pdf : window.html2pdf;
  if (!w) {
    showToast("Library PDF tidak termuat. Gunakan Cetak lalu Pilih 'Simpan sebagai PDF'.", "warning");
    return;
  }
  const isLandscape = window.__reportOrientation === "landscape" || window.__reportMode === "admin";
  const name = (window.__reportPdfName || "laporan-absensi") + ".pdf";
  showLoader();

  // Clone elemen dengan styling khusus export PDF (identik dengan mode cetak)
  const exportNode = target.cloneNode(true);
  exportNode.classList.add("report-sheet-inner--pdf-export");
  const fullWidth = isLandscape ? "1060px" : "780px";

  exportNode.style.width = fullWidth;
  exportNode.style.minWidth = fullWidth;
  exportNode.style.maxWidth = fullWidth;
  exportNode.style.margin = "0";
  exportNode.style.padding = "0";
  exportNode.style.background = "#ffffff";
  exportNode.style.boxSizing = "border-box";
  exportNode.style.border = "none";
  exportNode.style.boxShadow = "none";
  exportNode.style.borderRadius = "0";

  // Pastikan tidak ada scrollbar atau overflow yang memotong kolom di sebelah kanan
  exportNode.querySelectorAll(".report-table-wrap").forEach(wrap => {
    wrap.style.overflow = "visible";
    wrap.style.width = "100%";
    wrap.style.maxWidth = "none";
    wrap.style.margin = "8px 0";
  });

  const table = exportNode.querySelector(".report-table");
  if (table) {
    table.style.width = "100%";
    table.style.maxWidth = "none";
    table.style.tableLayout = "auto";
    table.style.borderCollapse = "collapse";
    table.style.border = "1.5px solid #000000";
  }

  exportNode.querySelectorAll(".report-table th").forEach(th => {
    th.style.border = "1px solid #000000";
    th.style.background = "#1e293b";
    th.style.color = "#ffffff";
    th.style.padding = "5px 3px";
    th.style.fontSize = "7.5pt";
  });

  exportNode.querySelectorAll(".report-table td").forEach(td => {
    td.style.border = "1px solid #000000";
    td.style.color = "#000000";
    td.style.padding = "4px 3px";
    td.style.fontSize = "7.5pt";
  });

  exportNode.querySelectorAll(".report-chip").forEach(chip => {
    chip.style.border = "1px solid #000000";
    chip.style.fontSize = "6.5pt";
    chip.style.padding = "1px 4px";
  });

  const brand = exportNode.querySelector(".report-sheet__brand");
  if (brand) {
    brand.style.borderBottom = "2.5px solid #dc2626";
    brand.style.paddingBottom = "8px";
    brand.style.marginBottom = "10px";
  }

  // Wadah terisolasi untuk html2canvas (ditempatkan di bawah global loader yang sedang aktif)
  const container = document.createElement("div");
  container.style.position = "fixed";
  container.style.left = "0";
  container.style.top = "0";
  container.style.width = fullWidth;
  container.style.zIndex = "100";
  container.style.opacity = "1";
  container.style.pointerEvents = "none";
  container.style.background = "#ffffff";
  container.style.overflow = "visible";
  container.appendChild(exportNode);
  document.body.appendChild(container);

  w()
    .set({
      margin: isLandscape ? [6, 8, 6, 8] : [8, 8, 8, 8],
      filename: name,
      image: { type: "jpeg", quality: 0.98 },
      html2canvas: {
        scale: 2,
        useCORS: true,
        logging: false,
        letterRendering: true,
        scrollX: 0,
        scrollY: 0,
        windowWidth: isLandscape ? 1060 : 780
      },
      jsPDF: {
        unit: "mm",
        format: "a4",
        orientation: isLandscape ? "landscape" : "portrait"
      },
      pagebreak: { mode: ["avoid-all", "css", "legacy"] }
    })
    .from(exportNode)
    .save()
    .then(() => showToast("PDF berhasil diunduh.", "success"))
    .catch(err => {
      console.error("downloadReportAsPdf error:", err);
      showToast("Gagal PDF: " + (err.message || err), "error");
    })
    .finally(() => {
      try { container.remove(); } catch (_) {}
      hideLoader();
    });
}

// ═══════════════════════════════════════════════
// 18. KELOLA KARYAWAN (ADMIN)
// ═══════════════════════════════════════════════
window.loadUsers = async function() {
  if (currentRole !== "admin") return;
  const grid = document.getElementById("usersGrid");
  grid.innerHTML = `<div class="td-loading"><i class="fas fa-spinner fa-spin"></i> Memuat data karyawan...</div>`;
  try {
    const snap = await getDocs(collection(db, "users"));
    if (snap.empty) { grid.innerHTML = `<div class="td-loading">Belum ada data karyawan.</div>`; return; }
    grid.innerHTML = "";
    let renderedCount = 0;
    snap.forEach(d => {
      const u = d.data();
      const uid = d.id;
      if (u.deleted === true || u.status === "nonaktif" || u.role === "nonaktif" || u.role === "deleted") {
        return; // Lewati akun terhapus / nonaktif
      }
      renderedCount++;
      const isRowAdmin = String(u.role ?? u.Role ?? "").toLowerCase().trim() === "admin";
      const initials  = (u.name||u.email||"?").charAt(0).toUpperCase();
      const isSelf = uid === currentUser.uid;
      const roleBadge = isRowAdmin
        ? `<span class="badge badge-admin">Admin</span>`
        : `<span class="badge badge-karyawan">Karyawan</span>`;
      const card = document.createElement("div");
      card.className = "user-card";
      const nameSafe = u.name || u.email || "—";
      card.innerHTML = `
        <div class="user-avatar-sm">${initials}</div>
        <div class="user-card-info">
          <div class="user-card-name">${nameSafe}</div>
          <div class="user-card-email">${u.email || ""}</div>
          <div class="user-card-dept">${u.department || "Tidak ada departemen"}</div>
          <div class="user-card-actions">
            ${roleBadge}
            <button type="button" class="btn-icon btn-reset-pw" title="Kirim email reset password">
              <i class="fas fa-envelope"></i>
            </button>
            ${!isSelf && !isRowAdmin
              ? `<button type="button" class="btn-icon role-up" title="Jadikan Admin"><i class="fas fa-user-shield"></i></button>`
              : ""}
            ${!isSelf && isRowAdmin
              ? `<button type="button" class="btn-icon role-down" title="Jadikan Karyawan"><i class="fas fa-user"></i></button>`
              : ""}
            ${!isSelf
              ? `<button type="button" class="btn-icon del" title="Hapus akun (login + data)">
                   <i class="fas fa-trash-alt"></i>
                 </button>`
              : ""}
          </div>
        </div>`;
      const btnMail = card.querySelector(".btn-reset-pw");
      if (btnMail && u.email) {
        btnMail.addEventListener("click", () => sendUserPasswordReset(u.email));
      }
      const btnUp = card.querySelector(".role-up");
      if (btnUp) btnUp.addEventListener("click", () => setUserRole(uid, nameSafe, "admin"));
      const btnDown = card.querySelector(".role-down");
      if (btnDown) btnDown.addEventListener("click", () => setUserRole(uid, nameSafe, "karyawan"));
      const btnDel = card.querySelector(".btn-icon.del");
      if (btnDel) btnDel.addEventListener("click", () => deleteUserRecord(uid, nameSafe, u.email));
      grid.appendChild(card);
    });
    if (renderedCount === 0) {
      grid.innerHTML = `<div class="td-loading">Belum ada data karyawan aktif.</div>`;
    }
  } catch (e) {
    console.error("loadUsers:", e);
    grid.innerHTML = `<div class="td-loading" style="color:red;">Error: ${e.message}</div>`;
  }
};

window.sendUserPasswordReset = async function(email) {
  if (!email) return;
  try {
    await sendPasswordResetEmail(auth, email);
    showToast(`Email reset password dikirim ke ${email}`, "success");
  } catch (e) {
    console.error(e);
    showToast(e.code === "auth/too-many-requests" ? "Terlalu banyak permintaan. Coba lagi nanti." : e.message, "error");
  }
};

window.setUserRole = function(uid, displayName, role) {
  if (uid === currentUser.uid) {
    showToast("Tidak dapat mengubah role akun sendiri di sini.", "warning");
    return;
  }
  const label = role === "admin" ? "Admin" : "Karyawan";
  askConfirm(
    "Ubah Role Pengguna",
    `Ubah "${displayName}" menjadi ${label}?`,
    async () => {
      showLoader();
      try {
        await setDoc(doc(db, "users", uid), { role }, { merge: true });
        showToast(`Role diperbarui menjadi ${label}.`, "success");
        loadUsers();
      } catch (e) {
        showToast("Gagal: " + e.message, "error");
      } finally {
        hideLoader();
      }
    }
  );
};

window.deleteUserRecord = function(docId, name, email) {
  if (!docId) {
    showToast("ID pengguna tidak valid.", "error");
    return;
  }
  if (docId === currentUser?.uid) {
    showToast("Tidak dapat menghapus akun Anda sendiri.", "warning");
    return;
  }

  const emailInfo = email ? ` (${email})` : "";
  askConfirm(
    "Hapus Pengguna",
    `Hapus pengguna "${name}"${emailInfo} dari sistem? Data profil karyawan akan dihapus dan akun tidak dapat mengakses absensi lagi.`,
    async () => {
      showLoader();
      let deleteSuccess = false;

      // 1. Coba hapus dokumen langsung dari Firestore 'users'
      try {
        await deleteDoc(doc(db, "users", docId));
        deleteSuccess = true;
      } catch (delDocErr) {
        console.warn("deleteDoc gagal (kemungkinan aturan Firestore tidak mengizinkan delete), mencoba update status (soft-delete):", delDocErr);
        // Fallback jika Firestore rules memblokir deleteDoc: tandai deleted di dokumen
        try {
          await setDoc(doc(db, "users", docId), {
            deleted: true,
            status: "nonaktif",
            role: "nonaktif",
            deletedAt: serverTimestamp(),
            deletedBy: currentUser?.email || currentUser?.uid
          }, { merge: true });
          deleteSuccess = true;
        } catch (setErr) {
          console.error("Soft-delete juga gagal:", setErr);
        }
      }

      // 2. Simpan ke koleksi 'deleted_accounts' agar akun langsung diblokir jika mencoba login
      try {
        await setDoc(doc(db, "deleted_accounts", docId), {
          uid: docId,
          name: name || "",
          email: email || "",
          deletedAt: serverTimestamp(),
          deletedBy: currentUser?.email || currentUser?.uid
        });
      } catch (_) {}

      // 3. Panggil Cloud Function deleteAuthUser jika ada (dengan timeout 3 detik agar tidak menggantung UI)
      try {
        const deleteAuthUser = httpsCallable(functions, "deleteAuthUser");
        await Promise.race([
          deleteAuthUser({ uid: docId }),
          new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 3000))
        ]);
      } catch (cfErr) {
        // Abaikan jika Cloud Function belum di-deploy atau timeout
        console.warn("Cloud Function deleteAuthUser tidak aktif / timeout:", cfErr.message || cfErr);
      }

      hideLoader();

      if (deleteSuccess) {
        showToast(`Pengguna "${name}" berhasil dihapus dari sistem!`, "success");
        loadUsers();
      } else {
        showToast(`Gagal menghapus pengguna "${name}". Periksa izin Firestore.`, "error");
      }
    }
  );
};

// Tambah User (Server-side tidak bisa buat Auth user dari client)
// Solusi: Buat akun lalu simpan profil di Firestore
document.getElementById("addUserForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name  = document.getElementById("newUserName").value.trim();
  const email = document.getElementById("newUserEmail").value.trim();
  const pass  = document.getElementById("newUserPassword").value;
  const dept  = document.getElementById("newUserDept").value.trim();
  const role  = document.getElementById("newUserRole").value;

  if (pass.length < 6) { showToast("Password minimal 6 karakter!", "warning"); return; }

  const btn = document.getElementById("btnAddUser");
  btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Memproses...`;
  btn.disabled  = true;

  // Simpan auth admin sementara
  const adminEmail = currentUser.email;
  const adminPass  = prompt(`Untuk keamanan, masukkan password Admin Anda (${adminEmail}):`, "");
  if (!adminPass) { btn.innerHTML = `<i class="fas fa-plus"></i> Tambahkan Akun`; btn.disabled = false; return; }

  try {
    // Buat Auth account
    const cred = await createUserWithEmailAndPassword(auth, email, pass);
    const newUid = cred.user.uid;

    // Simpan profil ke Firestore
    await setDoc(doc(db, "users", newUid), {
      uid: newUid, name, email, department: dept, role,
      createdBy: currentUser.uid,
      createdAt: serverTimestamp()
    });

    // Bersihkan dari daftar deleted_accounts jika sebelumnya pernah dihapus
    try {
      await deleteDoc(doc(db, "deleted_accounts", newUid));
    } catch (_) {}

    showToast(`Akun "${name}" berhasil dibuat!`, "success");
    document.getElementById("addUserForm").reset();

    // Re-login sebagai admin
    await signOut(auth);
    await signInWithEmailAndPassword(auth, adminEmail, adminPass);
    loadUsers();
  } catch (err) {
    console.error("addUser error:", err);
    let msg = "Gagal membuat akun: " + err.code;
    if (err.code === "auth/email-already-in-use") msg = "Email sudah terdaftar!";
    if (err.code === "auth/invalid-email")        msg = "Format email tidak valid!";
    showToast(msg, "error");
    // Jika sempat logout, login ulang admin
    try { await signInWithEmailAndPassword(auth, adminEmail, adminPass); } catch (_) {}
  } finally {
    btn.innerHTML = `<i class="fas fa-plus"></i> Tambahkan Akun`;
    btn.disabled  = false;
  }
});

document.getElementById("changePasswordForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const cur    = document.getElementById("currentPassword").value;
  const newP   = document.getElementById("newPassword").value;
  const conf   = document.getElementById("confirmNewPassword").value;
  if (newP !== conf) { showToast("Password baru dan konfirmasi tidak cocok.", "warning"); return; }
  if (newP.length < 6) { showToast("Password baru minimal 6 karakter.", "warning"); return; }
  const btn = document.getElementById("btnChangePassword");
  btn.disabled = true;
  btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Menyimpan...`;
  try {
    const cred = EmailAuthProvider.credential(currentUser.email, cur);
    await reauthenticateWithCredential(currentUser, cred);
    await updatePassword(currentUser, newP);
    showToast("Password akun Anda berhasil diubah.", "success");
    e.target.reset();
  } catch (err) {
    console.error(err);
    let msg = err.message;
    if (err.code === "auth/wrong-password" || err.code === "auth/invalid-credential") msg = "Password saat ini salah.";
    if (err.code === "auth/weak-password") msg = "Password terlalu lemah.";
    showToast(msg, "error");
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<i class="fas fa-floppy-disk"></i> Simpan Password Baru`;
  }
});

// ═══════════════════════════════════════════════
// 19. UPDATE DASHBOARD GEO INFO (dynamic)
// ═══════════════════════════════════════════════
function updateDashboardGeoInfo() {
  const workLine = `${WORK_START} — ${WORK_END} WIB (toleransi terlambat +${LATE_GRACE_MIN} menit)`;
  const dashWh = document.getElementById("dashWorkHoursLine");
  if (dashWh) dashWh.textContent = workLine;
  const rows = document.querySelectorAll(".geo-info-row");
  rows.forEach(row => {
    const k = row.querySelector(".geo-k");
    const v = row.querySelector(".geo-v, .geo-v-highlight");
    if (!k || !v) return;
    const key = k.textContent.trim();
    if (key === "Kantor")     v.textContent = OFFICE.name || "Telkomsat Regional 6";
    if (key === "Koordinat") v.textContent = `${OFFICE.lat.toFixed(4)}°N, ${OFFICE.lng.toFixed(4)}°E`;
    if (key === "Radius")     v.textContent = `${RADIUS_M} Meter`;
    if (key === "Jam Kerja")  v.textContent = workLine;
  });
}

// ═══════════════════════════════════════════════
// 20. GEO SETTINGS VIEW (ADMIN)
// ═══════════════════════════════════════════════
let settingsMap     = null;
let settingsPinMarker = null;
let settingsCircle  = null;
let settingsOfficeMark = null;
let pendingLat = null;
let pendingLng = null;
let geoSettingsListenersBound = false;
let lastGeoSearchAt = 0;

function geoSearchOutsideClose(e) {
  const wrap = document.querySelector(".geo-map-search");
  const box = document.getElementById("geoSearchResults");
  if (!wrap || !box || box.hidden) return;
  if (!wrap.contains(e.target)) box.hidden = true;
}

function renderGeoSearchResults(items) {
  const box = document.getElementById("geoSearchResults");
  if (!box) return;
  box.innerHTML = "";
  if (!items.length) {
    box.innerHTML = '<div class="geo-search-empty">Tidak ada hasil. Coba kata kunci lain.</div>';
    box.hidden = false;
    return;
  }
  items.forEach((item) => {
    const lat = parseFloat(item.lat);
    const lon = parseFloat(item.lon);
    if (Number.isNaN(lat) || Number.isNaN(lon)) return;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "geo-search-item";
    btn.textContent = item.display_name || `${lat}, ${lon}`;
    btn.addEventListener("click", () => {
      setPinOnSettingsMap(lat, lon);
      if (settingsMap) settingsMap.setView([lat, lon], 17);
      const nameEl = document.getElementById("inputOfficeName");
      if (nameEl && !nameEl.value.trim()) {
        const short = (item.display_name || "").split(",")[0].trim();
        if (short) nameEl.value = short.slice(0, 120);
      }
      box.hidden = true;
      box.innerHTML = "";
    });
    box.appendChild(btn);
  });
  box.hidden = false;
}

async function runGeoSearch() {
  const input = document.getElementById("geoSearchInput");
  const box = document.getElementById("geoSearchResults");
  if (!input || !box) return;
  const q = input.value.trim();
  if (!q) {
    showToast("Ketik nama jalan, kota, atau gedung untuk dicari.", "warning");
    return;
  }
  const now = Date.now();
  if (now - lastGeoSearchAt < 1000) {
    showToast("Tunggu sebentar sebelum mencari lagi.", "info");
    return;
  }
  lastGeoSearchAt = now;
  box.innerHTML = '<div class="geo-search-empty">Mencari…</div>';
  box.hidden = false;
  try {
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=8&q=${encodeURIComponent(q)}`;
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(String(res.status));
    const data = await res.json();
    renderGeoSearchResults(Array.isArray(data) ? data : []);
  } catch (err) {
    console.error("runGeoSearch", err);
    box.innerHTML = '<div class="geo-search-empty">Gagal memuat hasil. Periksa koneksi atau coba lagi.</div>';
    box.hidden = false;
  }
}

let isFetchingCurrentLoc = false;

function useCurrentLocationForGeofence() {
  if (isFetchingCurrentLoc) return;
  if (!navigator.geolocation) {
    showToast("Browser Anda tidak mendukung fitur geolokasi GPS.", "error");
    return;
  }

  const btnLoc = document.getElementById("btnGeoCurrentLocation");
  const btnLocForm = document.getElementById("btnGeoCurrentLocationForm");

  const setButtonsLoading = (loading) => {
    isFetchingCurrentLoc = loading;
    if (btnLoc) {
      btnLoc.disabled = loading;
      btnLoc.innerHTML = loading
        ? '<i class="fas fa-spinner fa-spin"></i> Mendeteksi...'
        : '<i class="fas fa-location-crosshairs"></i> Lokasi Saat Ini';
    }
    if (btnLocForm) {
      btnLocForm.disabled = loading;
      btnLocForm.innerHTML = loading
        ? '<i class="fas fa-spinner fa-spin"></i> Mendeteksi...'
        : '<i class="fas fa-location-crosshairs"></i> Gunakan Lokasi Saat Ini';
    }
  };

  setButtonsLoading(true);
  showToast("Sedang mendeteksi lokasi perangkat saat ini...", "info");

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      setButtonsLoading(false);
      const lat = pos.coords.latitude;
      const lng = pos.coords.longitude;
      const accuracy = Math.round(pos.coords.accuracy || 0);

      setPinOnSettingsMap(lat, lng);
      if (settingsMap) {
        settingsMap.setView([lat, lng], 17);
      }

      // Bila nama kantor kosong, bantu ambil nama lokasi dari OpenStreetMap Nominatim
      const nameEl = document.getElementById("inputOfficeName");
      if (nameEl && !nameEl.value.trim()) {
        fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}`, {
          headers: { Accept: "application/json" }
        })
          .then((r) => r.json())
          .then((d) => {
            if (d && d.display_name && !nameEl.value.trim()) {
              const short = d.display_name.split(",")[0].trim();
              if (short) nameEl.value = short.slice(0, 120);
            }
          })
          .catch(() => {});
      }

      showToast(`Lokasi saat ini berhasil disetel (Akurasi: ±${accuracy}m)`, "success");
    },
    (err) => {
      setButtonsLoading(false);
      console.error("useCurrentLocationForGeofence error:", err);
      let msg = "Gagal mendeteksi lokasi saat ini.";
      if (err.code === 1) {
        msg = "Izin akses lokasi ditolak oleh browser.";
      } else if (err.code === 2) {
        msg = "Sinyal GPS / posisi perangkat tidak tersedia.";
      } else if (err.code === 3) {
        msg = "Waktu permintaan lokasi GPS habis. Silakan coba lagi.";
      }
      showToast(msg, "error");
    },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
  );
}

async function initGeoSettingsView() {
  await loadOfficeConfig();
  populateGeoForm();
  renderSavedConfig();

  if (!settingsMap) {
    settingsMap = L.map("settingsMap", { zoomControl: true }).setView([OFFICE.lat, OFFICE.lng], 16);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19, attribution: "© OpenStreetMap"
    }).addTo(settingsMap);

    settingsMap.on("click", (e) => {
      const { lat, lng } = e.latlng;
      setPinOnSettingsMap(lat, lng);
    });

    // Kontrol tombol lokasi saat ini di pojok kiri atas Leaflet map
    const LocControl = L.Control.extend({
      options: { position: "topleft" },
      onAdd: function() {
        const div = L.DomUtil.create("div", "leaflet-bar leaflet-control");
        const a = L.DomUtil.create("a", "leaflet-control-locate-btn", div);
        a.href = "#";
        a.title = "Gunakan Lokasi Saat Ini";
        a.innerHTML = '<i class="fas fa-location-crosshairs"></i>';
        L.DomEvent.disableClickPropagation(div);
        L.DomEvent.on(a, "click", (e) => {
          L.DomEvent.preventDefault(e);
          useCurrentLocationForGeofence();
        });
        return div;
      }
    });
    new LocControl().addTo(settingsMap);
  } else {
    settingsMap.invalidateSize();
  }

  drawSettingsMapOverlay(OFFICE.lat, OFFICE.lng, RADIUS_M);

  if (!geoSettingsListenersBound) {
    document.getElementById("inputLat").addEventListener("input", syncManualInputToMap);
    document.getElementById("inputLng").addEventListener("input", syncManualInputToMap);
    document.getElementById("inputRadius").addEventListener("input", syncRadiusCircle);
    const geoInput = document.getElementById("geoSearchInput");
    const geoBtn = document.getElementById("btnGeoSearch");
    if (geoInput && geoBtn) {
      geoBtn.addEventListener("click", () => runGeoSearch());
      geoInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          runGeoSearch();
        }
      });
    }
    document.getElementById("btnGeoCurrentLocation")?.addEventListener("click", useCurrentLocationForGeofence);
    document.getElementById("btnGeoCurrentLocationForm")?.addEventListener("click", useCurrentLocationForGeofence);
    document.addEventListener("click", geoSearchOutsideClose, true);
    geoSettingsListenersBound = true;
  }
}

function populateGeoForm() {
  document.getElementById("inputLat").value    = OFFICE.lat;
  document.getElementById("inputLng").value    = OFFICE.lng;
  document.getElementById("inputRadius").value = RADIUS_M;
  document.getElementById("inputOfficeName").value = OFFICE.name || "Telkomsat Regional 6";
  const ws = document.getElementById("inputWorkStart");
  const we = document.getElementById("inputWorkEnd");
  const wg = document.getElementById("inputLateGrace");
  if (ws) ws.value = WORK_START.slice(0, 5);
  if (we) we.value = WORK_END.slice(0, 5);
  if (wg) wg.value = LATE_GRACE_MIN;
  pendingLat = OFFICE.lat;
  pendingLng = OFFICE.lng;
  document.getElementById("pinLatDisplay").textContent = OFFICE.lat.toFixed(6);
  document.getElementById("pinLngDisplay").textContent = OFFICE.lng.toFixed(6);
}

async function renderSavedConfig() {
  try {
    const snap = await getDoc(doc(db, "settings", "geofence"));
    const setGc = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.textContent = val;
    };
    if (snap.exists()) {
      const d = snap.data();
      setGc("gcName", d.name || "—");
      setGc("gcLat", d.lat != null ? String(d.lat) : "—");
      setGc("gcLng", d.lng != null ? String(d.lng) : "—");
      setGc("gcRadius", d.radius ? d.radius + " m" : "— m");
      setGc("gcWorkStart", d.workStart || WORK_START);
      setGc("gcWorkEnd", d.workEnd || WORK_END);
      setGc("gcLateGrace", typeof d.lateGraceMinutes === "number" ? d.lateGraceMinutes + " menit" : LATE_GRACE_MIN + " menit");
      setGc("gcUpdater", d.updatedBy || "—");
    } else {
      setGc("gcName", OFFICE.name);
      setGc("gcLat", String(OFFICE.lat));
      setGc("gcLng", String(OFFICE.lng));
      setGc("gcRadius", RADIUS_M + " m");
      setGc("gcWorkStart", WORK_START);
      setGc("gcWorkEnd", WORK_END);
      setGc("gcLateGrace", LATE_GRACE_MIN + " menit");
      setGc("gcUpdater", "Default");
    }
  } catch (e) { console.error("renderSavedConfig:", e); }
}

function setPinOnSettingsMap(lat, lng) {
  pendingLat = lat;
  pendingLng = lng;

  // Update form inputs
  document.getElementById("inputLat").value = lat.toFixed(6);
  document.getElementById("inputLng").value = lng.toFixed(6);
  document.getElementById("pinLatDisplay").textContent = lat.toFixed(6);
  document.getElementById("pinLngDisplay").textContent = lng.toFixed(6);

  // Update / create animated pin marker
  if (settingsPinMarker) settingsMap.removeLayer(settingsPinMarker);
  settingsPinMarker = L.marker([lat, lng], {
    icon: L.divIcon({
      className: "settings-pin-marker",
      html: `<div style="background:var(--red-600);color:#fff;width:34px;height:34px;border-radius:50%;
                    display:flex;align-items:center;justify-content:center;font-size:16px;
                    border:3px solid #fff;box-shadow:0 4px 16px rgba(220,38,38,.5);">
               <i class="fas fa-map-pin"></i></div>`,
      iconSize: [34, 34], iconAnchor: [17, 17]
    })
  }).addTo(settingsMap)
    .bindPopup(`<b>Titik Kantor Baru</b><br>${lat.toFixed(6)}, ${lng.toFixed(6)}`).openPopup();

  // Update radius circle
  const radius = parseInt(document.getElementById("inputRadius").value) || RADIUS_M;
  drawSettingsMapOverlay(lat, lng, radius);
}

function drawSettingsMapOverlay(lat, lng, radius) {
  if (settingsOfficeMark) settingsMap.removeLayer(settingsOfficeMark);
  if (settingsCircle)     settingsMap.removeLayer(settingsCircle);

  settingsCircle = L.circle([lat, lng], {
    radius, color: "#dc2626", fillColor: "#dc2626", fillOpacity: .12,
    weight: 2, dashArray: "8 4"
  }).addTo(settingsMap);
}

function syncManualInputToMap() {
  const lat = parseFloat(document.getElementById("inputLat").value);
  const lng = parseFloat(document.getElementById("inputLng").value);
  if (!isNaN(lat) && !isNaN(lng) &&
      lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
    setPinOnSettingsMap(lat, lng);
    settingsMap.setView([lat, lng], settingsMap.getZoom());
  }
}

function syncRadiusCircle() {
  const lat    = parseFloat(document.getElementById("inputLat").value);
  const lng    = parseFloat(document.getElementById("inputLng").value);
  const radius = parseInt(document.getElementById("inputRadius").value);
  if (!isNaN(lat) && !isNaN(lng) && !isNaN(radius) && radius > 0) {
    drawSettingsMapOverlay(lat, lng, radius);
  }
}

// Simpan ke Firestore
document.getElementById("btnSaveGeoSettings").addEventListener("click", async () => {
  const lat    = parseFloat(document.getElementById("inputLat").value);
  const lng    = parseFloat(document.getElementById("inputLng").value);
  const radius = parseInt(document.getElementById("inputRadius").value);
  const name   = document.getElementById("inputOfficeName").value.trim() || "Telkomsat Regional 6";

  if (isNaN(lat) || isNaN(lng)) { showToast("Koordinat tidak valid!", "warning"); return; }
  if (lat < -90 || lat > 90)    { showToast("Latitude harus antara -90 dan 90!", "warning"); return; }
  if (lng < -180 || lng > 180)  { showToast("Longitude harus antara -180 dan 180!", "warning"); return; }
  if (isNaN(radius) || radius < 10) { showToast("Radius minimal 10 meter!", "warning"); return; }

  const workStartEl = document.getElementById("inputWorkStart");
  const workEndEl   = document.getElementById("inputWorkEnd");
  const graceEl     = document.getElementById("inputLateGrace");
  let workStart = (workStartEl?.value || WORK_START).trim();
  let workEnd   = (workEndEl?.value || WORK_END).trim();
  if (workStart.length === 5) workStart += ":00";
  if (workEnd.length === 5)   workEnd += ":00";
  const lateGrace = parseInt(graceEl?.value, 10);
  if (Number.isNaN(lateGrace) || lateGrace < 0 || lateGrace > 120) {
    showToast("Toleransi terlambat: 0–120 menit.", "warning");
    return;
  }

  askConfirm(
    "Simpan Perubahan Geofence",
    `Simpan lokasi & jam kerja?\n📍 ${name}\n🌐 ${lat.toFixed(6)}, ${lng.toFixed(6)}\n🎯 Radius: ${radius}m\n🕐 ${workStart.slice(0, 5)} — ${workEnd.slice(0, 5)} (+${lateGrace} mnt)`,
    async () => {
      showLoader();
      try {
        await setDoc(doc(db, "settings", "geofence"), {
          lat, lng, radius, name,
          workStart: workStart.slice(0, 5),
          workEnd: workEnd.slice(0, 5),
          lateGraceMinutes: lateGrace,
          updatedBy: currentProfile?.name || currentUser.email,
          updatedAt: serverTimestamp()
        });

        OFFICE   = { lat, lng, name };
        RADIUS_M = radius;
        WORK_START = workStart.slice(0, 5);
        WORK_END = workEnd.slice(0, 5);
        LATE_GRACE_MIN = lateGrace;

        // Reset peta absensi agar reload koordinat baru
        if (map) {
          map.remove();
          map = null; officeMarker = null; userMarker = null; geoCircle = null;
        }

        updateDashboardGeoInfo();
        renderSavedConfig();
        showToast(`Pengaturan tersimpan: lokasi, radius, dan jam kerja ${WORK_START}–${WORK_END}.`, "success");
      } catch (e) {
        console.error("saveGeoSettings:", e);
        showToast("Gagal menyimpan: " + e.message, "error");
      } finally { hideLoader(); }
    }
  );
});

// Reset form ke konfigurasi tersimpan
document.getElementById("btnResetGeoForm").addEventListener("click", () => {
  populateGeoForm();
  if (settingsMap) {
    drawSettingsMapOverlay(OFFICE.lat, OFFICE.lng, RADIUS_M);
    settingsMap.setView([OFFICE.lat, OFFICE.lng], 16);
    if (settingsPinMarker) { settingsMap.removeLayer(settingsPinMarker); settingsPinMarker = null; }
    document.getElementById("pinLatDisplay").textContent = OFFICE.lat.toFixed(6);
    document.getElementById("pinLngDisplay").textContent = OFFICE.lng.toFixed(6);
  }
  showToast("Form direset ke konfigurasi yang tersimpan.", "success");
});

// ═══════════════════════════════════════════════
// 21. LAPORAN — tombol modal
// ═══════════════════════════════════════════════
document.getElementById("btnReportClose")?.addEventListener("click", closeReportModal);
document.getElementById("reportModalBackdrop")?.addEventListener("click", closeReportModal);
document.getElementById("btnReportPrint")?.addEventListener("click", () => window.print());
document.getElementById("btnReportPdf")?.addEventListener("click", downloadReportAsPdf);
document.getElementById("btnAdminReportPreview")?.addEventListener("click", runAdminMonthlyReport);
document.getElementById("btnMyReportPreview")?.addEventListener("click", runMyMonthlyReport);

// ═══════════════════════════════════════════════
// 22. INIT
// ═══════════════════════════════════════════════
spawnDots();

