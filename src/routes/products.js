import { authenticate } from '../middleware/auth.js'
import { supabaseAdmin } from '../lib/supabase.js'

export async function productsRoutes(fastify) {

  // -------------------------------------------------------------------------
  // GET /products/lookup
  // Barcode or PLU lookup for the register scanner.
  // Query params: ?barcode=049000028911  OR  ?plu=4011
  //
  // Returns the product with its category and current inventory level.
  // This is the most performance-critical endpoint — called on every scan.
  // -------------------------------------------------------------------------
  fastify.get('/products/lookup', {
    preHandler: [authenticate]
  }, async (req, reply) => {
    const { barcode, plu } = req.query

    if (!barcode && !plu) {
      return reply.code(400).send({ error: 'Provide either barcode or plu query parameter' })
    }

    let query = supabaseAdmin
      .from('products')
      .select(`
        id,
        name,
        brand,
        barcode,
        plu_code,
        unit_of_measure,
        price,
        cost,
        is_ebt_eligible,
        is_wic_eligible,
        is_taxable,
        is_age_restricted,
        age_restriction_min,
        is_weighted,
        image_url,
        categories (
          id,
          name,
          usda_snap_category,
          tax_rate_override
        ),
        inventory (
          qty_on_hand,
          qty_on_order,
          aisle,
          bin
        )
      `)
      .eq('tenant_id', req.tenantId)
      .eq('is_active', true)

    if (barcode) {
      // Try barcode with leading zero variants to handle scanner/export differences
      const candidates = new Set([
        barcode,
        barcode.padStart(12, '0'),
        barcode.padStart(13, '0'),
        barcode.replace(/^0+/, '') || barcode,
      ])

      const { data: found, error: findError } = await supabaseAdmin
        .from('products')
        .select('id, name, brand, barcode, plu_code, unit_of_measure, price, cost, is_ebt_eligible, is_wic_eligible, is_taxable, is_age_restricted, age_restriction_min, is_weighted, image_url, categories ( id, name, usda_snap_category, tax_rate_override ), inventory ( qty_on_hand, qty_on_order, aisle, bin )')
        .eq('tenant_id', req.tenantId)
        .eq('is_active', true)
        .in('barcode', [...candidates])
        .limit(1)

      const data = found?.[0]
      if (findError || !data) {
        return reply.code(404).send({ error: 'Product not found', barcode })
      }

      const effectiveTaxRate = data.categories?.tax_rate_override ?? 0
      return reply.send({ product: { ...data, effective_tax_rate: effectiveTaxRate } })

    } else {
      query = query.eq('plu_code', plu)
      const { data, error } = await query.single()
      if (error || !data) {
        return reply.code(404).send({ error: 'Product not found', barcode, plu })
      }
      const effectiveTaxRate = data.categories?.tax_rate_override ?? 0
      return reply.send({ product: { ...data, effective_tax_rate: effectiveTaxRate } })
    }
  })


  // -------------------------------------------------------------------------
  // GET /products
  // Paginated product list for admin/inventory screens.
  // Query params: ?page=1&limit=50&category_id=...&search=milk&active=true
  // -------------------------------------------------------------------------
  fastify.get('/products', {
    preHandler: [authenticate]
  }, async (req, reply) => {
    const {
      page = 1,
      limit = 50,
      category_id,
      search,
      active = 'true'
    } = req.query

    const offset = (parseInt(page) - 1) * parseInt(limit)

    let query = supabaseAdmin
      .from('products')
      .select(`
        id, name, brand, barcode, plu_code, unit_of_measure,
        price, cost, is_ebt_eligible, is_taxable, is_weighted,
        is_active, reorder_point, reorder_qty,
        categories ( id, name )
      `, { count: 'exact' })
      .eq('tenant_id', req.tenantId)
      .range(offset, offset + parseInt(limit) - 1)
      .order('name', { ascending: true })

    if (active === 'true') query = query.eq('is_active', true)
    if (category_id) query = query.eq('category_id', category_id)
    if (search) query = query.ilike('name', `%${search}%`)

    const { data, error, count } = await query

    if (error) {
      req.log.error(error)
      return reply.code(500).send({ error: 'Failed to fetch products' })
    }

    return reply.send({
      products: data,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: count,
        pages: Math.ceil(count / parseInt(limit))
      }
    })
  })


  // -------------------------------------------------------------------------
  // GET /products/:id
  // Single product detail
  // -------------------------------------------------------------------------
  fastify.get('/products/:id', {
    preHandler: [authenticate]
  }, async (req, reply) => {
    const { data, error } = await supabaseAdmin
      .from('products')
      .select(`
        *,
        categories ( id, name, usda_snap_category, tax_rate_override ),
        inventory ( qty_on_hand, qty_on_order, qty_reserved, aisle, bin, last_counted_at )
      `)
      .eq('id', req.params.id)
      .eq('tenant_id', req.tenantId)
      .single()

    if (error || !data) {
      return reply.code(404).send({ error: 'Product not found' })
    }

    return reply.send({ product: data })
  })
}
