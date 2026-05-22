-- =============================================================================
-- Run this in Supabase SQL Editor after the main migration.
-- Creates the inventory decrement function called by the API on each sale.
-- =============================================================================

CREATE OR REPLACE FUNCTION decrement_inventory(
  p_tenant_id  UUID,
  p_store_id   UUID,
  p_product_id UUID,
  p_quantity   NUMERIC
)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  UPDATE inventory
  SET
    qty_on_hand = GREATEST(qty_on_hand - p_quantity, 0),
    updated_at  = NOW()
  WHERE
    tenant_id  = p_tenant_id
    AND store_id   = p_store_id
    AND product_id = p_product_id;
END;
$$;
