import express from "express";
import AuthController from "../controllers/auth";
import { checkLogin } from "../middlewares/auth";

const authRouter = express.Router();

authRouter.post("/google", AuthController.googleSignIn);
authRouter.get("/me", checkLogin, AuthController.getMe);
authRouter.patch("/me", checkLogin, AuthController.updateMe);

export default authRouter;
