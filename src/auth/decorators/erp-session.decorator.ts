import { createParamDecorator, ExecutionContext } from "@nestjs/common";
import { ErpSessionContext } from "../interfaces/erp-session.interface";
import { ErpRequest } from "../guards/erp-session.guard";

// The session attached by ErpSessionGuard.
export const ErpSession = createParamDecorator((_data: unknown, ctx: ExecutionContext): ErpSessionContext => {
  return ctx.switchToHttp().getRequest<ErpRequest>().erpSession as ErpSessionContext;
});
