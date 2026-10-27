import { ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { NestExpressApplication } from "@nestjs/platform-express";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { AppModule } from "./app.module";
import { AllExceptionsFilter } from "./common/filters/all-exceptions.filter";

// Shared by the long-running server (main.ts) and the Vercel function (serverless.ts).
export async function createApp(): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  // Behind a proxy (Vercel/Render): use the client IP from X-Forwarded-For (login rate limiting and audit rely on it)
  app.set("trust proxy", Number(process.env.TRUST_PROXY_HOPS ?? 1));

  const allowedOrigins = (process.env.CLIENT_URL || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  // CLIENT_URL="*" allows any origin (the request's origin is echoed back, so cookies/credentials also work)
  const origin = allowedOrigins.includes("*") ? true : allowedOrigins.length > 0 ? allowedOrigins : undefined;
  app.enableCors({ origin, credentials: true });

  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new AllExceptionsFilter());

  const swaggerConfigBuilder = new DocumentBuilder()
    .setTitle("R2K Enterprises Services API")
    .setDescription(
      "Common backend services for R2K Enterprises — auth, products (MySQL-backed ERP catalog), cart, orders and Razorpay payments."
    )
    .setVersion("1.0.0")
    .addBearerAuth();

  // No servers listed: OpenAPI then defaults to the host the docs page was loaded from (Vercel or localhost),
  // and Swagger UI hides the Servers dropdown.

  const swaggerDocument = SwaggerModule.createDocument(app, swaggerConfigBuilder.build());
  SwaggerModule.setup("api-docs", app, swaggerDocument, {
    customSiteTitle: "R2K Enterprises Services API Docs",
  });

  return app;
}
