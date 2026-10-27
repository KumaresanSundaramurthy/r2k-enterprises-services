import { Request } from "express";

/** Who is writing and from where — passed to repositories, the ledger and the audit log. */
export interface WriteContext {
  orgUID: number;
  userUID: number;
  branchUID: number | null;
  ipAddress: string;
  userAgent: string;
}

export function writeContext(dto: { orgId: number; userId: number; branchId?: number }, req: Request): WriteContext {
  return {
    orgUID: dto.orgId,
    userUID: dto.userId,
    branchUID: dto.branchId ?? null,
    ipAddress: req.ip || "",
    userAgent: req.headers["user-agent"] || "",
  };
}
