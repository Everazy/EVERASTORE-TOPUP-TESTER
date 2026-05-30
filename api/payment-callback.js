// api/payment-callback.js
// Dipanggil SakuRupiah setelah pembayaran berhasil
// Header: X-Callback-Signature, X-Callback-Event
import { executeTopup, isTopupSuccess } from './_provider.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const payload = req.body || {};
    console.log('Callback diterima:', JSON.stringify(payload));

    const projectId = process.env.FIREBASE_PROJECT_ID;
    const fbApiKey  = process.env.FIREBASE_API_KEY;
    const baseUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;

    // Ambil merchant_ref (= orderId kita) dan status dari payload
    const merchantRef   = payload.merchant_ref || payload.order_id || payload.reference_id;
    const paymentStatus = (payload.payment_status || payload.status || '').toLowerCase();
    const trxId         = payload.trx_id || payload.transaction_id;

    console.log('merchant_ref:', merchantRef, '| status:', paymentStatus, '| trxId:', trxId);

    const isPaid = paymentStatus === 'berhasil' || paymentStatus === 'success'
                || paymentStatus === 'paid'     || paymentStatus === 'settlement';

    if (!isPaid) {
      console.log('Status bukan paid, diabaikan:', paymentStatus);
      return res.status(200).json({ received: true, processed: false });
    }

    if (!merchantRef) {
      console.error('merchant_ref tidak ada di payload');
      return res.status(200).json({ received: true, processed: false, reason: 'no_merchant_ref' });
    }

    // Cek apakah sudah diproses sebelumnya
    const orderUrl = `${baseUrl}/orders/${merchantRef}?key=${fbApiKey}`;
    const orderRes = await fetch(orderUrl);
    if (orderRes.ok) {
      const orderDoc = await orderRes.json();
      if (orderDoc.fields?.stockDelivered?.booleanValue === true ||
          orderDoc.fields?.topupFinalized?.booleanValue === true) {
        console.log('Order sudah diproses sebelumnya:', merchantRef);
        return res.status(200).json({ received: true, processed: false, reason: 'already_processed' });
      }
    }

    // Ambil metadata order dari pending_orders
    const pendingUrl = `${baseUrl}/pending_orders/${merchantRef}?key=${fbApiKey}`;
    const pendingRes = await fetch(pendingUrl);

    if (!pendingRes.ok) {
      console.error('Pending order tidak ditemukan:', merchantRef);
      return res.status(200).json({ received: true, processed: false, reason: 'order_not_found' });
    }

    const pendingDoc = await pendingRes.json();
    const f = pendingDoc.fields || {};

    const productId   = f.productId?.stringValue;
    const variantCode = f.variantCode?.stringValue;
    const qty         = parseInt(f.qty?.integerValue || '1');

    if (!productId || !variantCode) {
      console.error('productId atau variantCode tidak ada');
      return res.status(200).json({ received: true, processed: false, reason: 'missing_product_info' });
    }

    // Ambil stok dari Firestore (konsisten dengan endpoint lain: # -> HASH)
    const safeVariantCode = variantCode.replace(/#/g, 'HASH');
    const stockId  = `${productId}_${safeVariantCode}`;
    const stockUrl = `${baseUrl}/stocks/${stockId}?key=${fbApiKey}`;
    const stockRes = await fetch(stockUrl);

    if (!stockRes.ok) {
      console.error('Stok tidak ditemukan:', stockId);
      return res.status(200).json({ received: true, processed: false, reason: 'stock_not_found' });
    }

    const stockDoc  = await stockRes.json();
    const stockFields = stockDoc.fields || {};

    // === CABANG AUTO-TOPUP ===
    const fulfillmentType = stockFields.fulfillmentType?.stringValue || 'stock';
    if (fulfillmentType === 'topup') {
      const providerCode = stockFields.providerCode?.stringValue || '';
      const buyerUserId  = f.buyerUserId?.stringValue || '';
      const buyerServer  = f.buyerServerId?.stringValue || '';

      if (!providerCode || !buyerUserId) {
        await fetch(`${orderUrl}&updateMask.fieldPaths=status&updateMask.fieldPaths=paidAt&updateMask.fieldPaths=fulfillmentType&updateMask.fieldPaths=needsManualHandling&updateMask.fieldPaths=buyerName`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fields: {
            status: { stringValue: 'paid' }, paidAt: { stringValue: new Date().toISOString() },
            fulfillmentType: { stringValue: 'topup' }, needsManualHandling: { booleanValue: true },
            buyerName: { stringValue: f.buyerName?.stringValue || '' }
          }})
        });
        return res.status(200).json({ received: true, processed: false,
          reason: !providerCode ? 'missing_provider_code' : 'missing_user_id' });
      }

      let result;
      try {
        result = await executeTopup({
          productCode: providerCode, userId: buyerUserId, serverId: buyerServer,
          trxId: merchantRef, orderId: merchantRef
        });
      } catch (topErr) {
        console.error('Eksekusi topup gagal (callback):', topErr.message);
        return res.status(200).json({ received: true, processed: false, reason: 'topup_error' });
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

      console.log(`✅ Order ${merchantRef} topup ${result.status} via callback`);
      return res.status(200).json({ received: true, processed: true, topupStatus: result.status });
    }

    // === CABANG STOK AKUN (perilaku lama) ===
    const allAccounts = (stockFields.accounts?.arrayValue?.values || []).map(v => v.stringValue || '');

    if (allAccounts.length < qty) {
      console.error('Stok tidak cukup:', allAccounts.length, 'butuh:', qty);
      return res.status(200).json({ received: true, processed: false, reason: 'insufficient_stock' });
    }

    // Ambil akun (FIFO)
    const deliveredAccounts = allAccounts.slice(0, qty);
    const remainingAccounts = allAccounts.slice(qty);
    const totalDelivered = parseInt(stockFields.totalDelivered?.integerValue || '0') + qty;

    // Update stok (kurangi)
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

    // Simpan order sebagai selesai
    await fetch(`${orderUrl}&updateMask.fieldPaths=stockDelivered&updateMask.fieldPaths=deliveredAccounts&updateMask.fieldPaths=status&updateMask.fieldPaths=paidAt&updateMask.fieldPaths=trxId&updateMask.fieldPaths=productId&updateMask.fieldPaths=variantCode&updateMask.fieldPaths=qty&updateMask.fieldPaths=buyerName`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fields: {
          stockDelivered:   { booleanValue: true },
          deliveredAccounts: { arrayValue: { values: deliveredAccounts.map(a => ({ stringValue: a })) } },
          status:           { stringValue: 'paid' },
          paidAt:           { stringValue: new Date().toISOString() },
          trxId:            { stringValue: trxId || '' },
          productId:        { stringValue: productId },
          variantCode:      { stringValue: variantCode },
          qty:              { integerValue: qty.toString() },
          buyerName:        { stringValue: f.buyerName?.stringValue || '' }
        }
      })
    });

    console.log('✅ Order', merchantRef, 'selesai -', qty, 'akun dikirim');
    return res.status(200).json({ received: true, processed: true, accountsDelivered: qty });

  } catch (err) {
    console.error('Callback error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}
