import dotenv from "dotenv";
import { Pool } from "pg";

dotenv.config();

const connectionString = process.env.DATABASE_URL;

export const pool = new Pool({
  connectionString,
});

pool.on("error", (error) => {
  console.error("Unexpected PostgreSQL pool error:", error);
});

export const connectDB = async (): Promise<void> => {
  if (!connectionString) {
    throw new Error("DATABASE_URL is not defined");
  }

  try {
    await pool.query("SELECT 1");
    console.log("Connected to PostgreSQL (Pooler)");
  } catch (error) {
    console.error("Failed to connect to database:", error);
    throw error;
  }
};

export default connectDB;
