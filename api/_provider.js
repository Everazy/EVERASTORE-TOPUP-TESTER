// api/_provider.js
// Helper bersama untuk integrasi provider auto-topup (MatchaShop) + Firestore REST.
// File diawali "_" agar Vercel tidak menjadikannya endpoint publik; hanya di-import modul lain.
import crypto from 'crypto';

// ----------------------------------------------------------------------------
// Konfigurasi provider
// ----------------------------------------------------------------------------
export function providerConfig() {
  const baseUrl = (process.env.MATCHASHOP_BASE_URL || '').replace(/\/+$/, '');
  const apiKey  = process.env.MATCHASHOP_API_KEY || '';
  return { baseUrl, apiKey, ready: !!(baseUrl && apiKey) };
}

// URL callback publik yang dikirim ke provider per-transaksi.
// orderId disematkan sebagai ?ref= agar callback selalu bisa dipetakan ke order kita,
// tanpa bergantung pada field trx_id provider (yang bisa null / berbeda format).
export function publicCallbackUrl(orderId) {
  const base = (process.env.PUBLIC_BASE_URL || 'https://evera-payment-gateway-tester.vercel.app').replace(/\/+$/, '');
  const url = `${base}/api/topup-callback`;
  return orderId ? `${url}?ref=${encodeURIComponent(orderId)}` : url;
}

// ----------------------------------------------------------------------------
// Panggilan ke API provider
// ----------------------------------------------------------------------------
// GET helper (products / category / product / user)
export async function providerGet(path) {
  const { baseUrl, apiKey, ready } = providerConfig();
  if (!ready) throw new Error('Provider belum dikonfigurasi (MATCHASHOP_BASE_URL / MATCHASHOP_API_KEY)');

  const res = await fetch(`${baseUrl}${path}`, {
    method: 'GET',
    headers: { 'Authorization': apiKey, 'Content-Type': 'application/json' }
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); }
  catch (e) { throw new Error(`Response provider tidak valid: ${text.substring(0, 200)}`); }
  return json;
}

// Buat order topup. Memakai /v2/order: trx_id sama = dianggap cek status (idempotent).
// Mengembalikan objek "data" provider yang sudah dinormalisasi.
export async function executeTopup({ productCode, userId, serverId, trxId, orderId, withCallback = true }) {
  const { baseUrl, apiKey, ready } = providerConfig();
  if (!ready) throw new Error('Provider belum dikonfigurasi');

  const body = {
    product_code: productCode,
    user_id: String(userId || ''),
    trx_id: String(trxId)
  };
  if (serverId) body.server_id = String(serverId);
  if (withCallback) body.callback_url = publicCallbackUrl(orderId || trxId);

  const res = await fetch(`${baseUrl}/v2/order`, {
    method: 'POST',
    headers: { 'Authorization': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  console.log('MatchaShop order response:', text);

  let json;
  try { json = JSON.parse(text); }
  catch (e) { throw new Error(`Response order tidak valid: ${text.substring(0, 200)}`); }

  return normalizeTopupResult(json.data || json);
}

// Normalisasi hasil topup dari provider menjadi bentuk seragam yang kita simpan/kirim.
export function normalizeTopupResult(d = {}) {
  const ui = d.user_input || {};
  return {
    invoiceNumber: d.invoice_number || '',
    providerTrxId: d.trx_id || '',
    responseNote:  d.response_note || d.sn || '',
    nickname:      ui.nickname || '',
    userId:        ui.user_id || '',
    serverId:      ui.server_id || '',
    productName:   d.product?.name || '',
    productCode:   d.product?.code || '',
    amount:        Number(d.amount || d.product?.price || 0),
    status:        String(d.status || '').toUpperCase(), // SUCCESS|PARTIAL_SUCCESS|PENDING|PAID|REFUNDED|FAILED
    createdAt:     d.created_at || null
  };
}

// Status yang dianggap "selesai" (tidak perlu polling lagi)
export function isTopupFinal(status) {
  const s = String(status || '').toUpperCase();
  return ['SUCCESS', 'PARTIAL_SUCCESS', 'REFUNDED', 'FAILED'].includes(s);
}
export function isTopupSuccess(status) {
  const s = String(status || '').toUpperCase();
  return s === 'SUCCESS' || s === 'PARTIAL_SUCCESS';
}

// ----------------------------------------------------------------------------
// Verifikasi signature callback (HMAC-SHA256 dengan apikey sebagai secret)
// ----------------------------------------------------------------------------
export function verifyCallbackSignature(rawBodyString, signatureHeader) {
  const { apiKey } = providerConfig();
  if (!apiKey || !signatureHeader) return false;
  const expected = crypto.createHmac('sha256', apiKey).update(rawBodyString).digest('hex');
  try {
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(String(signatureHeader), 'utf8');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch (e) {
    return false;
  }
}

// ----------------------------------------------------------------------------
// Helper Firestore REST
// ----------------------------------------------------------------------------
export function fsBaseUrl() {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  return `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
}
export function fsKey() {
  return process.env.FIREBASE_API_KEY;
}

// Konversi nilai JS -> Firestore typed value
export function fsValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') {
    return Number.isInteger(v) ? { integerValue: v.toString() } : { doubleValue: v };
  }
  if (Array.isArray(v)) {
    return { arrayValue: { values: v.map(fsValue) } };
  }
  return { stringValue: String(v) };
}

// Bangun fields object + updateMask query dari objek datar
export function fsFields(obj) {
  const fields = {};
  for (const k of Object.keys(obj)) fields[k] = fsValue(obj[k]);
  const mask = Object.keys(obj).map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
  return { fields, mask };
}

// PATCH (merge) sebuah dokumen dengan field datar
export async function fsPatch(collectionPath, docId, dataObj) {
  const { fields, mask } = fsFields(dataObj);
  const url = `${fsBaseUrl()}/${collectionPath}/${encodeURIComponent(docId)}?key=${fsKey()}&${mask}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields })
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Firestore PATCH gagal (${res.status}): ${t.substring(0, 200)}`);
  }
  return res.json();
}

// Ambil sebuah dokumen -> { fields } atau null bila 404
export async function fsGet(collectionPath, docId) {
  const url = `${fsBaseUrl()}/${collectionPath}/${encodeURIComponent(docId)}?key=${fsKey()}`;
  const res = await fetch(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Firestore GET gagal (${res.status})`);
  return res.json();
}

// Helper baca nilai field Firestore -> JS
export function readStr(fields, key)  { return fields?.[key]?.stringValue ?? ''; }
export function readBool(fields, key) { return fields?.[key]?.booleanValue === true; }
export function readInt(fields, key)  { return parseInt(fields?.[key]?.integerValue ?? '0', 10) || 0; }
