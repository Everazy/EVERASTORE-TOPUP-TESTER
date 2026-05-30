// api/topup-callback.js
// Webhook dari MatchaShop saat status topup berubah.
// Mendukung dua format:
//   1) POST JSON  + header x-signature (HMAC-SHA256, apikey sebagai secret)
//   2) GET Otomax (query: invoice_number, trx_id, status, sn, msg)
// orderId kita dipetakan dari query ?ref=<orderId> (disematkan saat membuat order),
// dengan fallback ke invoice_number.
import {
  verifyCallbackSignature, normalizeTopupResult, isTopupSuccess,
  fsGet, fsPatch, readBool
} from './_provider.js';

// Matikan body parser bawaan agar bisa verifikasi signature atas raw body.
export const config = { api: { bodyParser: false } };

// Baca raw body dari stream. Jika runtime sudah meng-consume body (req.body terisi),
// kembalikan string kosong agar pemanggil memakai fallback req.body.
function readRawBody(req) {
  return new Promise((resolve) => {
    // Body sudah diparse runtime -> tidak ada stream untuk dibaca
    if (req.body !== undefined && req.body !== null) {
      return resolve('');
    }
    let data = '';
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(data); } };
    try {
      req.on('data', chunk => { data += chunk; });
      req.on('end', done);
      req.on('error', done);
      // Jaga-jaga bila stream tidak pernah emit (sudah habis)
      setTimeout(done, 3000);
    } catch (e) { resolve(''); }
  });
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const ref = (req.query.ref || '').toString();

    // ---- Format 2: Otomax (GET) ----
    if (req.method === 'GET') {
      const q = req.query || {};
      // Tanpa ref pada GET murni health-check, balas 200 agar provider tidak retry.
      if (!q.invoice_number && !q.status && !ref) {
        return res.status(200).json({ ok: true });
      }
      const result = {
        invoiceNumber: (q.invoice_number || '').toString(),
        providerTrxId: (q.trx_id || '').toString(),
        responseNote:  (q.sn || q.msg || '').toString(),
        nickname:      '',
        status:        (q.status || '').toString().toUpperCase(),
        amount:        Number(q.product_price || 0)
      };
      const orderId = ref || result.invoiceNumber;
      await finalizeOrder(orderId, result);
      return res.status(200).json({ received: true });
    }

    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    // ---- Format 1: JSON (POST) ----
    let raw = await readRawBody(req);
    const signature = req.headers['x-signature'];

    // Tentukan payload + string yang dipakai untuk verifikasi signature.
    // Jika raw kosong (runtime sudah parse), pakai req.body dan re-stringify
    // (Node menjaga urutan key sehingga HMAC tetap cocok dengan provider).
    let payload = {};
    if (raw && raw.length) {
      try { payload = JSON.parse(raw); }
      catch (e) { return res.status(400).json({ error: 'Body bukan JSON valid' }); }
    } else if (req.body && typeof req.body === 'object') {
      payload = req.body;
      raw = JSON.stringify(req.body);
    } else if (typeof req.body === 'string' && req.body.length) {
      raw = req.body;
      try { payload = JSON.parse(req.body); }
      catch (e) { return res.status(400).json({ error: 'Body bukan JSON valid' }); }
    }

    // Verifikasi signature bila header tersedia. Jika provider mengirim signature
    // tapi tidak valid -> tolak. Jika tidak ada header sama sekali, tetap proses
    // (beberapa konfigurasi Otomax/manual mungkin tidak mengirim), tapi catat.
    if (signature && !verifyCallbackSignature(raw, signature)) {
      console.warn('Signature callback tidak valid');
      return res.status(401).json({ error: 'Invalid signature' });
    }
    if (!signature) console.warn('Callback tanpa x-signature header');

    console.log('Topup callback diterima:', (raw || '').substring(0, 500));

    const result = normalizeTopupResult(payload);
    const orderId = ref || result.invoiceNumber;
    await finalizeOrder(orderId, result);

    return res.status(200).json({ received: true });

  } catch (err) {
    console.error('topup-callback error:', err);
    // Balas 200 agar provider tidak retry tanpa henti pada error internal kita.
    return res.status(200).json({ received: true, processed: false, error: err.message });
  }
}

// Tulis hasil topup ke orders/{orderId}. Idempotent: tidak menimpa jika sudah final & sukses.
async function finalizeOrder(orderId, result) {
  if (!orderId) { console.warn('Callback tanpa orderId/ref, diabaikan'); return; }

  const existing = await fsGet('orders', orderId);
  const fields = existing?.fields || {};
  if (readBool(fields, 'topupFinalized')) {
    console.log('Order sudah final, callback diabaikan:', orderId);
    return;
  }

  const success = isTopupSuccess(result.status);
  await fsPatch('orders', orderId, {
    status:           success ? 'paid' : 'failed',
    fulfillmentType:  'topup',
    topupStatus:      result.status,
    topupNickname:    result.nickname || '',
    topupNote:        result.responseNote || '',
    topupInvoice:     result.invoiceNumber || '',
    providerTrxId:    result.providerTrxId || '',
    topupFinalized:   true,
    needsManualHandling: !success,
    updatedAt:        new Date().toISOString()
  });
  console.log(`Order ${orderId} difinalisasi via callback: ${result.status}`);
}
