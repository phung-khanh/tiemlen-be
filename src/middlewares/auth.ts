import dotenv from "dotenv";
import { NextFunction, Response } from "express";
import jwt from "jsonwebtoken";
import { pool } from "../config/db";
import { asyncHandler } from "../utils/asyncHandler";
import { AuthenticatedRequest } from "../types/authencation";
dotenv.config();

export const checkLogin = asyncHandler(
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    const [scheme, token] = (req.headers.authorization || "").split(" ");
    const secret = process.env.JWT_SECRET_KEY;
    if (scheme !== "Bearer" || !token || !secret) {
      return res.status(401).json({ message: "Authentication required." });
    }

    let decoded: jwt.JwtPayload;
    try {
      const verified = jwt.verify(token, secret);
      if (typeof verified === "string" || !verified.id || !verified.email) {
        return res.status(401).json({ message: "Invalid authentication token." });
      }
      decoded = verified;
    } catch {
      return res.status(401).json({ message: "Invalid authentication token." });
    }

    const { rows } = await pool.query<{
      id: string;
      email: string;
      role: "user" | "store_manager" | "admin";
    }>(
      `SELECT id, email, role FROM users
       WHERE id = $1 AND email = $2 AND is_active = TRUE`,
      [decoded.id, decoded.email],
    );
    if (!rows[0]) {
      return res.status(401).json({ message: "Account is unavailable." });
    }
    req.user = rows[0];
    next();
  }
);

export const isAdmin = asyncHandler(
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (req.user?.role !== "admin") {
      return res.status(403).json({ message: "Admin access required." });
    }
    next();
  }
);

export const isStoreStaff = asyncHandler(
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req.user || !["admin", "store_manager"].includes(req.user.role)) {
      return res.status(403).json({ message: "Store staff access required." });
    }
    next();
  }
);
