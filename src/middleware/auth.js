import { supabaseAdmin } from '../lib/supabase.js'

// Extracts and validates the Bearer JWT from Authorization header.
// Attaches req.user and req.tenantId to every authenticated request.
// RLS will enforce data isolation automatically via the JWT claims.

export async function authenticate(req, reply) {
  const authHeader = req.headers.authorization
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return reply.code(401).send({ error: 'Missing or invalid Authorization header' })
  }

  const token = authHeader.split(' ')[1]

  // Verify the token with Supabase Auth
  const { data: { user }, error } = await supabaseAdmin.auth.getUser(token)

  if (error || !user) {
    return reply.code(401).send({ error: 'Invalid or expired token' })
  }

  // Extract tenant_id from app_metadata (set during onboarding)
  const tenantId = user.app_metadata?.tenant_id
  if (!tenantId) {
    return reply.code(403).send({ error: 'User has no tenant assigned' })
  }

  req.user = user
  req.tenantId = tenantId
  req.userRole = user.app_metadata?.role || 'cashier'
  req.accessToken = token
}

// Role guard factory — use as a preHandler after authenticate
// e.g. requireRole(['manager', 'owner'])
export function requireRole(allowedRoles) {
  return async function(req, reply) {
    if (!allowedRoles.includes(req.userRole)) {
      return reply.code(403).send({
        error: `This action requires one of these roles: ${allowedRoles.join(', ')}`
      })
    }
  }
}
