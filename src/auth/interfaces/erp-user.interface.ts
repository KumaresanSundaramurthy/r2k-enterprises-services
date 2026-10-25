// Column aliases match CI3's User_model so the cached `userinfo` row has the same shape in Redis.
// Values are strings (or null) because the ERP knex connection returns rows the way mysqli does.
export interface ErpUserRow {
  UserUID: string;
  UserFirstName: string | null;
  UserLastName: string | null;
  UserName: string;
  UserEmailAddress: string | null;
  UserPassword: string | null;
  IsLocked: string | null;
  UserRoleUID: string | null;
  UserRoleName: string | null;
  UserOrgUID: string | null;
  BranchUID: string | null;
  BranchName: string | null;
  BranchCode: string | null;
  UserOrgLogo: string | null;
  UserOrgCCode: string | null;
  UserOrgCISO2: string | null;
  UserOrgName: string | null;
  UserOrgBrandName: string | null;
  UserOrgMobile: string | null;
  Timezone: string | null;
  UserCountryCode: string | null;
  UserCountryISO2: string | null;
  UserMobileNumber: string | null;
  UserImage: string | null;
  OrgShortCode: string | null;
  OrgToken: string | null;
  OrgStateCode: string | null;
  OrgStateName: string | null;
  UILanguage: string | null;
  LastLoginOn: string | null;
  LastLoginDevice: string | null;
  LoginExpiryDateTime: string | null;
  AuthProvider: string | null;
  PasswordChangedOn: string | null;
  SectorUID: string | null;
  IsOnboardingComplete: string | null;
  OrgIsEmailVerified: string | null;
  OrgEmail: string | null;
}

export interface StepOneUserRow {
  UserUID: string;
  UserName: string;
  FirstName: string | null;
  LastName: string | null;
  IsLocked: string | null;
  Image: string | null;
  OrgUID: string | null;
  LoginExpiryDateTime: string | null;
  AuthProvider: string | null;
  Password: string | null;
  IsEmailVerified: string | null;
  OrgEmail: string | null;
}
