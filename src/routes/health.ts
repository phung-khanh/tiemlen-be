import { ListBucketsCommand, S3Client } from "@aws-sdk/client-s3";
import { Router } from "express";
import { pool } from "../config/db";
const healthRouter = Router();

healthRouter.get("/all", async (req, res) => {
  const checkDb = async () => {
    try {
      await pool.query("SELECT 1");
      return "ok";
    } catch (error) {
      console.error("PostgreSQL health check failed:", error);
      return "error";
    }
  };

  const checkR2 = async () => {
    try {
      const s3Client = new S3Client({
        region: "auto",
        endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
        credentials: {
          accessKeyId: process.env.R2_ACCESS_KEY_ID!,
          secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
        },
      });
      await s3Client.send(new ListBucketsCommand({}));
      return "ok";
    } catch (e) {
      return "error";
    }
  };

  const [dbStatus, r2Status] = await Promise.all([checkDb(), checkR2()]);

  const isHealthy = dbStatus === "ok" && r2Status === "ok";

  res.status(isHealthy ? 200 : 503).json({
    status: isHealthy ? "healthy" : "degraded",
    components: {
      database: dbStatus,
      r2: r2Status,
      server: "ok",
    },
    serverTime: new Date().toISOString(),
  });
});
export default healthRouter;
