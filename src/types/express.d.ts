declare namespace Express {
  interface Request {
    user?: {
      userId: number;
      role: string;
      orgUID: number;
    };
  }
}
