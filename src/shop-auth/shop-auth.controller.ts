import { Body, Controller, HttpCode, HttpStatus, Post } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { ShopAuthService } from "./shop-auth.service";
import { RegisterDto } from "./dto/register.dto";
import { LoginDto } from "./dto/login.dto";

@ApiTags("Shop Auth")
@Controller("api/shop/auth")
export class ShopAuthController {
  constructor(private readonly shopAuthService: ShopAuthService) {}

  @Post("register")
  @ApiOperation({ summary: "Register a new shop customer" })
  register(@Body() dto: RegisterDto) {
    return this.shopAuthService.register(dto);
  }

  @Post("login")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Log in a shop customer with email and password" })
  login(@Body() dto: LoginDto) {
    return this.shopAuthService.login(dto);
  }
}
