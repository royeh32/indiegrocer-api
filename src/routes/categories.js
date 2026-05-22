import { authenticate } from '../middleware/auth.js'
import { supabaseAdmin } from '../lib/supabase.js'

export async function categoriesRoutes(fastify) {

  // GET /categories — full category tree for the tenant
  fastify.get('/categories', {
    preHandler: [authenticate]
  }, async (req, reply) => {
    const { data, error } = await supabaseAdmin
      .from('categories')
      .select('id, name, parent_id, usda_snap_category, is_ebt_eligible, is_wic_eligible, tax_rate_override, sort_order')
      .eq('tenant_id', req.tenantId)
      .order('sort_order', { ascending: true })

    if (error) {
      req.log.error(error)
      return reply.code(500).send({ error: 'Failed to fetch categories' })
    }

    // Build tree structure
    const map = {}
    const roots = []
    data.forEach(c => { map[c.id] = { ...c, children: [] } })
    data.forEach(c => {
      if (c.parent_id && map[c.parent_id]) {
        map[c.parent_id].children.push(map[c.id])
      } else {
        roots.push(map[c.id])
      }
    })

    return reply.send({ categories: roots })
  })
}
