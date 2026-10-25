import "reflect-metadata";
import dotenv from "dotenv";
dotenv.config();

import { createApp } from "./app.factory";
import { connectMySQL } from "./config/mysql";

async function bootstrap(): Promise<void> {
  await connectMySQL();

  const app = await createApp();
  const PORT = process.env.PORT || 5000;
  await app.listen(PORT);
  console.log(`r2k-enterprises-services running on port ${PORT}`);
}

bootstrap().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
