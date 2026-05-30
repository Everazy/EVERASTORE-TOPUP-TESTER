// api/check-payment.js
// Cek status via SakuRupiah + langsung proses fulfillment jika berhasil:
//   - fulfillmentType 'topup' -> panggil provider (MatchaShop) auto-topup
//   - selain itu              -> kirim akun dari stok (perilaku lama)
import { executeTopup, isTopupSuccess } from './_provider.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { trxId, orderId } = req.query;

    if (!trxId || trxId === 'undefined' || trxId === 'null') {
      return res.status(200).json({ isPaid: false, status: 'pending', reason: 'trxId belum tersedia' });
    }

    const apiId  = process.env.SAKURUPIAH_MERCHANT_ID;
    const apiKey = process.env.SAKURUPIAH_API_KEY;
    const projectId = process.env.FIREBASE_PROJECT_ID;
    const fbApiKey  = process.env.FIREBASE_API_KEY;
    const baseUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;

    // 1. Cek status ke SakuRupiah
    const formData = new URLSearchParams();
    formData.append('api_id', apiId);
    formData.append('method', 'status');
    formData.append('trx_id', trxId);

    const sakuResponse = await fetch('https://sakurupiah.id/api/status-transaction.php', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: formData.toString()
    });

    const sakuText = await sakuResponse.text();
    console.log('SakuRupiah status response:', sakuText);

    let sakuData;
    try { sakuData = JSON.parse(sakuText); } catch (e) {
      return res.status(502).json({ error: 'Response tidak valid' });
    }

    // Handle nested data array dari SakuRupiah
    const dataObj = Array.isArray(sakuData.data) ? sakuData.data[0] : (sakuData.data || sakuData);
    const rawStatus = (dataObj?.status || sakuData.status || sakuData.payment_status || '').toLowerCase();
    const isPaid = rawStatus === 'berhasil' || rawStatus === 'success'
                || rawStatus === 'paid'     || rawStatus === '200';

    // 2. Jika belum bayar, return langsung
    if (!isPaid) {
      return res.status(200).json({ isPaid: false, status: rawStatus });
    }

    // 3. Jika sudah bayar, cek apakah order sudah pernah diproses
    if (!orderId || orderId === 'undefined') {
      return res.status(200).json({ isPaid: true, status: 'paid', deliveredAccounts: null });
    }

    const orderUrl = `${baseUrl}/orders/${orderId}?key=${fbApiKey}`;
    const orderRes = await fetch(orderUrl);

    if (orderRes.ok) {
      const orderDoc = await orderRes.json();
      const fields = orderDoc.fields || {};

      // Topup sudah difinalisasi (oleh polling sebelumnya atau via callback)
      if (fields.topupFinalized?.booleanValue === true) {
        console.log('Order topup sudah final:', orderId);
        return res.status(200).json({
          isPaid: true,
          status: 'paid',
          fulfillmentType: 'topup',
          topup: {
            status:   fields.topupStatus?.stringValue || '',
            nickname: fields.topupNickname?.stringValue || '',
            note:     fields.topupNote?.stringValue || '',
            invoice:  fields.topupInvoice?.stringValue || ''
          }
        });
      }

      // Sudah diproses sebelumnya (stok) - langsung return akun
      if (fields.stockDelivered?.booleanValue === true) {
        const deliveredAccounts = (fields.deliveredAccounts?.arrayValue?.values || [])
          .map(v => v.stringValue || '');
        console.log('Order sudah diproses sebelumnya:', orderId);
        return res.status(200).json({ isPaid: true, status: 'paid', deliveredAccounts });
      }
    }

    // 4. Belum diproses - ambil metadata dari pending_orders
    const pendingUrl = `${baseUrl}/pending_orders/${orderId}?key=${fbApiKey}`;
    const pendingRes = await fetch(pendingUrl);

    if (!pendingRes.ok) {
      console.error('Pending order tidak ditemukan:', orderId);
      return res.status(200).json({ isPaid: true, status: 'paid', deliveredAccounts: null, reason: 'order_not_found' });
    }

    const pendingDoc = await pendingRes.json();
    const f = pendingDoc.fields || {};

    const productId   = f.productId?.stringValue;
    const variantCode = f.variantCode?.stringValue;
    const qty         = parseInt(f.qty?.integerValue || '1');

    if (!productId || !variantCode) {
      console.error('productId atau variantCode tidak ada');
      return res.status(200).json({ isPaid: true, status: 'paid', deliveredAccounts: null, reason: 'missing_product_info' });
    }

    // 5. Ambil stok dari Firestore
    const safeVariantCode = variantCode.replace(/#/g, "HASH");
    const stockId = `${productId}_${safeVariantCode}`;
    const stockUrl = `${baseUrl}/stocks/${stockId}?key=${fbApiKey}`;
    const stockRes = await fetch(stockUrl);

    if (!stockRes.ok) {
      console.error('Stok tidak ditemukan:', stockId);
      return res.status(200).json({ isPaid: true, status: 'paid', deliveredAccounts: null, reason: 'stock_not_found' });
    }

    const stockDoc    = await stockRes.json();
    const stockFields = stockDoc.fields || {};

    // === CABANG AUTO-TOPUP (fulfillmentType === 'topup') ===
    const fulfillmentType = stockFields.fulfillmentType?.stringValue || 'stock';
    if (fulfillmentType === 'topup') {
      const providerCode = stockFields.providerCode?.stringValue || '';
      const buyerUserId  = f.buyerUserId?.stringValue || '';
      const buyerServer  = f.buyerServerId?.stringValue || '';

      if (!providerCode || !buyerUserId) {
        // Tandai butuh penanganan manual; sudah dibayar tapi data topup kurang
        await fetch(`${orderUrl}&updateMask.fieldPaths=status&updateMask.fieldPaths=paidAt&updateMask.fieldPaths=fulfillmentType&updateMask.fieldPaths=needsManualHandling&updateMask.fieldPaths=topupFinalized&updateMask.fieldPaths=buyerName`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fields: {
            status: { stringValue: 'paid' }, paidAt: { stringValue: new Date().toISOString() },
            fulfillmentType: { stringValue: 'topup' }, needsManualHandling: { booleanValue: true },
            topupFinalized: { booleanValue: false }, buyerName: { stringValue: f.buyerName?.stringValue || '' }
          }})
        });
        return res.status(200).json({ isPaid: true, status: 'paid', fulfillmentType: 'topup',
          reason: !providerCode ? 'missing_provider_code' : 'missing_user_id',
          topup: { status: 'PENDING', note: 'Menunggu diproses admin' } });
      }

      // Jalankan topup. trx_id = orderId kita -> idempotent (call ulang = cek status).
      let result;
      try {
        result = await executeTopup({
          productCode: providerCode, userId: buyerUserId, serverId: buyerServer,
          trxId: orderId, orderId
        });
      } catch (topErr) {
        console.error('Eksekusi topup gagal:', topErr.message);
        // Jangan finalisasi; biarkan polling/callback mencoba lagi
        return res.status(200).json({ isPaid: true, status: 'paid', fulfillmentType: 'topup',
          topup: { status: 'PENDING', note: 'Topup sedang diproses...' } });
      }

      const success = isTopupSuccess(result.status);
      const final = result.status && result.status !== 'PENDING' && result.status !== 'PAID';

      await fetch(`${orderUrl}&updateMask.fieldPaths=status&updateMask.fieldPaths=paidAt&updateMask.fieldPaths=trxId&updateMask.fieldPaths=productId&updateMask.fieldPaths=variantCode&updateMask.fieldPaths=qty&updateMask.fieldPaths=buyerName&updateMask.fieldPaths=fulfillmentType&updateMask.fieldPaths=topupStatus&updateMask.fieldPaths=topupNickname&updateMask.fieldPaths=topupNote&updateMask.fieldPaths=topupInvoice&updateMask.fieldPaths=providerTrxId&updateMask.fieldPaths=topupFinalized&updateMask.fieldPaths=needsManualHandling`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: {
          status:          { stringValue: success ? 'paid' : (final ? 'failed' : 'paid') },
          paidAt:          { stringValue: new Date().toISOString() },
          trxId:           { stringValue: trxId || '' },
          productId:       { stringValue: productId },
          variantCode:     { stringValue: variantCode },
          qty:             { integerValue: qty.toString() },
          buyerName:       { stringValue: f.buyerName?.stringValue || '' },
          fulfillmentType: { stringValue: 'topup' },
          topupStatus:     { stringValue: result.status },
          topupNickname:   { stringValue: result.nickname || '' },
          topupNote:       { stringValue: result.responseNote || '' },
          topupInvoice:    { stringValue: result.invoiceNumber || '' },
          providerTrxId:   { stringValue: result.providerTrxId || '' },
          topupFinalized:  { booleanValue: final },
          needsManualHandling: { booleanValue: final && !success }
        }})
      });

      console.log(`✅ Order ${orderId} topup ${result.status} (${result.nickname})`);
      return res.status(200).json({ isPaid: true, status: 'paid', fulfillmentType: 'topup',
        topup: {
          status:   result.status, nickname: result.nickname || '',
          note:     result.responseNote || '', invoice: result.invoiceNumber || '',
          product:  result.productName || ''
        }
      });
    }

    // === CABANG STOK AKUN (perilaku lama) ===
    // CEK: apakah varian ini autoPayment = true?
    const isAutoPayment = stockFields.autoPayment?.booleanValue === true;
    if (!isAutoPayment) {
      console.log('Varian', variantCode, 'tidak aktif autoPayment — tidak kirim akun otomatis');
      return res.status(200).json({ isPaid: true, status: 'paid', deliveredAccounts: null, reason: 'autopayment_disabled' });
    }

    const allAccounts = (stockFields.accounts?.arrayValue?.values || []).map(v => v.stringValue || '');

    if (allAccounts.length < qty) {
      console.error('Stok tidak cukup:', allAccounts.length, 'butuh:', qty);
      return res.status(200).json({ isPaid: true, status: 'paid', deliveredAccounts: null, reason: 'insufficient_stock' });
    }

    // 6. Ambil akun (FIFO) dan update stok
    const deliveredAccounts = allAccounts.slice(0, qty);
    const remainingAccounts = allAccounts.slice(qty);
    const totalDelivered = parseInt(stockFields.totalDelivered?.integerValue || '0') + qty;

    await fetch(`${stockUrl}&updateMask.fieldPaths=accounts&updateMask.fieldPaths=totalDelivered&updateMask.fieldPaths=lastUpdated`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fields: {
          accounts: { arrayValue: { values: remainingAccounts.map(a => ({ stringValue: a })) } },
          totalDelivered: { integerValue: totalDelivered.toString() },
          lastUpdated: { stringValue: new Date().toISOString() }
        }
      })
    });

    // 7. Simpan order sebagai selesai
    await fetch(`${orderUrl}&updateMask.fieldPaths=stockDelivered&updateMask.fieldPaths=deliveredAccounts&updateMask.fieldPaths=status&updateMask.fieldPaths=paidAt&updateMask.fieldPaths=trxId&updateMask.fieldPaths=productId&updateMask.fieldPaths=variantCode&updateMask.fieldPaths=qty&updateMask.fieldPaths=buyerName`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fields: {
          stockDelivered:    { booleanValue: true },
          deliveredAccounts: { arrayValue: { values: deliveredAccounts.map(a => ({ stringValue: a })) } },
          status:            { stringValue: 'paid' },
          paidAt:            { stringValue: new Date().toISOString() },
          trxId:             { stringValue: trxId || '' },
          productId:         { stringValue: productId },
          variantCode:       { stringValue: variantCode },
          qty:               { integerValue: qty.toString() },
          buyerName:         { stringValue: f.buyerName?.stringValue || '' }
        }
      })
    });

    console.log('✅ Order', orderId, 'selesai via check-payment -', qty, 'akun dikirim');
    return res.status(200).json({
      isPaid: true,
      status: 'paid',
      deliveredAccounts,
      amount: sakuData.amount || sakuData.nominal,
      paidAt: new Date().toISOString()
    });

  } catch (err) {
    console.error('Check payment error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}
