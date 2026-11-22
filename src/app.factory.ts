import { ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { NestExpressApplication } from "@nestjs/platform-express";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { AppModule } from "./app.module";
import { AllExceptionsFilter } from "./common/filters/all-exceptions.filter";

// Shared by the long-running server (main.ts) and the Vercel function (serverless.ts).
export async function createApp(): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true });
  // Behind a proxy (Vercel/Render): use the client IP from X-Forwarded-For (login rate limiting and audit rely on it)
  app.set("trust proxy", Number(process.env.TRUST_PROXY_HOPS ?? 1));

  const allowedOrigins = (process.env.CLIENT_URL || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  /* CLIENT_URL="*"  → echo the caller's Origin back (works with credentials too)
     CLIENT_URL unset → same safe default (never use the literal "*" string since that breaks credentials) */
  const origin = allowedOrigins.includes("*") || allowedOrigins.length === 0 ? true : allowedOrigins;
  // maxAge: the browser caches the preflight (OPTIONS) result per URL instead of repeating it before every call
  app.enableCors({ origin, credentials: true, maxAge: 86400 });

  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new AllExceptionsFilter());

  /* Skip Swagger on Vercel: scanning 50+ modules synchronously adds 3-5 s to every cold start,
     pushing it past Vercel's 10 s function timeout and returning 500 on the first request.
     VERCEL=1 is injected automatically by Vercel at build and runtime. */
  if (!process.env.VERCEL) {
    const swaggerConfigBuilder = new DocumentBuilder()
      .setTitle("R2K Enterprises Services API")
      .setDescription(
        "Common backend services for R2K Enterprises — auth, products (MySQL-backed ERP catalog), cart, orders and Razorpay payments."
      )
      .setVersion("1.0.0")
      .addBearerAuth();

    const swaggerDocument = SwaggerModule.createDocument(app, swaggerConfigBuilder.build());
    SwaggerModule.setup("api-docs", app, swaggerDocument, {
      customSiteTitle: "R2K Enterprises Services API Docs",
    });
  }

  return app;
}
