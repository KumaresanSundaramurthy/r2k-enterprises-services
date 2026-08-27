import "reflect-metadata";
import dotenv from "dotenv";
dotenv.config();

import { NestFactory } from "@nestjs/core";
import { ValidationPipe } from "@nestjs/common";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { AppModule } from "./app.module";
import { AllExceptionsFilter } from "./common/filters/all-exceptions.filter";
import { connectMySQL } from "./config/mysql";

async function bootstrap(): Promise<void> {
  await connectMySQL();

  const app = await NestFactory.create(AppModule);

  const allowedOrigins = (process.env.CLIENT_URL || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  app.enableCors({ origin: allowedOrigins.length > 0 ? allowedOrigins : undefined, credentials: true });

  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new AllExceptionsFilter());

  const PORT = process.env.PORT || 5000;

  const swaggerConfigBuilder = new DocumentBuilder()
    .setTitle("R2K Enterprises Services API")
    .setDescription(
      "Common backend services for R2K Enterprises — auth, products (MySQL-backed ERP catalog), cart, orders and Razorpay payments."
    )
    .setVersion("1.0.0")
    .addBearerAuth();

  if (process.env.RENDER_EXTERNAL_URL) {
    swaggerConfigBuilder.addServer(process.env.RENDER_EXTERNAL_URL, "Production server");
  }
  swaggerConfigBuilder.addServer(`http://localhost:${PORT}`, "Local server");

  const swaggerDocument = SwaggerModule.createDocument(app, swaggerConfigBuilder.build());
  SwaggerModule.setup("api-docs", app, swaggerDocument, {
    customSiteTitle: "R2K Enterprises Services API Docs",
  });

  await app.listen(PORT);
  console.log(`r2k-enterprises-services running on port ${PORT}`);
}

bootstrap().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
