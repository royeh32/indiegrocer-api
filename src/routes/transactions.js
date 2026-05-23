import { authenticate } from '../middleware/auth.js'
import { supabaseAdmin } from '../lib/supabase.js'

export async function transactionsRoutes(fastify) {

  // -------------------------------------------------------------------------
  // POST /transactions
  // Open a new transaction (start of a sale).
  // Body: { store_id, register_id, till_session_id?, offline_id? }
  // -------------------------------------------------------------------------
  fastify.post('/transactions', {
    preHandler: [authenticate]
  }, async (req, reply) => {
    const { store_id, register_id, till_session_id, offline_id } = req.body

    if (!store_id || !register_id) {
      return reply.code(400).send({ error: 'store_id and register_id are required' })
    }

    const { data, error } = await supabaseAdmin
      .from('transactions')
      .insert({
        tenant_id: req.tenantId,
        store_id,
        register_id,
        cashier_id: req.user.id,
        till_session_id: till_session_id || null,
        offline_id: offline_id || null,
        status: 'in_progress',
        transaction_type: 'sale',
        subtotal: 0,
        discount_total: 0,
        tax_total: 0,
        ebt_amount: 0,
        bottle_deposit_total: 0,
        total: 0
      })
      .select()
      .single()

    if (error) {
      req.log.error(error)
      return reply.code(500).send({ error: 'Failed to create transaction' })
    }

    return reply.code(201).send({ transaction: data })
  })


  // -------------------------------------------------------------------------
  // POST /transactions/:id/items
  // Add a line item to an in-progress transaction.
  // Body: {
  //   product_id, product_name, barcode?, plu_code?,
  //   quantity, unit_price,
  //   is_ebt_eligible, is_taxable, usda_snap_category,
  //   discount_amount?, discount_reason?
  // }
  // After inserting the item, recalculates and updates transaction totals.
  // -------------------------------------------------------------------------
  fastify.post('/transactions/:id/items', {
    preHandler: [authenticate]
  }, async (req, reply) => {
    const { id: transactionId } = req.params
    const {
      product_id,
      product_name,
      barcode,
      plu_code,
      quantity,
      unit_price,
      is_ebt_eligible = false,
      is_wic_eligible = false,
      is_taxable = false,
      usda_snap_category,
      discount_amount = 0,
      discount_reason,
      tax_rate = 0
    } = req.body

    if (!product_name || !quantity || unit_price === undefined) {
      return reply.code(400).send({ error: 'product_name, quantity, and unit_price are required' })
    }

    // Verify transaction belongs to this tenant and is still in progress
    const { data: txn, error: txnError } = await supabaseAdmin
      .from('transactions')
      .select('id, status, subtotal, discount_total, tax_total, ebt_amount, total')
      .eq('id', transactionId)
      .eq('tenant_id', req.tenantId)
      .single()

    if (txnError || !txn) {
      return reply.code(404).send({ error: 'Transaction not found' })
    }
    if (txn.status !== 'in_progress') {
      return reply.code(400).send({ error: `Transaction is ${txn.status}, cannot add items` })
    }

    // Calculate line totals
    const lineSubtotal = parseFloat((quantity * unit_price).toFixed(2))
    const discountAmt = parseFloat((discount_amount || 0).toFixed(2))
    const taxableAmount = is_taxable ? (lineSubtotal - discountAmt) : 0
    const taxAmount = parseFloat((taxableAmount * tax_rate).toFixed(2))
    const lineTotal = parseFloat((lineSubtotal - discountAmt + taxAmount).toFixed(2))

    // Insert the line item
    const { data: item, error: itemError } = await supabaseAdmin
      .from('transaction_items')
      .insert({
        tenant_id: req.tenantId,
        transaction_id: transactionId,
        product_id: product_id || null,
        product_name,
        barcode: barcode || null,
        plu_code: plu_code || null,
        quantity,
        unit_price,
        discount_amount: discountAmt,
        discount_reason: discount_reason || null,
        is_taxable,
        tax_amount: taxAmount,
        is_ebt_eligible,
        is_wic_eligible,
        usda_snap_category: usda_snap_category || null,
        line_total: lineTotal,
        refunded_qty: 0
      })
      .select()
      .single()

    if (itemError) {
      req.log.error(itemError)
      return reply.code(500).send({ error: 'Failed to add item' })
    }

    // Recalculate transaction totals from all items
    const { data: allItems, error: allItemsError } = await supabaseAdmin
      .from('transaction_items')
      .select('quantity, unit_price, discount_amount, tax_amount, line_total, is_ebt_eligible')
      .eq('transaction_id', transactionId)

    if (allItemsError) {
      req.log.error(allItemsError)
      return reply.code(500).send({ error: 'Failed to recalculate totals' })
    }

    const newSubtotal = parseFloat(
      allItems.reduce((sum, i) => sum + (i.quantity * i.unit_price), 0).toFixed(2)
    )
    const newDiscountTotal = parseFloat(
      allItems.reduce((sum, i) => sum + parseFloat(i.discount_amount || 0), 0).toFixed(2)
    )
    const newTaxTotal = parseFloat(
      allItems.reduce((sum, i) => sum + parseFloat(i.tax_amount || 0), 0).toFixed(2)
    )
    const newEbtAmount = parseFloat(
      allItems
        .filter(i => i.is_ebt_eligible)
        .reduce((sum, i) => sum + parseFloat(i.line_total || 0), 0)
        .toFixed(2)
    )
    const newTotal = parseFloat((newSubtotal - newDiscountTotal + newTaxTotal).toFixed(2))

    // Update transaction totals
    const { data: updatedTxn, error: updateError } = await supabaseAdmin
      .from('transactions')
      .update({
        subtotal: newSubtotal,
        discount_total: newDiscountTotal,
        tax_total: newTaxTotal,
        ebt_amount: newEbtAmount,
        total: newTotal
      })
      .eq('id', transactionId)
      .select()
      .single()

    if (updateError) {
      req.log.error(updateError)
      return reply.code(500).send({ error: 'Failed to update transaction totals' })
    }

    return reply.code(201).send({
      item,
      transaction: updatedTxn
    })
  })


  // -------------------------------------------------------------------------
  // DELETE /transactions/:id/items/:itemId
  // Remove a line item (void single item) from an in-progress transaction.
  // -------------------------------------------------------------------------
  fastify.delete('/transactions/:id/items/:itemId', {
    preHandler: [authenticate]
  }, async (req, reply) => {
    const { id: transactionId, itemId } = req.params

    // Verify transaction
    const { data: txn, error: txnError } = await supabaseAdmin
      .from('transactions')
      .select('id, status')
      .eq('id', transactionId)
      .eq('tenant_id', req.tenantId)
      .single()

    if (txnError || !txn) return reply.code(404).send({ error: 'Transaction not found' })
    if (txn.status !== 'in_progress') {
      return reply.code(400).send({ error: 'Cannot remove items from a completed transaction' })
    }

    const { error: deleteError } = await supabaseAdmin
      .from('transaction_items')
      .delete()
      .eq('id', itemId)
      .eq('transaction_id', transactionId)

    if (deleteError) {
      return reply.code(500).send({ error: 'Failed to remove item' })
    }

    // Recalculate totals after removal
    const { data: allItems } = await supabaseAdmin
      .from('transaction_items')
      .select('quantity, unit_price, discount_amount, tax_amount, line_total, is_ebt_eligible')
      .eq('transaction_id', transactionId)

    const items = allItems || []
    const newSubtotal = parseFloat(items.reduce((s, i) => s + i.quantity * i.unit_price, 0).toFixed(2))
    const newDiscountTotal = parseFloat(items.reduce((s, i) => s + parseFloat(i.discount_amount || 0), 0).toFixed(2))
    const newTaxTotal = parseFloat(items.reduce((s, i) => s + parseFloat(i.tax_amount || 0), 0).toFixed(2))
    const newEbtAmount = parseFloat(items.filter(i => i.is_ebt_eligible).reduce((s, i) => s + parseFloat(i.line_total), 0).toFixed(2))
    const newTotal = parseFloat((newSubtotal - newDiscountTotal + newTaxTotal).toFixed(2))

    const { data: updatedTxn } = await supabaseAdmin
      .from('transactions')
      .update({ subtotal: newSubtotal, discount_total: newDiscountTotal, tax_total: newTaxTotal, ebt_amount: newEbtAmount, total: newTotal })
      .eq('id', transactionId)
      .select()
      .single()

    return reply.send({ transaction: updatedTxn })
  })


  // -------------------------------------------------------------------------
  // POST /transactions/:id/pay
  // Submit payment and complete the transaction.
  // Body: {
  //   tenders: [
  //     { tender_type: 'ebt_snap', amount: 12.50, approval_code: 'FORAGE_CODE' },
  //     { tender_type: 'cash', amount: 10.00, amount_tendered: 20.00 }
  //   ]
  // }
  // Validates that tenders cover the total, writes payment_tenders rows,
  // marks transaction as completed, and decrements inventory.
  // -------------------------------------------------------------------------
  fastify.post('/transactions/:id/pay', {
    preHandler: [authenticate]
  }, async (req, reply) => {
    const { id: transactionId } = req.params
    const { tenders } = req.body

    if (!tenders || !Array.isArray(tenders) || tenders.length === 0) {
      return reply.code(400).send({ error: 'tenders array is required' })
    }

    // Load the transaction
    const { data: txn, error: txnError } = await supabaseAdmin
      .from('transactions')
      .select('*, transaction_items(*)')
      .eq('id', transactionId)
      .eq('tenant_id', req.tenantId)
      .single()

    if (txnError || !txn) return reply.code(404).send({ error: 'Transaction not found' })
    if (txn.status !== 'in_progress') {
      return reply.code(400).send({ error: `Transaction is already ${txn.status}` })
    }
    if (!txn.transaction_items || txn.transaction_items.length === 0) {
      return reply.code(400).send({ error: 'Cannot complete a transaction with no items' })
    }

    // Validate tender total covers the transaction total
    const tenderedTotal = parseFloat(
      tenders.reduce((sum, t) => sum + parseFloat(t.amount), 0).toFixed(2)
    )
    if (tenderedTotal < txn.total) {
      return reply.code(400).send({
        error: 'Tendered amount does not cover transaction total',
        total: txn.total,
        tendered: tenderedTotal,
        short_by: parseFloat((txn.total - tenderedTotal).toFixed(2))
      })
    }

    // Generate receipt number: date + random suffix
    const receiptNumber = `RCP-${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`

    // Insert all tenders
    const tenderRows = tenders.map(t => ({
      tenant_id: req.tenantId,
      transaction_id: transactionId,
      tender_type: t.tender_type,
      amount: parseFloat(t.amount),
      approval_code: t.approval_code || null,
      last_four: t.last_four || null,
      card_brand: t.card_brand || null,
      amount_tendered: t.amount_tendered || null,
      change_given: t.tender_type === 'cash'
        ? parseFloat((parseFloat(t.amount_tendered || t.amount) - parseFloat(t.amount)).toFixed(2))
        : 0,
      status: 'approved'
    }))

    const { error: tenderError } = await supabaseAdmin
      .from('payment_tenders')
      .insert(tenderRows)

    if (tenderError) {
      req.log.error(tenderError)
      return reply.code(500).send({ error: 'Failed to record payment tenders' })
    }

    // Mark transaction as completed
    const { data: completedTxn, error: completeError } = await supabaseAdmin
      .from('transactions')
      .update({
        status: 'completed',
        receipt_number: receiptNumber,
        synced_at: new Date().toISOString()
      })
      .eq('id', transactionId)
      .select()
      .single()

    if (completeError) {
      req.log.error(completeError)
      return reply.code(500).send({ error: 'Failed to complete transaction' })
    }

    // Decrement inventory for non-weighted items
    for (const item of txn.transaction_items) {
      if (item.product_id) {
        await supabaseAdmin.rpc('decrement_inventory', {
          p_tenant_id: req.tenantId,
          p_store_id: txn.store_id,
          p_product_id: item.product_id,
          p_quantity: item.quantity
    try {
          await supabaseAdmin.rpc('decrement_inventory', {
            p_tenant_id: req.tenantId,
            p_store_id: txn.store_id,
            p_product_id: item.product_id,
            p_quantity: item.quantity
          })
        } catch (err) {
          req.log.warn({ err, product_id: item.product_id }, 'Inventory decrement failed')
        }
      }
    }

    return reply.send({
      transaction: completedTxn,
      receipt_number: receiptNumber,
      change_due: parseFloat((tenderedTotal - txn.total).toFixed(2))
    })
  })


  // -------------------------------------------------------------------------
  // GET /transactions/:id/receipt
  // Full receipt data — transaction + items + tenders.
  // -------------------------------------------------------------------------
  fastify.get('/transactions/:id/receipt', {
    preHandler: [authenticate]
  }, async (req, reply) => {
    const { data: txn, error } = await supabaseAdmin
      .from('transactions')
      .select(`
        *,
        stores ( name, address_line1, city, state, zip, phone ),
        users ( first_name, last_name ),
        transaction_items (
          id, product_name, barcode, plu_code,
          quantity, unit_price, discount_amount,
          tax_amount, line_total, is_ebt_eligible,
          usda_snap_category
        ),
        payment_tenders (
          tender_type, amount, last_four, card_brand,
          amount_tendered, change_given, approval_code
        )
      `)
      .eq('id', req.params.id)
      .eq('tenant_id', req.tenantId)
      .single()

    if (error || !txn) {
      return reply.code(404).send({ error: 'Transaction not found' })
    }

    return reply.send({ receipt: txn })
  })


  // -------------------------------------------------------------------------
  // POST /transactions/:id/void
  // Void an in-progress or completed transaction.
  // -------------------------------------------------------------------------
  fastify.post('/transactions/:id/void', {
    preHandler: [authenticate]
  }, async (req, reply) => {
    const { reason } = req.body || {}

    const { data: txn, error: txnError } = await supabaseAdmin
      .from('transactions')
      .select('id, status')
      .eq('id', req.params.id)
      .eq('tenant_id', req.tenantId)
      .single()

    if (txnError || !txn) return reply.code(404).send({ error: 'Transaction not found' })
    if (txn.status === 'voided') return reply.code(400).send({ error: 'Already voided' })

    const { data, error } = await supabaseAdmin
      .from('transactions')
      .update({ status: 'voided', notes: reason || 'Voided by cashier' })
      .eq('id', req.params.id)
      .select()
      .single()

    if (error) return reply.code(500).send({ error: 'Failed to void transaction' })

    return reply.send({ transaction: data })
  })


  // -------------------------------------------------------------------------
  // GET /transactions
  // List transactions for a store — used by end-of-day reports.
  // Query: ?store_id=...&date=2026-05-22&status=completed&page=1&limit=50
  // -------------------------------------------------------------------------
  fastify.get('/transactions', {
    preHandler: [authenticate]
  }, async (req, reply) => {
    const { store_id, date, status, page = 1, limit = 50 } = req.query
    const offset = (parseInt(page) - 1) * parseInt(limit)

    let query = supabaseAdmin
      .from('transactions')
      .select(`
        id, receipt_number, status, transaction_type,
        subtotal, discount_total, tax_total, ebt_amount, total,
        created_at,
        users ( first_name, last_name )
      `, { count: 'exact' })
      .eq('tenant_id', req.tenantId)
      .order('created_at', { ascending: false })
      .range(offset, offset + parseInt(limit) - 1)

    if (store_id) query = query.eq('store_id', store_id)
    if (status) query = query.eq('status', status)
    if (date) {
      const start = `${date}T00:00:00.000Z`
      const end = `${date}T23:59:59.999Z`
      query = query.gte('created_at', start).lte('created_at', end)
    }

    const { data, error, count } = await query

    if (error) {
      req.log.error(error)
      return reply.code(500).send({ error: 'Failed to fetch transactions' })
    }

    return reply.send({
      transactions: data,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: count,
        pages: Math.ceil(count / parseInt(limit))
      }
    })
  })
}
