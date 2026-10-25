// The session blob stored in Redis under the JWT's `key` claim — same structure CI3 builds in formatJWTPayload.
export interface ErpSessionPayload {
  User: {
    UserUID: string | number;
    FirstName: string | null;
    LastName: string | null;
    UserName: string;
    EmailAddress: string | null;
    RoleUID: string | number | null;
    RoleName: string | null;
    OrgToken: string;
    SessionToken?: string;
    auditId?: number;
    [key: string]: unknown;
  };
  Org: {
    OrgUID: string | number;
    OrgToken: string;
    IsOnboardingComplete: number;
    [key: string]: unknown;
  };
  Subscription?: {
    PlanName: string;
    Status: string;
    EndDate: string;
    GracePeriodDays: number;
    IsExpired: boolean;
  };
  [key: string]: unknown;
}

// Claims of the cookie/Bearer JWT. The token only points at the Redis session; it carries no user data.
export interface ErpJwtClaims {
  key: string;
  iss?: string;
  iat?: number;
  nbf?: number;
  exp?: number;
}

export interface ErpSessionContext {
  key: string;
  token: string;
  data: ErpSessionPayload;
}
