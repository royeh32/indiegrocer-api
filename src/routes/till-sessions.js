import { authenticate, requireRole } from '../middleware/auth.js'
import { supabaseAdmin } from '../lib/supabase.js'

export async function tillSessionsRoutes(fastify) {

  // -------------------------------------------------------------------------
  // POST /till-sessions
  // Open a till session at the start of a shift.
  // Body: { store_id, register_id, opening_float }
  // -------------------------------------------------------------------------
  fastify.post('/till-sessions', {
    preHandler: [authenticate]
  }, async (req, reply) => {
    const { store_id, register_id, opening_float = 0 } = req.body

    if (!store_id || !register_id) {
      return reply.code(400).send({ error: 'store_id and register_id are required' })
    }

    // Check there is no already-open session on this register
    const { data: existing } = await supabaseAdmin
      .from('till_sessions')
      .select('id')
      .eq('tenant_id', req.tenantId)
      .eq('register_id', register_id)
      .eq('status', 'open')
      .maybeSingle()

    if (existing) {
      return reply.code(409).send({
        error: 'A till session is already open on this register',
        existing_session_id: existing.id
      })
    }

    const { data, error } = await supabaseAdmin
      .from('till_sessions')
      .insert({
        tenant_id: req.tenantId,
        store_id,
        register_id,
        cashier_id: req.user.id,
        opening_cashier_id: req.user.id,
        opening_float: parseFloat(opening_float),
        status: 'open'
      })
      .select()
      .single()

    if (error) {
      req.log.error(error)
      return reply.code(500).send({ error: 'Failed to open till session' })
    }

    return reply.code(201).send({ till_session: data })
  })


  // -------------------------------------------------------------------------
  // PATCH /till-sessions/:id/close
  // Close a till session at end of shift.
  // Body: { closing_count, notes? }
  // Calculates expected cash from opening float + cash sales during session,
  // computes variance (auto-generated column in DB does this), marks closed.
  // -------------------------------------------------------------------------
  fastify.patch('/till-sessions/:id/close', {
    preHandler: [authenticate]
  }, async (req, reply) => {
    const { closing_count, notes } = req.body

    if (closing_count === undefined) {
      return reply.code(400).send({ error: 'closing_count is required' })
    }

    // Load the session
    const { data: session, error: sessionError } = await supabaseAdmin
      .from('till_sessions')
      .select('*')
      .eq('id', req.params.id)
      .eq('tenant_id', req.tenantId)
      .single()

    if (sessionError || !session) {
      return reply.code(404).send({ error: 'Till session not found' })
    }
    if (session.status !== 'open') {
      return reply.code(400).send({ error: `Till session is already ${session.status}` })
    }

    // Calculate expected cash:
    // opening float + all cash tenders collected during this session
    const { data: cashTenders } = await supabaseAdmin
      .from('payment_tenders')
      .select('amount, change_given')
      .eq('tenant_id', req.tenantId)
      .eq('tender_type', 'cash')
      .eq('status', 'approved')
      .in(
        'transaction_id',
        // Only transactions that belong to this till session
        supabaseAdmin
          .from('transactions')
          .select('id')
          .eq('till_session_id', session.id)
          .eq('status', 'completed')
      )

    const cashIn = (cashTenders || []).reduce(
      (sum, t) => sum + parseFloat(t.amount) - parseFloat(t.change_given || 0),
      0
    )
    const expectedCash = parseFloat((session.opening_float + cashIn).toFixed(2))
    const closingCountFloat = parseFloat(parseFloat(closing_count).toFixed(2))
    const variance = parseFloat((closingCountFloat - expectedCash).toFixed(2))

    const newStatus = Math.abs(variance) > 5.00
      ? 'discrepancy_flagged'
      : 'closed'

    const { data, error } = await supabaseAdmin
      .from('till_sessions')
      .update({
        status: newStatus,
        closed_at: new Date().toISOString(),
        closing_count: closingCountFloat,
        expected_cash: expectedCash,
        closing_cashier_id: req.user.id,
        closing_notes: notes || null
      })
      .eq('id', req.params.id)
      .select()
      .single()

    if (error) {
      req.log.error(error)
      return reply.code(500).send({ error: 'Failed to close till session' })
    }

    return reply.send({
      till_session: data,
      summary: {
        opening_float: session.opening_float,
        cash_sales: parseFloat(cashIn.toFixed(2)),
        expected_cash: expectedCash,
        closing_count: closingCountFloat,
        variance,
        status: newStatus,
        flagged: newStatus === 'discrepancy_flagged'
      }
    })
  })


  // -------------------------------------------------------------------------
  // GET /till-sessions
  // List till sessions for a store/register.
  // Query: ?store_id=...&register_id=...&status=open
  // -------------------------------------------------------------------------
  fastify.get('/till-sessions', {
    preHandler: [authenticate]
  }, async (req, reply) => {
    const { store_id, register_id, status } = req.query

    let query = supabaseAdmin
      .from('till_sessions')
      .select(`
        id, status, opening_float, opened_at, closed_at,
        closing_count, expected_cash, variance, closing_notes,
        registers ( name ),
        users!till_sessions_cashier_id_fkey ( first_name, last_name )
      `)
      .eq('tenant_id', req.tenantId)
      .order('opened_at', { ascending: false })
      .limit(100)

    if (store_id) query = query.eq('store_id', store_id)
    if (register_id) query = query.eq('register_id', register_id)
    if (status) query = query.eq('status', status)

    const { data, error } = await query

    if (error) {
      req.log.error(error)
      return reply.code(500).send({ error: 'Failed to fetch till sessions' })
    }

    return reply.send({ till_sessions: data })
  })


  // -------------------------------------------------------------------------
  // GET /till-sessions/:id
  // Single till session detail with transaction summary
  // -------------------------------------------------------------------------
  fastify.get('/till-sessions/:id', {
    preHandler: [authenticate]
  }, async (req, reply) => {
    const { data: session, error } = await supabaseAdmin
      .from('till_sessions')
      .select('*')
      .eq('id', req.params.id)
      .eq('tenant_id', req.tenantId)
      .single()

    if (error || !session) {
      return reply.code(404).send({ error: 'Till session not found' })
    }

    // Get transaction summary for this session
    const { data: txnSummary } = await supabaseAdmin
      .from('transactions')
      .select('status, total, ebt_amount, tax_total')
      .eq('till_session_id', session.id)
      .eq('tenant_id', req.tenantId)

    const completed = (txnSummary || []).filter(t => t.status === 'completed')

    return reply.send({
      till_session: session,
      summary: {
        transaction_count: completed.length,
        gross_sales: parseFloat(completed.reduce((s, t) => s + parseFloat(t.total), 0).toFixed(2)),
        ebt_total: parseFloat(completed.reduce((s, t) => s + parseFloat(t.ebt_amount), 0).toFixed(2)),
        tax_collected: parseFloat(completed.reduce((s, t) => s + parseFloat(t.tax_total), 0).toFixed(2))
      }
    })
  })
}
