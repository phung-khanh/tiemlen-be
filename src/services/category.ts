import { pool } from "../config/db";

export const createCategory = async (name: string, description?: string) => {
  const { rows } = await pool.query(
    `INSERT INTO categories (name, description)
     VALUES ($1, $2)
     RETURNING id, name, description, created_at AS "createdAt", updated_at AS "updatedAt"`,
    [name.trim(), description?.trim() || null],
  );
  return { statusCode: 201, payload: rows[0] };
};

export const listCategories = async () => {
  const { rows } = await pool.query(
    `SELECT id, name, description, created_at AS "createdAt", updated_at AS "updatedAt"
     FROM categories ORDER BY name`,
  );
  return { statusCode: 200, payload: rows };
};

export const updateCategory = async (
  id: string,
  data: { name?: string; description?: string | null },
) => {
  const { rows } = await pool.query(
    `UPDATE categories
     SET name = COALESCE($2, name),
         description = CASE WHEN $3::boolean THEN $4 ELSE description END,
         updated_at = NOW()
     WHERE id = $1
     RETURNING id, name, description, created_at AS "createdAt", updated_at AS "updatedAt"`,
    [
      id,
      data.name?.trim() || null,
      data.description !== undefined,
      data.description?.trim() || null,
    ],
  );
  if (!rows[0])
    return { statusCode: 404, payload: { message: "Category not found" } };
  return { statusCode: 200, payload: rows[0] };
};

export const deleteCategory = async (id: string) => {
  const { rowCount } = await pool.query(
    "DELETE FROM categories WHERE id = $1",
    [id],
  );
  if (!rowCount)
    return { statusCode: 404, payload: { message: "Category not found" } };
  return {
    statusCode: 200,
    payload: { message: "Category deleted successfully" },
  };
};
