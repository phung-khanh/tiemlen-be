import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import morgan from "morgan";
import router from "./routes/index";
import { HttpError } from "./utils/httpError";

dotenv.config();

const app = express();

const allowedOrigins = (process.env.FRONTEND_URLS || "")
  .split(",")
  .map((url) => url.trim())
  .filter(Boolean);

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: {
    error: "Too many requests from this IP, please try again later.",
  },
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(helmet());
app.use(morgan("dev"));
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

app.use(
  cors({
    origin: allowedOrigins,
    credentials: true,
  }),
);

app.use("/api", limiter, router);

app.use(
  (
    error: any,
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    if (res.headersSent) return next(error);

    const statusCode =
      error instanceof HttpError
        ? error.statusCode
        : error?.name === "ValidationError"
          ? 400
          : error?.code === "23505"
            ? 409
            : error?.code === "23514" || error?.code === "22P02"
              ? 400
              : 500;
    console.error("Request failed:", error);
    res.status(statusCode).json({
      message:
        statusCode === 500
          ? "Internal server error"
          : error.message || "Invalid request",
    });
  },
);

export default app;
