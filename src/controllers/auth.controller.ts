import { Request, Response } from "express";
import bcrypt from "bcryptjs";
import * as userRepo from "../repositories/user.repository";
import { signJwt } from "../utils/jwt";

export async function register(req: Request, res: Response): Promise<void> {
  const { name, email, password } = req.body as {
    name: string;
    email: string;
    password: string;
  };

  if (!name || !email || !password) {
    res.status(400).json({ message: "name, email and password are required" });
    return;
  }

  const existing = await userRepo.findUserByEmail(email.toLowerCase());
  if (existing) {
    res.status(409).json({ message: "Email already registered" });
    return;
  }

  const hashedPassword = await bcrypt.hash(password, 10);
  const orgUID = Number(process.env.DEFAULT_ORG_UID);
  const user = await userRepo.createUser({ name, email: email.toLowerCase(), password: hashedPassword, orgUID });

  const token = signJwt({ userId: user.userUID, role: user.role, orgUID: user.orgUID });
  res.status(201).json({
    token,
    user: { userUID: user.userUID, name: user.name, email: user.email, role: user.role },
  });
}

export async function login(req: Request, res: Response): Promise<void> {
  const { email, password } = req.body as { email: string; password: string };

  if (!email || !password) {
    res.status(400).json({ message: "email and password are required" });
    return;
  }

  const user = await userRepo.findUserByEmail(email.toLowerCase());
  if (!user) {
    res.status(401).json({ message: "Invalid email or password" });
    return;
  }

  const isMatch = await bcrypt.compare(password, user.password);
  if (!isMatch) {
    res.status(401).json({ message: "Invalid email or password" });
    return;
  }

  const token = signJwt({ userId: user.userUID, role: user.role, orgUID: user.orgUID });
  res.status(200).json({
    token,
    user: { userUID: user.userUID, name: user.name, email: user.email, role: user.role },
  });
}

export async function getMe(req: Request, res: Response): Promise<void> {
  const user = await userRepo.findUserById(req.user!.userId);
  if (!user) {
    res.status(404).json({ message: "User not found" });
    return;
  }
  res.status(200).json({
    user: {
      userUID: user.userUID,
      orgUID: user.orgUID,
      name: user.name,
      email: user.email,
      role: user.role,
      createdOn: user.createdOn,
      updatedOn: user.updatedOn,
    },
  });
}
