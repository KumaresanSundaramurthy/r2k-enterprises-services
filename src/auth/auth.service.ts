import { ConflictException, Injectable, NotFoundException, UnauthorizedException } from "@nestjs/common";
import * as bcrypt from "bcryptjs";
import { JwtService } from "@nestjs/jwt";
import { UserRecord, UserRepository } from "./user.repository";
import { RegisterDto } from "./dto/register.dto";
import { LoginDto } from "./dto/login.dto";
import { JwtPayload } from "../common/interfaces/jwt-payload.interface";

@Injectable()
export class AuthService {
  constructor(
    private readonly userRepository: UserRepository,
    private readonly jwtService: JwtService
  ) {}

  async register(dto: RegisterDto) {
    const email = dto.email.toLowerCase();
    const existing = await this.userRepository.findByEmail(email);
    if (existing) {
      throw new ConflictException("Email already registered");
    }

    const hashedPassword = await bcrypt.hash(dto.password, 10);
    const orgUID = Number(process.env.DEFAULT_ORG_UID);
    const user = await this.userRepository.create({
      name: dto.name,
      email,
      password: hashedPassword,
      orgUID,
    });

    return this.buildAuthResponse(user);
  }

  async login(dto: LoginDto) {
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

  async getMe(userId: number) {
    const user = await this.userRepository.findById(userId);
    if (!user) {
      throw new NotFoundException("User not found");
    }
    return {
      user: {
        userUID: user.userUID,
        orgUID: user.orgUID,
        name: user.name,
        email: user.email,
        role: user.role,
        createdOn: user.createdOn,
        updatedOn: user.updatedOn,
      },
    };
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
