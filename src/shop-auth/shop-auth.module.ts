import { Module } from "@nestjs/common";
import { JwtModule, JwtModuleOptions } from "@nestjs/jwt";
import { PassportModule } from "@nestjs/passport";
import { ShopAuthController } from "./shop-auth.controller";
import { ShopAuthService } from "./shop-auth.service";
import { UserRepository } from "./user.repository";
import { JwtStrategy } from "./jwt.strategy";

@Module({
  imports: [
    PassportModule.register({ defaultStrategy: "jwt" }),
    JwtModule.register({
      secret: process.env.JWT_KEY,
      signOptions: { expiresIn: process.env.JWT_EXPIRES_IN || "7d" } as JwtModuleOptions["signOptions"],
    }),
  ],
  controllers: [ShopAuthController],
  providers: [ShopAuthService, UserRepository, JwtStrategy],
})
export class ShopAuthModule {}
