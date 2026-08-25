import dotenv from "dotenv";
dotenv.config();

import { createApp } from "./app";
import { connectMySQL } from "./config/mysql";

const PORT = process.env.PORT || 5000;

async function startServer(): Promise<void> {
  await connectMySQL();
  const app = createApp();
  app.listen(PORT, () => {
    console.log(`r2k-enterprises-services running on port ${PORT}`);
  });
}

startServer().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
