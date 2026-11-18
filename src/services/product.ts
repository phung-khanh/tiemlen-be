import { PoolClient } from "pg";
import { pool } from "../config/db";
import { Product, ProductInput } from "../models/product";

interface ProductRecord {
  id: string;
  name: string;
  sku: string;
  description: string;
  categoryId: string | null;
  category: string | null;
  price: string | number;
  image: string;
  stockQuantity: number;
  reorderThreshold: number;
  isBestSeller: boolean;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const productSelection = `
  SELECT p.id, p.name, p.sku, p.description, p.category_id AS "categoryId",
         c.name AS category, p.price, p.image,
         p.stock_quantity AS "stockQuantity",
         p.reorder_threshold AS "reorderThreshold",
         p.is_best_seller AS "isBestSeller", p.is_active AS "isActive",
         p.created_at AS "createdAt", p.updated_at AS "updatedAt"
  FROM products p
  LEFT JOIN categories c ON c.id = p.category_id
`;

const toProduct = (row: ProductRecord): Product => ({
  ...row,
  price: Number(row.price),
});

const getProduct = async (
  client: PoolClient,
  id: string,
): Promise<Product | null> => {
  const { rows } = await client.query<ProductRecord>(
    `${productSelection} WHERE p.id = $1`,
    [id],
  );
  return rows[0] ? toProduct(rows[0]) : null;
};

const resolveCategory = async (
  client: PoolClient,
  category: string | null | undefined,
): Promise<string | null> => {
  const name = category?.trim();
  if (!name) return null;
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO categories (name) VALUES ($1)
     ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    [name],
  );
  return rows[0].id;
};

const recordMovement = async (
  client: PoolClient,
  productId: string,
  changedBy: string | undefined,
  delta: number,
  stockAfter: number,
  reason: string,
) => {
  if (delta === 0) return;
  await client.query(
    `INSERT INTO inventory_movements
       (product_id, changed_by, quantity_delta, stock_after, reason)
     VALUES ($1, $2, $3, $4, $5)`,
    [productId, changedBy || null, delta, stockAfter, reason],
  );
};

export const listProducts = async ({
  page = 1,
  limit = 24,
  search,
  category,
  includeInactive = false,
  lowStock = false,
}: {
  page?: number;
  limit?: number;
  search?: string;
  category?: string;
  includeInactive?: boolean;
  lowStock?: boolean;
}) => {
  const safePage = Number.isFinite(page)
    ? Math.max(1, Math.floor(page))
    : 1;
  const safeLimit = Number.isFinite(limit)
    ? Math.min(100, Math.max(1, Math.floor(limit)))
    : 24;
  const offset = (safePage - 1) * safeLimit;
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (!includeInactive) conditions.push("p.is_active = TRUE");
  if (lowStock) conditions.push("p.stock_quantity <= p.reorder_threshold");
  if (search?.trim()) {
    values.push(search.trim());
    conditions.push(
      `to_tsvector('simple', p.name || ' ' || p.description) @@ plainto_tsquery('simple', $${values.length})`,
    );
  }
  if (category?.trim()) {
    values.push(category.trim());
    conditions.push(`(c.id::text = $${values.length} OR LOWER(c.name) = LOWER($${values.length}))`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const countResult = await pool.query<{ total: string }>(
    `SELECT COUNT(*) AS total FROM products p
     LEFT JOIN categories c ON c.id = p.category_id ${where}`,
    values,
  );
  const dataValues = [...values, safeLimit, offset];
  const dataResult = await pool.query<ProductRecord>(
    `${productSelection} ${where}
     ORDER BY p.created_at DESC
     LIMIT $${dataValues.length - 1} OFFSET $${dataValues.length}`,
    dataValues,
  );

  return {
    data: dataResult.rows.map(toProduct),
    total: Number(countResult.rows[0].total),
    page: safePage,
    limit: safeLimit,
  };
};

export const getInventorySummary = async () => {
  const { rows } = await pool.query<{
    product_count: string;
    stock_units: string;
    low_stock_count: string;
    inventory_value: string;
  }>(
    `SELECT
       COUNT(*) AS product_count,
       COALESCE(SUM(stock_quantity), 0) AS stock_units,
       COUNT(*) FILTER (
         WHERE stock_quantity <= reorder_threshold
       ) AS low_stock_count,
       COALESCE(SUM(price * stock_quantity), 0) AS inventory_value
     FROM products
     WHERE is_active = TRUE`,
  );
  const summary = rows[0];
  return {
    productCount: Number(summary.product_count),
    stockUnits: Number(summary.stock_units),
    lowStockCount: Number(summary.low_stock_count),
    inventoryValue: Number(summary.inventory_value),
  };
};

export const getProductById = async (id: string) => {
  const { rows } = await pool.query<ProductRecord>(
    `${productSelection} WHERE p.id = $1 AND p.is_active = TRUE`,
    [id],
  );
  return rows[0] ? toProduct(rows[0]) : null;
};

export const createProduct = async (
  input: ProductInput,
  changedBy?: string,
): Promise<Product> => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const categoryId = await resolveCategory(client, input.category);
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO products
         (name, sku, description, category_id, price, image, stock_quantity,
          reorder_threshold, is_best_seller, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id`,
      [
        input.name.trim(),
        input.sku.trim(),
        input.description?.trim() || "",
        categoryId,
        input.price,
        input.image?.trim() || "",
        input.stockQuantity ?? 0,
        input.reorderThreshold ?? 0,
        input.isBestSeller ?? false,
        input.isActive ?? true,
      ],
    );
    const productId = rows[0].id;
    await recordMovement(
      client,
      productId,
      changedBy,
      input.stockQuantity ?? 0,
      input.stockQuantity ?? 0,
      "Initial stock",
    );
    const product = await getProduct(client, productId);
    await client.query("COMMIT");
    if (!product) throw new Error("Created product could not be loaded");
    return product;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

export const updateProduct = async (
  id: string,
  input: Partial<ProductInput>,
  changedBy?: string,
): Promise<Product | null> => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{
      category_id: string | null;
      stock_quantity: number;
    }>(
      "SELECT category_id, stock_quantity FROM products WHERE id = $1 FOR UPDATE",
      [id],
    );
    if (!rows[0]) {
      await client.query("ROLLBACK");
      return null;
    }

    const categoryId =
      input.category === undefined
        ? rows[0].category_id
        : await resolveCategory(client, input.category);
    const stockQuantity = input.stockQuantity ?? rows[0].stock_quantity;
    const { rowCount } = await client.query(
      `UPDATE products
       SET name = COALESCE($2, name),
           sku = COALESCE($3, sku),
           description = COALESCE($4, description),
           category_id = $5,
           price = COALESCE($6, price),
           image = COALESCE($7, image),
           stock_quantity = $8,
           reorder_threshold = COALESCE($9, reorder_threshold),
           is_best_seller = COALESCE($10, is_best_seller),
           is_active = COALESCE($11, is_active),
           updated_at = NOW()
       WHERE id = $1`,
      [
        id,
        input.name?.trim() || null,
        input.sku?.trim() || null,
        input.description?.trim(),
        categoryId,
        input.price ?? null,
        input.image?.trim(),
        stockQuantity,
        input.reorderThreshold ?? null,
        input.isBestSeller ?? null,
        input.isActive ?? null,
      ],
    );
    if (!rowCount) {
      await client.query("ROLLBACK");
      return null;
    }

    const stockDelta = stockQuantity - rows[0].stock_quantity;
    await recordMovement(
      client,
      id,
      changedBy,
      stockDelta,
      stockQuantity,
      "Product update",
    );
    const product = await getProduct(client, id);
    await client.query("COMMIT");
    return product;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

export const deactivateProduct = async (id: string) => {
  const { rowCount } = await pool.query(
    "UPDATE products SET is_active = FALSE, updated_at = NOW() WHERE id = $1 AND is_active = TRUE",
    [id],
  );
  return Boolean(rowCount);
};

export const adjustInventory = async (
  id: string,
  delta: number,
  reason: string,
  changedBy?: string,
): Promise<{ product: Product | null; error?: "not_found" | "insufficient_stock" }> => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ stock_quantity: number }>(
      "SELECT stock_quantity FROM products WHERE id = $1 AND is_active = TRUE FOR UPDATE",
      [id],
    );
    if (!rows[0]) {
      await client.query("ROLLBACK");
      return { product: null, error: "not_found" };
    }

    const stockAfter = rows[0].stock_quantity + delta;
    if (stockAfter < 0) {
      await client.query("ROLLBACK");
      return { product: null, error: "insufficient_stock" };
    }

    await client.query(
      "UPDATE products SET stock_quantity = $2, updated_at = NOW() WHERE id = $1",
      [id, stockAfter],
    );
    await recordMovement(client, id, changedBy, delta, stockAfter, reason.trim());
    const product = await getProduct(client, id);
    await client.query("COMMIT");
    return { product };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

export const getInventoryMovements = async (id: string, limit = 100) => {
  const { rows } = await pool.query(
    `SELECT id, quantity_delta AS "quantityDelta", stock_after AS "stockAfter",
            reason, created_at AS "createdAt", changed_by AS "changedBy"
     FROM inventory_movements
     WHERE product_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [id, Math.min(500, Math.max(1, Math.floor(limit)))],
  );
  return rows;
};
