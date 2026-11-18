import * as authService from "../services/googleAuth";
import { asyncHandler } from "../utils/asyncHandler";
import { AuthenticatedRequest } from "../types/authencation";

export const googleSignIn = asyncHandler(async (req, res) => {
  const credential =
    typeof req.body?.credential === "string" ? req.body.credential : "";
  if (!credential || credential.length > 10_000) {
    return res.status(400).json({ message: "Google credential is required." });
  }
  const result = await authService.signInWithGoogle(credential);
  res.status(result.statusCode).json(result.payload);
});

export const getMe = asyncHandler(async (req: AuthenticatedRequest, res) => {
  const user = await authService.getCurrentUser(req.user!.id);
  if (!user) return res.status(404).json({ message: "User not found." });
  res.json(user);
});

export const updateMe = asyncHandler(async (req: AuthenticatedRequest, res) => {
  const fullName =
    typeof req.body?.fullName === "string" ? req.body.fullName : "";
  const phone = typeof req.body?.phone === "string" ? req.body.phone : "";
  if (!fullName.trim() || !phone.trim()) {
    return res.status(400).json({ message: "Name and phone are required." });
  }
  const user = await authService.updateCurrentUser(req.user!.id, {
    fullName,
    phone,
  });
  if (!user) return res.status(404).json({ message: "User not found." });
  res.json(user);
});

const AuthController = {
  googleSignIn,
  getMe,
  updateMe,
};

export default AuthController;
