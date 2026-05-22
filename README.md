# IndieGrocer POS — Fastify API

Phase 1A backend API. Handles product lookup, cart, checkout, and till sessions.

## Setup

### 1. Install dependencies
```bash
npm install
```

### 2. Configure environment
```bash
cp .env.example .env
```
Edit `.env` and fill in:
- `SUPABASE_URL` — your Supabase project URL
- `SUPABASE_SERVICE_ROLE_KEY` — from Supabase Settings → API
- `SUPABASE_ANON_KEY` — from Supabase Settings → API
- `JWT_SECRET` — from Supabase Settings → API → JWT Secret

### 3. Run the inventory decrement function in Supabase
Open `supabase_inventory_function.sql` and run it in your Supabase SQL Editor.

### 4. Start the server
```bash
# Development (auto-restarts on file changes)
npm run dev

# Production
npm start
```

Server starts on `http://localhost:3000`

---

## API Endpoints

All routes require `Authorization: Bearer <supabase_jwt>` header except `/health`.

### Health
```
GET /health
```

### Products
```
GET  /api/v1/products/lookup?barcode=049000028911
GET  /api/v1/products/lookup?plu=4011
GET  /api/v1/products?page=1&limit=50&search=milk
GET  /api/v1/products/:id
```

### Categories
```
GET  /api/v1/categories
```

### Transactions
```
POST   /api/v1/transactions
POST   /api/v1/transactions/:id/items
DELETE /api/v1/transactions/:id/items/:itemId
POST   /api/v1/transactions/:id/pay
POST   /api/v1/transactions/:id/void
GET    /api/v1/transactions/:id/receipt
GET    /api/v1/transactions?store_id=...&date=2026-05-22
```

### Till Sessions
```
POST   /api/v1/till-sessions
PATCH  /api/v1/till-sessions/:id/close
GET    /api/v1/till-sessions?store_id=...&status=open
GET    /api/v1/till-sessions/:id
```

---

## Example: Complete Sale Flow

### 1. Open a till
```bash
POST /api/v1/till-sessions
{
  "store_id": "00000000-0000-0000-0000-000000000002",
  "register_id": "00000000-0000-0000-0000-000000000004",
  "opening_float": 100.00
}
```

### 2. Start a transaction
```bash
POST /api/v1/transactions
{
  "store_id": "00000000-0000-0000-0000-000000000002",
  "register_id": "00000000-0000-0000-0000-000000000004",
  "till_session_id": "<till_session_id from step 1>"
}
```

### 3. Scan a barcode → lookup product
```bash
GET /api/v1/products/lookup?barcode=049000028911
```

### 4. Add item to cart
```bash
POST /api/v1/transactions/:id/items
{
  "product_id": "<product id>",
  "product_name": "Coca-Cola 2L",
  "barcode": "049000028911",
  "quantity": 2,
  "unit_price": 2.49,
  "is_ebt_eligible": true,
  "is_taxable": false,
  "usda_snap_category": 2
}
```

### 5. Pay (EBT + cash split)
```bash
POST /api/v1/transactions/:id/pay
{
  "tenders": [
    {
      "tender_type": "ebt_snap",
      "amount": 4.98,
      "approval_code": "FORAGE_APPROVAL_CODE"
    },
    {
      "tender_type": "cash",
      "amount": 0.00
    }
  ]
}
```

### 6. Get receipt
```bash
GET /api/v1/transactions/:id/receipt
```

---

## Project Structure
```
src/
  server.js              — Fastify server, plugin registration, startup
  lib/
    supabase.js          — Supabase admin + per-request clients
  middleware/
    auth.js              — JWT validation, tenant extraction, role guard
  routes/
    products.js          — Barcode/PLU lookup, product list
    transactions.js      — Cart, checkout, payment, receipt
    till-sessions.js     — Open/close cash drawer sessions
    categories.js        — Category tree
supabase_inventory_function.sql  — Run once in Supabase SQL Editor
.env.example            — Environment variable template
```
