import { Response } from "express";
import * as productService from "../services/product";
import { AuthenticatedRequest } from "../types/authencation";
import { asyncHandler } from "../utils/asyncHandler";
import {
  inventoryAdjustmentSchema,
  productInputSchema,
  productUpdateSchema,
} from "../validation/product";

const isUuid = (value: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );

const getParamId = (value: string | string[] | undefined) =>
  Array.isArray(value) ? value[0] || "" : value || "";

export const listProducts = asyncHandler(async (req, res) => {
  const { page = "1", limit = "24", search, category } = req.query;
  const result = await productService.listProducts({
    page: Number(page),
    limit: Number(limit),
    search: typeof search === "string" ? search : undefined,
    category: typeof category === "string" ? category : undefined,
  });
  res.json(result);
});

export const getProduct = asyncHandler(async (req, res) => {
  const id = getParamId(req.params.id);
  if (!isUuid(id)) return res.status(400).json({ message: "Invalid product id" });
  const product = await productService.getProductById(id);
  if (!product) return res.status(404).json({ message: "Product not found" });
  res.json(product);
});

export const createProduct = asyncHandler(
  async (req: AuthenticatedRequest, res: Response) => {
    const input = await productInputSchema.validate(req.body, {
      abortEarly: false,
      stripUnknown: true,
    });
    const product = await productService.createProduct(input, req.user?.id);
    res.status(201).json(product);
  },
);

export const updateProduct = asyncHandler(
  async (req: AuthenticatedRequest, res: Response) => {
    const id = getParamId(req.params.id);
    if (!isUuid(id)) return res.status(400).json({ message: "Invalid product id" });
    const input = await productUpdateSchema.validate(req.body, {
      abortEarly: false,
      stripUnknown: true,
    });
    const product = await productService.updateProduct(id, input, req.user?.id);
    if (!product) return res.status(404).json({ message: "Product not found" });
    res.json(product);
  },
);

export const deleteProduct = asyncHandler(async (req, res) => {
  const id = getParamId(req.params.id);
  if (!isUuid(id)) return res.status(400).json({ message: "Invalid product id" });
  const deleted = await productService.deactivateProduct(id);
  if (!deleted) return res.status(404).json({ message: "Product not found" });
  res.status(204).end();
});

export const adjustInventory = asyncHandler(
  async (req: AuthenticatedRequest, res: Response) => {
    const id = getParamId(req.params.id);
    if (!isUuid(id)) return res.status(400).json({ message: "Invalid product id" });
    const { delta, reason } = await inventoryAdjustmentSchema.validate(
      req.body,
      { abortEarly: false, stripUnknown: true },
    );
    const result = await productService.adjustInventory(
      id,
      delta,
      reason,
      req.user?.id,
    );
    if (result.error === "not_found")
      return res.status(404).json({ message: "Product not found" });
    if (result.error === "insufficient_stock")
      return res.status(409).json({ message: "Stock cannot be negative" });
    res.json(result.product);
  },
);

export const listInventoryMovements = asyncHandler(async (req, res) => {
  const id = getParamId(req.params.id);
  if (!isUuid(id)) return res.status(400).json({ message: "Invalid product id" });
  const product = await productService.getProductById(id);
  if (!product) return res.status(404).json({ message: "Product not found" });
  const movements = await productService.getInventoryMovements(
    id,
    Number(req.query.limit) || 100,
  );
  res.json(movements);
});

export const listLowStock = asyncHandler(async (req, res) => {
  const result = await productService.listProducts({
    page: Number(req.query.page) || 1,
    limit: Number(req.query.limit) || 100,
    search: typeof req.query.search === "string" ? req.query.search : undefined,
    lowStock: true,
    includeInactive: false,
  });
  res.json(result);
});

export const getInventorySummary = asyncHandler(async (req, res) => {
  const summary = await productService.getInventorySummary();
  res.json(summary);
});
