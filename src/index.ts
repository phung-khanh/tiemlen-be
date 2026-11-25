import dotenv from "dotenv";
import app from "./app";
import connectDB from "./config/db";
import { migrate } from "./db/migrate";
import { expireUnpaidOrders } from "./services/commerce";

dotenv.config();

const PORT = process.env.PORT || 4000;

const start = async () => {
  await connectDB();
  await migrate();
  const expireOrders = () => {
    void expireUnpaidOrders().catch((error: unknown) => {
      console.error("Could not release expired payment reservations:", error);
    });
  };
  expireOrders();
  const expiryTimer = setInterval(expireOrders, 60_000);
  expiryTimer.unref();
  app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
  });
};

start().catch((error) => {
  console.error("Server startup failed:", error);
  process.exitCode = 1;
});
