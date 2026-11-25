import { pool } from "../config/db";

const migration = `
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL UNIQUE,
  password TEXT,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'owner', 'admin')),
  login_method TEXT NOT NULL DEFAULT 'password'
    CHECK (login_method IN ('password', 'google', 'facebook')),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  avatar TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
UPDATE users SET role = 'admin' WHERE role = 'owner';
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('user', 'store_manager', 'admin'));
ALTER TABLE users ADD COLUMN IF NOT EXISTS google_subject TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS full_name TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS users_google_subject_idx
  ON users (google_subject) WHERE google_subject IS NOT NULL;

CREATE TABLE IF NOT EXISTS password_resets (
  email TEXT PRIMARY KEY,
  otp TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  sku TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  category_id UUID REFERENCES categories(id) ON DELETE SET NULL,
  price NUMERIC(12, 2) NOT NULL CHECK (price >= 0),
  image TEXT NOT NULL DEFAULT '',
  stock_quantity INTEGER NOT NULL DEFAULT 0 CHECK (stock_quantity >= 0),
  reorder_threshold INTEGER NOT NULL DEFAULT 0 CHECK (reorder_threshold >= 0),
  is_best_seller BOOLEAN NOT NULL DEFAULT FALSE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS products_category_created_idx
  ON products (category_id, created_at DESC);
CREATE INDEX IF NOT EXISTS products_low_stock_idx
  ON products (stock_quantity, id)
  WHERE stock_quantity <= reorder_threshold AND is_active = TRUE;
CREATE INDEX IF NOT EXISTS products_text_search_idx
  ON products USING GIN (to_tsvector('simple', name || ' ' || description));

CREATE TABLE IF NOT EXISTS addresses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  province TEXT NOT NULL,
  district TEXT NOT NULL,
  ward TEXT NOT NULL,
  street TEXT NOT NULL,
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS addresses_user_idx ON addresses (user_id);

CREATE TABLE IF NOT EXISTS cart_items (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, product_id)
);

CREATE TABLE IF NOT EXISTS vouchers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE,
  discount_type TEXT NOT NULL CHECK (discount_type IN ('fixed', 'percent')),
  discount_value NUMERIC(12, 2) NOT NULL CHECK (discount_value > 0),
  minimum_subtotal NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (minimum_subtotal >= 0),
  maximum_discount NUMERIC(12, 2) CHECK (maximum_discount IS NULL OR maximum_discount >= 0),
  usage_limit INTEGER CHECK (usage_limit IS NULL OR usage_limit > 0),
  used_count INTEGER NOT NULL DEFAULT 0 CHECK (used_count >= 0),
  starts_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS cod_settings (
  id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id = TRUE),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  fee NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (fee >= 0),
  free_shipping_threshold NUMERIC(12, 2),
  max_order_amount NUMERIC(12, 2),
  allowed_provinces TEXT[] NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO cod_settings (id) VALUES (TRUE) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_number TEXT NOT NULL UNIQUE,
  user_id UUID NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'pending_payment'
    CHECK (status IN ('pending_payment', 'confirmed', 'processing', 'picked_up', 'in_transit', 'shipped', 'delivered', 'cancelled')),
  payment_method TEXT NOT NULL CHECK (payment_method IN ('cod', 'vnpay', 'bank_qr')),
  payment_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (payment_status IN ('pending', 'paid', 'failed', 'refunded')),
  subtotal NUMERIC(12, 2) NOT NULL CHECK (subtotal >= 0),
  shipping_fee NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (shipping_fee >= 0),
  discount_amount NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (discount_amount >= 0),
  total NUMERIC(12, 2) NOT NULL CHECK (total >= 0),
  voucher_code TEXT,
  shipping_address JSONB NOT NULL,
  shipping_carrier TEXT,
  tracking_number TEXT,
  estimated_delivery_date DATE,
  delivery_note TEXT,
  customer_note TEXT,
  payment_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_expires_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_carrier TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS estimated_delivery_date DATE;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'orders'::regclass
      AND conname = 'orders_status_check'
      AND pg_get_constraintdef(oid) LIKE '%picked_up%'
      AND pg_get_constraintdef(oid) LIKE '%in_transit%'
  ) THEN
    ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_status_check;
    ALTER TABLE orders ADD CONSTRAINT orders_status_check
      CHECK (status IN ('pending_payment', 'confirmed', 'processing', 'picked_up', 'in_transit', 'shipped', 'delivered', 'cancelled'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'vouchers'::regclass
      AND conname = 'vouchers_maximum_discount_check'
  ) THEN
    ALTER TABLE vouchers ADD CONSTRAINT vouchers_maximum_discount_check
      CHECK (maximum_discount IS NULL OR maximum_discount >= 0) NOT VALID;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS orders_user_created_idx ON orders (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS orders_status_created_idx ON orders (status, created_at DESC);
CREATE INDEX IF NOT EXISTS orders_payment_expiry_idx
  ON orders (payment_expires_at)
  WHERE payment_status = 'pending' AND payment_expires_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS order_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id UUID REFERENCES products(id) ON DELETE SET NULL,
  product_name TEXT NOT NULL,
  unit_price NUMERIC(12, 2) NOT NULL CHECK (unit_price >= 0),
  quantity INTEGER NOT NULL CHECK (quantity > 0)
);
CREATE INDEX IF NOT EXISTS order_items_order_idx ON order_items (order_id);

CREATE TABLE IF NOT EXISTS product_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  order_id UUID REFERENCES orders(id) ON DELETE SET NULL,
  rating SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 10),
  comment TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (product_id, user_id)
);
CREATE INDEX IF NOT EXISTS product_reviews_product_idx
  ON product_reviews (product_id, created_at DESC);

CREATE TABLE IF NOT EXISTS favorites (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, product_id)
);

CREATE TABLE IF NOT EXISTS saved_items (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, product_id)
);

CREATE TABLE IF NOT EXISTS inventory_movements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  changed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  quantity_delta INTEGER NOT NULL CHECK (quantity_delta <> 0),
  stock_after INTEGER NOT NULL CHECK (stock_after >= 0),
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS inventory_movements_product_created_idx
  ON inventory_movements (product_id, created_at DESC);
CREATE INDEX IF NOT EXISTS inventory_movements_created_idx
  ON inventory_movements (created_at DESC);

CREATE TABLE IF NOT EXISTS payment_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  provider_reference TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

export const migrate = async (): Promise<void> => {
  await pool.query(migration);
};

if (require.main === module) {
  migrate()
    .then(() => {
      console.log("PostgreSQL schema is up to date");
    })
    .catch((error) => {
      console.error("Database migration failed:", error);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
