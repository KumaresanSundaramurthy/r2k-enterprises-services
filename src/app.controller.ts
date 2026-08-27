import { Controller, Get } from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";

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
