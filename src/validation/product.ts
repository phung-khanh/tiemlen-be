import * as yup from "yup";

export const productInputSchema = yup.object({
  name: yup.string().trim().min(1).max(200).required(),
  sku: yup.string().trim().min(1).max(100).required(),
  description: yup.string().max(10000).optional(),
  category: yup.string().trim().max(100).optional(),
  price: yup.number().min(0).required(),
  image: yup.string().max(2048).optional(),
  stockQuantity: yup.number().integer().min(0).optional(),
  reorderThreshold: yup.number().integer().min(0).optional(),
  isBestSeller: yup.boolean().optional(),
  isActive: yup.boolean().optional(),
});

export const productUpdateSchema = productInputSchema
  .partial()
  .test(
    "non-empty-update",
    "At least one product field is required",
    (value) => Object.keys(value || {}).length > 0,
  );

export const inventoryAdjustmentSchema = yup.object({
  delta: yup.number().integer().notOneOf([0]).required(),
  reason: yup.string().trim().min(1).max(500).required(),
});
