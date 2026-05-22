import 'dotenv/config'
import Fastify from 'fastify'
import cors from '@fastify/cors'

import { productsRoutes } from './routes/products.js'
import { transactionsRoutes } from './routes/transactions.js'
import { tillSessionsRoutes } from './routes/till-sessions.js'
import { categoriesRoutes } from './routes/categories.js'

const fastify = Fastify({
  logger: {
    transport: process.env.NODE_ENV === 'development'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined
  }
})

// ── Plugins ────────────────────────────────────────────────────────────────

await fastify.register(cors, {
  origin: process.env.NODE_ENV === 'development'
    ? true                          // allow all origins in dev
    : [
        'https://your-dashboard.vercel.app',
        /\.indiegrocer\.app$/       // allow any subdomain in prod
      ],
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
})

// ── Health check ───────────────────────────────────────────────────────────

fastify.get('/health', async () => ({
  status: 'ok',
  version: '1.0.0',
  timestamp: new Date().toISOString()
}))

// ── API routes (all prefixed with /api/v1) ─────────────────────────────────

await fastify.register(productsRoutes,     { prefix: '/api/v1' })
await fastify.register(transactionsRoutes, { prefix: '/api/v1' })
await fastify.register(tillSessionsRoutes, { prefix: '/api/v1' })
await fastify.register(categoriesRoutes,   { prefix: '/api/v1' })

// ── 404 handler ────────────────────────────────────────────────────────────

fastify.setNotFoundHandler((req, reply) => {
  reply.code(404).send({ error: `Route ${req.method} ${req.url} not found` })
})

// ── Error handler ──────────────────────────────────────────────────────────

fastify.setErrorHandler((err, req, reply) => {
  fastify.log.error(err)
  const statusCode = err.statusCode || 500
  reply.code(statusCode).send({
    error: statusCode === 500 ? 'Internal server error' : err.message
  })
})

// ── Start ──────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || '3000')
const HOST = process.env.HOST || '0.0.0.0'

try {
  await fastify.listen({ port: PORT, host: HOST })
  console.log(`\n🛒  IndieGrocer API running on http://${HOST}:${PORT}`)
  console.log(`📋  Routes:`)
  console.log(`    GET  /health`)
  console.log(`    GET  /api/v1/products/lookup?barcode=... or ?plu=...`)
  console.log(`    GET  /api/v1/products`)
  console.log(`    GET  /api/v1/products/:id`)
  console.log(`    GET  /api/v1/categories`)
  console.log(`    POST /api/v1/transactions`)
  console.log(`    POST /api/v1/transactions/:id/items`)
  console.log(`    DELETE /api/v1/transactions/:id/items/:itemId`)
  console.log(`    POST /api/v1/transactions/:id/pay`)
  console.log(`    POST /api/v1/transactions/:id/void`)
  console.log(`    GET  /api/v1/transactions/:id/receipt`)
  console.log(`    GET  /api/v1/transactions`)
  console.log(`    POST /api/v1/till-sessions`)
  console.log(`    PATCH /api/v1/till-sessions/:id/close`)
  console.log(`    GET  /api/v1/till-sessions`)
  console.log(`    GET  /api/v1/till-sessions/:id\n`)
} catch (err) {
  fastify.log.error(err)
  process.exit(1)
}
