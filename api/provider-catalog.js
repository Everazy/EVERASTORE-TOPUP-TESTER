// api/provider-catalog.js
// Proxy admin untuk katalog & info akun MatchaShop.
// Endpoint: GET /api/provider-catalog?type=products|category|product|user
//   - type=products            -> GET /v1/products  (opsional &category_id=...)
//   - type=category            -> GET /v1/category
//   - type=product&code=XXX    -> GET /v1/product?product_code=XXX
//   - type=user                -> GET /v1/user (nama + sisa saldo)
// Butuh token admin (Authorization: Bearer <token>) karena menampilkan harga modal & saldo.
import { providerGet, providerConfig } from './_provider.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  // Auth admin sederhana (token panjang dari admin-login)
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token || token.length < 32) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { ready } = providerConfig();
  if (!ready) {
    return res.status(503).json({
      error: 'Provider topup belum dikonfigurasi. Set MATCHASHOP_BASE_URL & MATCHASHOP_API_KEY di Vercel.'
    });
  }

  try {
    const type = (req.query.type || 'products').toString();

    if (type === 'category') {
      const json = await providerGet('/v1/category');
      return res.status(200).json({ success: true, data: json.data || [] });
    }

    if (type === 'user') {
      const json = await providerGet('/v1/user');
      return res.status(200).json({ success: true, data: json.data || {} });
    }

    if (type === 'product') {
      const code = (req.query.code || req.query.product_code || '').toString();
      if (!code) return res.status(400).json({ error: 'Parameter code diperlukan' });
      const json = await providerGet(`/v1/product?product_code=${encodeURIComponent(code)}`);
      return res.status(200).json({ success: true, data: json.data || null });
    }

    // default: products (boleh difilter category_id)
    const categoryId = (req.query.category_id || '').toString();
    const path = categoryId
      ? `/v1/products?category_id=${encodeURIComponent(categoryId)}`
      : `/v1/products`;
    const json = await providerGet(path);
    return res.status(200).json({ success: true, data: json.data || [] });

  } catch (err) {
    console.error('provider-catalog error:', err);
    return res.status(502).json({ error: 'Gagal ambil data provider: ' + err.message });
  }
}
