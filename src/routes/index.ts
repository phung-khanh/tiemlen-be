import express from "express";
import authRouter from "./auth";
import categoryRouter from "./category";
import healthRouter from "./health";
import productRouter from "./product";
import commerceRouter from "./commerce";

const router = express.Router();

// Authentication routes
router.use("/auth", authRouter);

router.use("/products", productRouter);
router.use("/", commerceRouter);
router.use("/categories", categoryRouter);
router.use("/health", healthRouter);

export default router;
