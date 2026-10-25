import { Injectable, UnauthorizedException } from "@nestjs/common";
import { PassportStrategy } from "@nestjs/passport";
import { ExtractJwt, Strategy } from "passport-jwt";
import { JwtPayload } from "../common/interfaces/jwt-payload.interface";

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor() {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: process.env.JWT_KEY as string,
    });
  }

  validate(payload: JwtPayload): JwtPayload {
    // ERP session tokens are signed with the same JWT_KEY but carry a Redis key instead of a shop userId.
    if (typeof payload.userId !== "number") {
      throw new UnauthorizedException();
    }
    return payload;
  }
}
