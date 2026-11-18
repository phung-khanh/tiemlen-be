import { Router } from "express";
import * as commerceController from "../controllers/commerce";
import {
  adjustInventory,
  createProduct,
  deleteProduct,
  getInventorySummary,
  getProduct,
  listInventoryMovements,
  listLowStock,
  listProducts,
  updateProduct,
} from "../controllers/product";
import { checkLogin, isStoreStaff } from "../middlewares/auth";

const productRouter = Router();

productRouter.get("/", listProducts);
productRouter.get("/:id/reviews", commerceController.getReviews);
productRouter.post("/:id/reviews", checkLogin, commerceController.createReview);
productRouter.get(
  "/inventory/summary",
  checkLogin,
  isStoreStaff,
  getInventorySummary,
);
productRouter.get(
  "/inventory/low-stock",
  checkLogin,
  isStoreStaff,
  listLowStock,
);
productRouter.get(
  "/:id/inventory",
  checkLogin,
  isStoreStaff,
  listInventoryMovements,
);
productRouter.patch(
  "/:id/inventory",
  checkLogin,
  isStoreStaff,
  adjustInventory,
);
productRouter.get("/:id", getProduct);
productRouter.post("/", checkLogin, isStoreStaff, createProduct);
productRouter.put("/:id", checkLogin, isStoreStaff, updateProduct);
productRouter.patch("/:id", checkLogin, isStoreStaff, updateProduct);
productRouter.delete("/:id", checkLogin, isStoreStaff, deleteProduct);

export default productRouter;
