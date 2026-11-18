import dotenv from "dotenv";
import { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";

dotenv.config();
interface AuthRequest extends Request {
  user?: { id: string; email?: string };
}

export const GuestUser = (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) => {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.split(" ")[1];

    try {
      const secret = process.env.JWT_SECRET_KEY;
      if (!secret) {
        console.error("JWT_SECRET_KEY is missing in env");
        return next();
      }
      const decoded = jwt.verify(token, secret) as {
        id: string;
        email?: string;
      };
      req.user = {
        id: decoded.id,
        email: decoded.email,
      };
    } catch (error) {
      req.user = undefined;
    }
  } else {
    req.user = undefined;
  }

  next();
};
