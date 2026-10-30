import { Controller, Get, Header } from "@nestjs/common";
import { ApiExcludeController, ApiOperation, ApiTags } from "@nestjs/swagger";

@ApiExcludeController()
@Controller()
export class AppController {
  @Get()
  root() {
    return {
      message: "Welcome to r2k-enterprises-services API",
      docs: "/api-docs",
      health: "/health",
    };
  }

  @Get("health")
  health() {
    return { status: "ok" };
  }
}

// CI3's Ping::check — internet_monitor.js times this call to detect offline / slow connections (no auth, no DB).
@ApiTags("Ping")
@Controller("api/ping")
export class PingController {
  @Get("check")
  @Header("Cache-Control", "no-store")
  @ApiOperation({ summary: "Connection check: { status: 'ok', timestamp } (Unix seconds)" })
  check() {
    return { status: "ok", timestamp: Math.floor(Date.now() / 1000) };
  }
}
