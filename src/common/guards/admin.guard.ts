import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from "@nestjs/common";
import { Request } from "express";
import { JwtPayload } from "../interfaces/jwt-payload.interface";

@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request & { user: JwtPayload }>();
    if (request.user?.role !== "admin") {
      throw new ForbiddenException("Admin access required");
    }
    return true;
  }
}
