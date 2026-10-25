import { ApiProperty } from "@nestjs/swagger";
import { IsNotEmpty, IsString } from "class-validator";

export class GoogleTokenLoginDto {
  @ApiProperty({ description: "Google ID token (from Google Identity Services or a mobile SDK)" })
  @IsString()
  @IsNotEmpty()
  idToken!: string;
}

export class FacebookTokenLoginDto {
  @ApiProperty({ description: "Facebook user access token (from the Facebook SDK)" })
  @IsString()
  @IsNotEmpty()
  accessToken!: string;
}
