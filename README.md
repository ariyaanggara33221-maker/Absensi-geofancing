# AbsensiGeo — Sistem Absensi Berbasis Geofencing

Aplikasi web absensi untuk **Telkomsat Regional 6**. Karyawan **Check In / Check Out** memakai **GPS**; jarak ke titik kantor dihitung dengan **Haversine**. Dalam **radius** kantor → absensi bisa **Hadir** atau **Terlambat** (tergantung jam); di luar radius → **Ditolak**. **Admin** mengatur kantor di peta, jam kerja, melihat semua data, **mencetak/unduh laporan bulanan**, dan mengelola akun.

---

## Apa itu aplikasi ini? (ringkas)

| Pihak | Yang dilakukan di web |
|--------|------------------------|
| **Karyawan** | Login → lihat dashboard → absensi di halaman **Absensi** (harus izin lokasi) → lihat **Riwayat Saya** → **cetak / unduh PDF laporan bulanan pribadi** untuk arsip. |
| **Admin** | Semua di atas + **Semua Absensi** (filter + **laporan bulanan** semua orang atau satu karyawan) + **Kelola Karyawan** + **Pengaturan Geofence** (peta, radius, jam kerja). |

**Inti teknis:** data login di **Firebase Authentication**, data absensi & pengaturan di **Cloud Firestore**. Tidak ada server aplikasi wajib kecuali jika Anda pakai **Cloud Functions** untuk hapus akun lengkap.

---

## Isi dokumen

1. [Ringkasan fitur](#1-ringkasan-fitur)  
2. [Alur pakai langkah demi langkah](#2-alur-pakai-langkah-demi-langkah)  
3. [Laporan bulanan (cetak & PDF)](#3-laporan-bulanan-cetak--pdf)  
4. [Indeks Firestore (wajib untuk beberapa fitur)](#4-indeks-firestore-wajib-untuk-beberapa-fitur)  
5. [Teknologi](#5-teknologi)  
6. [Struktur folder](#6-struktur-folder)  
7. [Skema data Firestore](#7-skema-data-firestore)  
8. [Persiapan, `.env`, menjalankan & deploy](#8-persiapan-env-menjalankan--deploy)  
9. [Geofencing & Haversine](#9-geofencing--haversine)  
10. [Cloud Functions & hapus akun](#10-cloud-functions--hapus-akun)  
11. [Tampilan mobile & menu](#11-tampilan-mobile--menu)  
12. [Ringkasan perintah](#12-ringkasan-perintah)  

---

## 1. Ringkasan fitur

| Fitur | Karyawan | Admin |
|--------|:--------:|:-----:|
| Dashboard & status hari ini | ✓ | ✓ |
| Absensi GPS + peta Leaflet | ✓ | ✓ |
| Riwayat (satu baris = satu tanggal kerja) | ✓ | — |
| **Laporan bulanan cetak / PDF** | ✓ (data sendiri) | ✓ (semua / per orang) |
| Semua absensi + filter tanggal/nama | — | ✓ |
| Kelola user, role, reset password email | — | ✓ |
| Geofence: peta, cari alamat (Nominatim), radius, jam kerja | — | ✓ |
| Tema UI berbeda (admin / karyawan) | — | ✓ |

---

## 2. Alur pakai langkah demi langkah

### Karyawan

1. Buka URL aplikasi (Hosting Firebase atau `npm run dev` saat development).  
2. **Login** dengan email & password.  
3. **Dashboard:** jam masuk/pulang hari ini, statistik ringkas.  
4. **Absensi:** izinkan **lokasi** → tombol perbarui GPS → dalam radius kantor bisa **Check In** / **Check Out**.  
5. **Riwayat Saya:** tabel ringkasan per hari; pilih **bulan** lalu **Pratinjau / Cetak / PDF** untuk laporan sendiri.  
6. **Keluar** lewat menu sidebar.

### Admin

1. Login dengan akun yang di Firestore punya **`role: admin`** pada dokumen **`users/{UID}`** (UID = ID di Authentication).  
2. **Semua Absensi:** filter per tanggal atau nama; di bawahnya **laporan bulanan** — pilih bulan, opsional satu karyawan, **Buat laporan**.  
3. **Kelola Karyawan:** tambah akun, ubah role admin/karyawan, email reset password, hapus user (butuh Functions jika ingin hapus dari Authentication sekaligus).  
4. **Pengaturan Geofence:** tentukan titik kantor (lokasi saat ini / cari alamat / klik peta / koordinat), radius, nama kantor, jam kerja, toleransi terlambat → **Simpan**.  

---

## 3. Laporan bulanan (cetak & PDF)

- **Karyawan:** menu **Riwayat Saya** → pilih **bulan** (input bulan) → **Pratinjau / Cetak / PDF** → modal berisi tabel ringkasan (satu baris per hari kerja untuk akun Anda).  
- **Admin:** menu **Semua Absensi** → kartu **Laporan absensi bulanan** → pilih **bulan**, **Cakupan** (*Semua karyawan* atau satu nama) → **Buat laporan**.  

Di modal:

- **Cetak** membuka dialog printer browser (bisa pilih **Simpan sebagai PDF**).  
- **Unduh PDF** memakai library **html2pdf.js** (file PDF langsung).  

Laporan memakai field Firestore **`date`** (format `YYYY-MM-DD`) pada setiap dokumen absensi. Data lama yang **tidak** punya field `date` **tidak** ikut filter bulan.

---

## 4. Indeks Firestore (wajib untuk beberapa fitur)

File **`firestore.indexes.json`** mendefinisikan indeks **komposit** untuk koleksi **`attendance`**:

| Indeks | Field | Untuk apa |
|--------|--------|-----------|
| 1 | `uid` ↑, `timestamp` ↓ | Query admin/feed dengan urutan waktu (jika dipakai di kode). |
| 2 | `uid` ↑, `date` ↑ | **Laporan bulanan per karyawan** (`uid` + rentang `date`). |

**Setelah mengubah file indeks, deploy:**

```bash
firebase deploy --only firestore:indexes
```

Lalu di **Firebase Console → Firestore → Indexes** tunggu status indeks menjadi **Enabled** (bukan *Building*). Baru query laporan per orang bebas error.

> Tanpa indeks ke-2, laporan **semua karyawan** per bulan (hanya filter `date`) biasanya tetap jalan; laporan **satu karyawan** per bulan membutuhkan indeks **`uid` + `date`**.

---

## 5. Teknologi

- **Frontend:** HTML, CSS, JavaScript (ES modules), **Vite** (dev + build ke `dist/`).  
- **Firebase:** Authentication (email/password), Firestore.  
- **Peta:** Leaflet + tile OpenStreetMap.  
- **Pencarian alamat (admin):** Nominatim (OSM).  
- **PDF laporan:** html2pdf.js (CDN di `index.html`).  
- **Opsional:** Cloud Functions gen 1 (`functions/`) — callable **`deleteAuthUser`**.  
- **SDK Firebase di klien:** diimpor dari CDN di `app.js` (bukan paket npm untuk SDK utama).

---

## 6. Struktur folder

```
web ari/
├── index.html              # UI: login, sidebar, semua halaman view, modal laporan
├── app.js                  # Seluruh logika aplikasi
├── style.css               # Gaya + tema admin/karyawan + print laporan
├── firebase.json           # Hosting, Firestore indexes path, Functions
├── firestore.indexes.json  # Definisi indeks komposit
├── package.json
├── .env                    # Kunci Vite (jangan di-commit)
├── README.md
├── dist/                   # Output `npm run build` → di-deploy ke Hosting
└── functions/
    ├── index.js            # deleteAuthUser (Admin SDK)
    └── package.json
```

---

## 7. Skema data Firestore

| Path / koleksi | Penjelasan |
|----------------|------------|
| **`users/{uid}`** | `name`, `email`, `department`, `role` (`admin` / `karyawan`). ID dokumen = UID Authentication. |
| **`attendance`** | Satu dokumen per tap: `uid`, `type` (Check In / Check Out), `status`, **`date`** (YYYY-MM-DD), `timestamp`, `distanceMeters`, `lat`, `lng`, nama/email, dll. |
| **`settings/geofence`** | `lat`, `lng`, `radius`, `name`, `workStart`, `workEnd`, `lateGraceMinutes`, info pembaruan. |

---

## 8. Persiapan, `.env`, menjalankan & deploy

1. Install **Node.js** (LTS).  
2. Install **Firebase CLI:** `npm install -g firebase-tools` → `firebase login`.  
3. Pastikan **`.firebaserc`** memakai **project ID** yang benar.  
4. Di Firebase Console: aktifkan **Authentication (Email/Password)** dan buat database **Firestore**.  
5. Buat **`.env`** di root:

```env
VITE_FIREBASE_API_KEY=...
VITE_FIREBASE_AUTH_DOMAIN=...
VITE_FIREBASE_PROJECT_ID=...
VITE_FIREBASE_STORAGE_BUCKET=...
VITE_FIREBASE_MESSAGING_SENDER_ID=...
VITE_FIREBASE_APP_ID=...
```

**Lokal:**

```bash
npm install
npm run dev
```

**Produksi:**

```bash
npm run build
firebase deploy --only hosting
firebase deploy --only firestore:indexes   # setelah clone / update indeks
```

**Hosting + Functions:** `npm run deploy` (perlu Blaze jika diminta Firebase).  
Sesuaikan **`hosting.site`** di `firebase.json` dengan site Anda.

---

## 9. Geofencing & Haversine

- **Titik kantor** dan **radius** (meter) disimpan di Firestore (`settings/geofence`).  
- Browser memberi **koordinat** karyawan (Geolocation API).  
- **Haversine** menghitung jarak lengkung di permukaan bumi antara dua titik (lintang/bujur), hasil dalam meter.  
- **≤ radius:** bisa Hadir/Terlambat (tergantung jam masuk + toleransi).  
- **> radius:** status Ditolak (tetap tercatat).  

---

## 10. Cloud Functions & hapus akun

Menghapus dokumen di **`users`** dari aplikasi **tidak** menghapus akun di **Authentication**. Function **`deleteAuthUser`** (callable) menghapus **Auth + Firestore** setelah memverifikasi pemanggil adalah admin.

- Deploy: `npm run deploy:functions` atau `npm run deploy`.  
- **Blaze** sering diwajibkan untuk Cloud Functions.  
- Tanpa Functions: hapus user lewat **Console → Authentication** manual.  

---

## 11. Tampilan mobile & menu

- Lebar ≤ **900px:** sidebar tersembunyi; buka lewat **hamburger** di topbar.  
- Tombol hamburger hanya terhubung **satu** listener (hindari duplikat `onclick` + `addEventListener` agar menu tidak “tidak merespons”).  

---

## 12. Ringkasan perintah

| Perintah | Fungsi |
|----------|--------|
| `npm run dev` | Pengembangan lokal (Vite) |
| `npm run build` | Build ke `dist/` |
| `firebase deploy --only hosting` | Unggah situs |
| `firebase deploy --only firestore:indexes` | Unggah indeks Firestore |
| `npm run deploy` | Build + hosting + functions |
| `npm run deploy:functions` | Hanya functions |
| `firebase login` | Login CLI |

---

## Lisensi & konteks

Proyek **web-ari** / AbsensiGeo untuk absensi berbasis lokasi. Sesuaikan **Security Rules** Firestore, kebijakan privasi GPS, dan identitas organisasi dengan kebijakan perusahaan Anda.
