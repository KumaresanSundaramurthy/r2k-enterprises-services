import { ConflictException, Injectable, UnauthorizedException } from "@nestjs/common";
import * as bcrypt from "bcryptjs";
import { JwtService } from "@nestjs/jwt";
import { UserRecord, UserRepository } from "./user.repository";
import { ShopRegisterDto } from "./dto/register.dto";
import { ShopLoginDto } from "./dto/login.dto";
import { JwtPayload } from "../common/interfaces/jwt-payload.interface";

@Injectable()
export class ShopAuthService {
  constructor(
    private readonly userRepository: UserRepository,
    private readonly jwtService: JwtService
  ) {}

  async register(dto: ShopRegisterDto) {
    const email = dto.email.toLowerCase();
    const existing = await this.userRepository.findByEmail(email);
    if (existing) {
      throw new ConflictException("Email already registered");
    }

    const hashedPassword = await bcrypt.hash(dto.password, 10);
    const user = await this.userRepository.create({
      name: dto.name,
      email,
      password: hashedPassword,
      orgUID: dto.orgId,
    });

    return this.buildAuthResponse(user);
  }

  async login(dto: ShopLoginDto) {
    const user = await this.userRepository.findByEmail(dto.email.toLowerCase());
    if (!user) {
      throw new UnauthorizedException("Invalid email or password");
    }

    const isMatch = await bcrypt.compare(dto.password, user.password);
    if (!isMatch) {
      throw new UnauthorizedException("Invalid email or password");
    }

    return this.buildAuthResponse(user);
  }

  private buildAuthResponse(user: UserRecord) {
    const payload: JwtPayload = { userId: user.userUID, role: user.role, orgUID: user.orgUID };
    const token = this.jwtService.sign(payload);
    return {
      token,
      user: { userUID: user.userUID, name: user.name, email: user.email, role: user.role },
    };
  }
}
