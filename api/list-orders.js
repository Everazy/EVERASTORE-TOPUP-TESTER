// api/list-orders.js
// Admin: daftar order (collection "orders") untuk halaman Riwayat Order Topup.
// GET /api/list-orders            -> sampai 300 order terbaru
// Butuh token admin (Authorization: Bearer <token>).
export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  // Auth admin
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token || token.length < 32) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const projectId = process.env.FIREBASE_PROJECT_ID;
    const apiKey    = process.env.FIREBASE_API_KEY;
    const baseUrl   = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;

    // Ambil semua dokumen orders (paginasi sederhana, maks ~600)
    let documents = [];
    let pageToken = '';
    for (let i = 0; i < 2; i++) {
      const url = `${baseUrl}/orders?key=${apiKey}&pageSize=300${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
      const r = await fetch(url);
      if (!r.ok) {
        if (r.status === 404) break;
        const t = await r.text();
        console.error('Firestore list error:', t);
        return res.status(500).json({ error: 'Gagal ambil daftar order' });
      }
      const j = await r.json();
      documents = documents.concat(j.documents || []);
      pageToken = j.nextPageToken || '';
      if (!pageToken) break;
    }

    const s = (f, k) => f?.[k]?.stringValue ?? '';
    const b = (f, k) => f?.[k]?.booleanValue === true;
    const n = (f, k) => parseInt(f?.[k]?.integerValue ?? '0', 10) || 0;

    const orders = documents.map(doc => {
      const f = doc.fields || {};
      const id = (doc.name || '').split('/').pop();
      const deliveredCount = (f.deliveredAccounts?.arrayValue?.values || []).length;
      return {
        orderId:        id,
        status:         s(f, 'status') || 'pending',
        fulfillmentType: s(f, 'fulfillmentType') || (deliveredCount ? 'stock' : ''),
        productName:    s(f, 'productName'),
        variantName:    s(f, 'variantName') || s(f, 'variantCode'),
        buyerName:      s(f, 'buyerName'),
        buyerPhone:     s(f, 'buyerPhone'),
        amount:         n(f, 'amount'),
        qty:            n(f, 'qty') || 1,
        // topup
        topupStatus:    s(f, 'topupStatus'),
        topupNickname:  s(f, 'topupNickname'),
        topupNote:      s(f, 'topupNote'),
        topupInvoice:   s(f, 'topupInvoice'),
        topupFinalized: b(f, 'topupFinalized'),
        // stok
        deliveredCount,
        needsManualHandling: b(f, 'needsManualHandling'),
        paidAt:         s(f, 'paidAt'),
        updatedAt:      s(f, 'updatedAt')
      };
    });

    // Urutkan terbaru dulu (paidAt / updatedAt)
    orders.sort((a, b2) => (b2.paidAt || b2.updatedAt || '').localeCompare(a.paidAt || a.updatedAt || ''));

    const summary = {
      total: orders.length,
      needsManual: orders.filter(o => o.needsManualHandling).length,
      topup: orders.filter(o => o.fulfillmentType === 'topup').length,
      stock: orders.filter(o => o.fulfillmentType === 'stock').length
    };

    return res.status(200).json({ success: true, summary, orders });

  } catch (err) {
    console.error('list-orders error:', err);
    return res.status(500).json({ error: 'Server error: ' + err.message });
  }
}
