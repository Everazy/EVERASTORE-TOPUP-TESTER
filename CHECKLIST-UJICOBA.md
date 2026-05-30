# ✅ Checklist Uji Coba — EVERASTORE Auto-Topup

Ikuti urut dari atas. Centang tiap langkah biar nggak ada yang kelewat.

---

## TAHAP 1 — Persiapan (sebelum deploy)

- [ ] **1.1** Punya akun MatchaShop yang aktif + saldo terisi (buat tes).
- [ ] **1.2** Catat **Base URL API** MatchaShop dari dashboard (menu Integrasi/API).
      ⚠️ Ini WAJIB benar. Kalau salah, semua topup gagal.
- [ ] **1.3** Catat **API Key** MatchaShop (menu Integrasi).
- [ ] **1.4** Catat kredensial SakuRupiah (Merchant ID, API Key) — yang lama, kalau sudah jalan.

---

## TAHAP 2 — Upload ke GitHub & Vercel

- [ ] **2.1** Upload isi folder `EVERASTORE-main` ke repository GitHub kamu.
      (File `.env` TIDAK ikut ke-upload karena sudah ada di `.gitignore` — ini benar.)
- [ ] **2.2** Di Vercel, hubungkan repo → Deploy.
- [ ] **2.3** Di Vercel > Settings > Environment Variables, isi SEMUA ini
      (lihat daftar lengkap di `.env.example`):
  - [ ] `ADMIN_PASSWORD`
  - [ ] `FIREBASE_PROJECT_ID`
  - [ ] `FIREBASE_API_KEY`
  - [ ] `SAKURUPIAH_MERCHANT_ID`
  - [ ] `SAKURUPIAH_API_KEY`
  - [ ] `SAKURUPIAH_PAYMENT_METHOD`
  - [ ] `MATCHASHOP_BASE_URL`  ← dari langkah 1.2
  - [ ] `MATCHASHOP_API_KEY`   ← dari langkah 1.3
  - [ ] `PUBLIC_BASE_URL`      ← domain Vercel kamu, mis. `https://evera-payment-gateway-tester.vercel.app`
- [ ] **2.4** Setelah isi env var, **Redeploy** (Vercel tidak otomatis pakai env baru tanpa redeploy).

---

## TAHAP 3 — Setup Webhook MatchaShop

- [ ] **3.1** Di dashboard MatchaShop > menu **Webhook**, isi URL:
      ```
      https://DOMAIN-KAMU/api/topup-callback
      ```
- [ ] **3.2** Kalau MatchaShop minta **whitelist IP**, dan dashboard menampilkan IP server mereka,
      pastikan tidak ada firewall yang memblokir. (Vercel menerima semua IP secara default.)

---

## TAHAP 4 — Tes Koneksi Provider (paling penting!)

- [ ] **4.1** Buka web → login admin (pakai `ADMIN_PASSWORD`).
- [ ] **4.2** Buka editor sebuah produk → buka panel **STOK** salah satu varian.
- [ ] **4.3** Ganti **Mode Pengiriman** ke **Auto-Topup (API)** → klik tombol **🔍 (cari)**.
- [ ] **4.4** Modal **Katalog Provider** muncul:
  - [ ] Saldo akun MatchaShop kamu tampil di atas → **berarti Base URL & API Key BENAR.** ✅
  - [ ] Daftar produk muncul → koneksi sukses.
  - ❌ Kalau muncul error "Provider belum dikonfigurasi" → env var belum keisi / belum redeploy.
  - ❌ Kalau error lain → Base URL kemungkinan salah. Cek lagi langkah 1.2.

---

## TAHAP 5 — Setup 1 Produk Topup untuk Tes

- [ ] **5.1** Di katalog provider, klik 1 produk **bernominal kecil** (mis. diamond paling murah).
      → `product_code` otomatis terisi.
- [ ] **5.2** Klik **Simpan Mode**.
- [ ] **5.3** Set **tipe order** varian:
  - Game butuh server (mis. Mobile Legends) → pilih **ID + Server**.
  - Game tanpa server (mis. Free Fire) → pilih **ID** saja.
- [ ] **5.4** Set **harga jual** varian (manual). Pastikan ≥ harga modal + margin.
- [ ] **5.5** Simpan produk.

---

## TAHAP 6 — Transaksi Uji (pakai ID game ASLI kamu)

- [ ] **6.1** Buka web sebagai pembeli (mode incognito / logout admin).
- [ ] **6.2** Beli produk tadi → isi **User ID (+ Server)** game asli kamu.
- [ ] **6.3** Bayar via SakuRupiah (nominal kecil).
- [ ] **6.4** Setelah bayar, tunggu di halaman hasil:
  - [ ] Muncul **nickname** akun game kamu → validasi ID sukses.
  - [ ] Status **SUCCESS** → item masuk ke game. **CEK DI DALAM GAME.** ✅
  - Status **PENDING** → tunggu beberapa menit (webhook akan update). Refresh halaman.
  - Status **FAILED/REFUNDED** → lihat catatan; cek saldo MatchaShop / kebenaran product_code.

---

## TAHAP 7 — Cek Dashboard Admin

- [ ] **7.1** Login admin → klik tombol **Riwayat Order Topup**.
- [ ] **7.2** Order tadi muncul dengan status yang benar.
- [ ] **7.3** Tes filter **Perlu Tindakan** — order yang gagal harus muncul di sini,
      lengkap dengan tombol WhatsApp ke pembeli.

---

## Kalau ada yang gagal

Cek **Vercel > Deployments > (deploy terbaru) > Functions > Logs**. Semua error
topup & callback ke-log di sana (aku sudah pasang `console.log` di titik penting).
Salin pesan error-nya kalau mau dibantu diagnosa.

---

## Catatan jujur (baca ya)

- **Base URL & format order** belum pernah diuji ke server MatchaShop asli dari sisi
  pembuatan ini — TAHAP 4 & 6 adalah pembuktian sesungguhnya. Lakukan dengan nominal kecil dulu.
- **Keamanan Firestore**: lihat komentar di `firestore.rules`. Mode default bikin app jalan
  tapi koleksi sensitif belum tertutup penuh. Untuk produksi serius, pertimbangkan "Option B".
- **Validasi ID game** baru terjadi SAAT topup dijalankan (setelah bayar), karena provider
  tidak menyediakan endpoint cek-nickname terpisah. Salah ketik ID = perlu refund manual.
