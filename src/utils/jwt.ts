import jwt from "jsonwebtoken";

export interface JwtPayload {
  userId: number;
  role: string;
  orgUID: number;
}

export function signJwt(payload: JwtPayload): string {
  const secret = process.env.JWT_KEY as string;
  const expiresIn = process.env.JWT_EXPIRES_IN || "7d";
  return jwt.sign(payload, secret, { expiresIn } as jwt.SignOptions);
}

export function verifyJwt(token: string): JwtPayload {
  const secret = process.env.JWT_KEY as string;
  return jwt.verify(token, secret) as JwtPayload;
}
