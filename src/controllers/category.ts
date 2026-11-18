import * as categoryService from "../services/category";
import { asyncHandler } from "../utils/asyncHandler";

export const createCategory = asyncHandler(async (req, res) => {
  const { name, description } = req.body;
  const result = await categoryService.createCategory(name, description);
  res.status(result.statusCode).json(result.payload);
});

export const listCategories = asyncHandler(async (req, res) => {
  const result = await categoryService.listCategories();
  res.status(result.statusCode).json(result.payload);
});

export const updateCategory = asyncHandler(async (req, res) => {
  const id = req.params.id as string;
  const { name, description } = req.body;

  if (!id) {
    return res
      .status(400)
      .json({ message: "Genre ID is required in URL parameters" });
  }

  const result = await categoryService.updateCategory(id, {
    name,
    description,
  });
  res.status(result.statusCode).json(result.payload);
});

export const deleteCategory = asyncHandler(async (req, res) => {
  const id = req.params.id as string;

  const result = await categoryService.deleteCategory(id);
  res.status(result.statusCode).json(result.payload);
});

const categoryController = {
  createCategory,
  listCategories,
  updateCategory,
  deleteCategory,
};

export default categoryController;
