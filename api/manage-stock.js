// api/manage-stock.js
// Menggunakan Firebase Admin SDK via REST API (lebih stabil di Vercel)

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  // GET boleh tanpa token (hanya baca, tidak ada data sensitif yang dikembalikan)
  // POST tetap butuh token admin
  if (req.method !== 'GET') {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.replace('Bearer ', '');
    if (!token || token.length < 32) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const baseUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;

  // Dapatkan access token Firebase via service account key
  // Karena kita pakai API key biasa, gunakan Firebase REST API dengan api key
  const apiKey = process.env.FIREBASE_API_KEY;

  // === GET: Lihat stok ===
  if (req.method === 'GET') {
    try {
      const { productId, variantCode } = req.query;
      if (!productId || !variantCode) {
        return res.status(400).json({ error: 'productId dan variantCode diperlukan' });
      }

      const safeVariantCode = variantCode.replace(/#/g, 'HASH');
      const stockId = `${productId}_${safeVariantCode}`;
      const docUrl = `${baseUrl}/stocks/${stockId}?key=${apiKey}`;

      const r = await fetch(docUrl);

      if (r.status === 404) {
        return res.status(200).json({ productId, variantCode, totalStock: 0, totalDelivered: 0, previewAccounts: [] });
      }

      if (!r.ok) {
        const err = await r.text();
        console.error('Firestore GET error:', err);
        return res.status(500).json({ error: 'Gagal ambil data stok' });
      }

      const doc = await r.json();
      const fields = doc.fields || {};
      const accounts = (fields.accounts?.arrayValue?.values || []).map(v => v.stringValue || '');
      const totalDelivered = parseInt(fields.totalDelivered?.integerValue || '0');
      const autoPayment = fields.autoPayment?.booleanValue === true;
      const fulfillmentType = fields.fulfillmentType?.stringValue || 'stock';
      const providerCode = fields.providerCode?.stringValue || '';

      return res.status(200).json({
        productId, variantCode,
        totalStock: accounts.length,
        totalDelivered,
        autoPayment,
        fulfillmentType,
        providerCode,
        lastUpdated: fields.lastUpdated?.stringValue,
        previewAccounts: accounts.slice(0, 3).map(maskAccount)
      });

    } catch (err) {
      console.error('GET stock error:', err);
      return res.status(500).json({ error: 'Server error: ' + err.message });
    }
  }

  // === POST: Tambah atau hapus stok ===
  if (req.method === 'POST') {
    try {
      const { action, productId, variantCode, accounts } = req.body || {};

      if (!productId || !variantCode) {
        return res.status(400).json({ error: 'productId dan variantCode diperlukan' });
      }

      const safeVariantCode = variantCode.replace(/#/g, 'HASH');
      const stockId = `${productId}_${safeVariantCode}`;
      const docUrl = `${baseUrl}/stocks/${stockId}?key=${apiKey}`;

      // Ambil data stok saat ini
      const getRes = await fetch(docUrl);
      let existingAccounts = [];
      let totalDelivered = 0;
      let existingAutoPayment = false;
      let existingFulfillment = 'stock';
      let existingProviderCode = '';

      if (getRes.ok) {
        const doc = await getRes.json();
        const fields = doc.fields || {};
        existingAccounts = (fields.accounts?.arrayValue?.values || []).map(v => v.stringValue || '');
        totalDelivered = parseInt(fields.totalDelivered?.integerValue || '0');
        existingAutoPayment = fields.autoPayment?.booleanValue === true;
        existingFulfillment = fields.fulfillmentType?.stringValue || 'stock';
        existingProviderCode = fields.providerCode?.stringValue || '';
      }

      // === Atur fulfillment (stock | topup) + provider product_code ===
      if (action === 'setFulfillment') {
        const fulfillmentType = (req.body.fulfillmentType === 'topup') ? 'topup' : 'stock';
        const providerCode = (req.body.providerCode || '').toString().trim().substring(0, 100);

        const patchUrl = `${baseUrl}/stocks/${stockId}?key=${apiKey}&updateMask.fieldPaths=fulfillmentType&updateMask.fieldPaths=providerCode&updateMask.fieldPaths=productId&updateMask.fieldPaths=variantCode&updateMask.fieldPaths=lastUpdated`;
        const patchRes = await fetch(patchUrl, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fields: {
              fulfillmentType: { stringValue: fulfillmentType },
              providerCode:    { stringValue: providerCode },
              productId:       { stringValue: productId },
              variantCode:     { stringValue: variantCode },
              lastUpdated:     { stringValue: new Date().toISOString() }
            }
          })
        });
        if (!patchRes.ok) {
          const errText = await patchRes.text();
          console.error('Firestore setFulfillment error:', errText);
          return res.status(500).json({ error: 'Gagal simpan pengaturan fulfillment' });
        }
        return res.status(200).json({ success: true, fulfillmentType, providerCode,
          message: `Mode ${fulfillmentType === 'topup' ? 'Auto-Topup' : 'Stok Akun'} disimpan` });
      }

      // === Tambah stok ===
      if (action === 'add') {
        if (!accounts || !Array.isArray(accounts) || accounts.length === 0) {
          return res.status(400).json({ error: 'Array akun diperlukan' });
        }

        const sanitized = accounts.map(a => sanitizeAccount(a)).filter(a => a.length > 0);
        if (sanitized.length === 0) {
          return res.status(400).json({ error: 'Tidak ada akun valid' });
        }

        // Gabungkan dengan akun yang sudah ada (hindari duplikat)
        const merged = [...new Set([...existingAccounts, ...sanitized])];

        // Simpan ke Firestore via REST - sertakan field lain agar tidak hilang
        const patchUrl = `${baseUrl}/stocks/${stockId}?key=${apiKey}&updateMask.fieldPaths=accounts&updateMask.fieldPaths=totalDelivered&updateMask.fieldPaths=lastUpdated&updateMask.fieldPaths=productId&updateMask.fieldPaths=variantCode&updateMask.fieldPaths=autoPayment&updateMask.fieldPaths=fulfillmentType&updateMask.fieldPaths=providerCode`;

        const body = {
          fields: {
            productId:    { stringValue: productId },
            variantCode:  { stringValue: variantCode },
            totalDelivered: { integerValue: totalDelivered.toString() },
            lastUpdated:  { stringValue: new Date().toISOString() },
            autoPayment:  { booleanValue: existingAutoPayment },
            fulfillmentType: { stringValue: existingFulfillment },
            providerCode: { stringValue: existingProviderCode },
            accounts: {
              arrayValue: {
                values: merged.map(a => ({ stringValue: a }))
              }
            }
          }
        };

        const patchRes = await fetch(patchUrl, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });

        if (!patchRes.ok) {
          const errText = await patchRes.text();
          console.error('Firestore PATCH error:', errText);
          return res.status(500).json({ error: 'Gagal simpan stok' });
        }

        return res.status(200).json({
          success: true,
          message: `${sanitized.length} akun berhasil ditambahkan`,
          added: sanitized.length,
          totalStock: merged.length
        });
      }

      // === Hapus semua stok ===
      if (action === 'clear') {
        const patchUrl = `${baseUrl}/stocks/${stockId}?key=${apiKey}&updateMask.fieldPaths=accounts&updateMask.fieldPaths=lastUpdated`;

        const body = {
          fields: {
            accounts: { arrayValue: { values: [] } },
            lastUpdated: { stringValue: new Date().toISOString() }
          }
        };

        const patchRes = await fetch(patchUrl, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });

        if (!patchRes.ok) {
          return res.status(500).json({ error: 'Gagal hapus stok' });
        }

        return res.status(200).json({ success: true, message: 'Semua stok berhasil dihapus' });
      }

      return res.status(400).json({ error: 'Action tidak dikenali' });

    } catch (err) {
      console.error('POST stock error:', err);
      return res.status(500).json({ error: 'Server error: ' + err.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

function sanitizeAccount(account) {
  if (typeof account !== 'string') return '';
  return account.replace(/[<>"]/g, '').trim().substring(0, 1000);
}

function maskAccount(account) {
  if (!account || account.length < 4) return '****';
  const visible = Math.min(6, Math.floor(account.length / 3));
  return account.substring(0, visible) + '****';
}
