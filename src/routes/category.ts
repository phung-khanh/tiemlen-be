import { Router } from "express";
import categoryController from "../controllers/category";
import { checkLogin, isStoreStaff } from "../middlewares/auth";

const categoryRouter = Router();

categoryRouter.get("/", categoryController.listCategories);

categoryRouter.post(
  "/",
  checkLogin,
  isStoreStaff,
  categoryController.createCategory
);

categoryRouter.patch(
  "/:id",
  checkLogin,
  isStoreStaff,
  categoryController.updateCategory
);

categoryRouter.delete(
  "/:id",
  checkLogin,
  isStoreStaff,
  categoryController.deleteCategory
);

export default categoryRouter;
