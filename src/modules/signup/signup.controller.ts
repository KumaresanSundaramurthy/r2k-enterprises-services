import { Controller, Get, Query, UseFilters, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiTags } from "@nestjs/swagger";
import { Allow, isEmail } from "class-validator";
import { erpKnexRead } from "../../config/erp-knex";
import { CiJwtGuard } from "../../common/guards/ci-jwt.guard";
import { CiExceptionFilter } from "../../core/response/ci-exception.filter";
import { ciSuccess } from "../../core/response/ci-response";

export class SignupMobileQueryDto {
  @ApiProperty({ example: "9876543210", description: "10-digit mobile number" }) @Allow() mobile?: string;
}

export class SignupGstinQueryDto {
  @ApiProperty({ example: "33AAAAA0000A1Z5", description: "GSTIN (15 characters)" }) @Allow() gstin?: string;
}

export class SignupEmailQueryDto {
  @ApiProperty({ example: "owner@example.com" }) @Allow() email?: string;
}

export class SignupUsernameQueryDto {
  @ApiProperty({ example: "owner01" }) @Allow() username?: string;
}

const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;

/** CI3 Signup availability checks for the public signup / onboarding pages (called with PublicServiceToken). */
@ApiTags("Signup")
@ApiBearerAuth()
@UseGuards(CiJwtGuard)
@UseFilters(CiExceptionFilter)
@Controller("api/signup")
export class SignupController {
  // Signup::getPlans + Signup_model::getActivePlans — active sector plans, cheapest first
  @Get("getPlans")
  @ApiOperation({ summary: "Active plans for the signup page (Plans: SectorPlanUID, Price, DurationDays, MaxUsers, MaxBranches, PlanName, PlanCode, BillingCycle)" })
  async getPlans() {
    const plans = await erpKnexRead("Billing.SectorPlanTbl as SPT")
      .join("Billing.SubscriptionPlansTbl as SP", "SP.PlanUID", "SPT.PlanUID")
      .select("SPT.SectorPlanUID", "SPT.Price", "SPT.DurationDays", "SPT.MaxUsers", "SPT.MaxBranches", "SP.PlanName", "SP.PlanCode", "SP.BillingCycle")
      .where("SPT.IsActive", 1)
      .orderBy("SPT.Price", "asc");
    return ciSuccess({ Plans: plans });
  }

  // Signup::checkMobile + Signup_model::isMobileTaken — taken when any org or user already has the number
  @Get("checkMobile")
  @ApiOperation({ summary: "Is the mobile free for a new signup? {available} — checks OrganisationTbl and UserTbl" })
  async checkMobile(@Query() dto: SignupMobileQueryDto) {
    const mobile = String(dto.mobile ?? "").trim().replace(/\D/g, "");
    if (mobile.length !== 10) {
      return ciSuccess({ available: false }, "Invalid mobile number");
    }
    const inOrg = await erpKnexRead("Organisation.OrganisationTbl").where({ MobileNumber: mobile, IsDeleted: 0 }).first("OrgUID");
    if (inOrg) return ciSuccess({ available: false });
    const inUser = await erpKnexRead("Users.UserTbl").where({ MobileNumber: mobile, IsDeleted: 0 }).first("UserUID");
    return ciSuccess({ available: !inUser });
  }

  // Signup::checkEmail + Signup_model::isEmailTaken — taken when any user already has the email
  @Get("checkEmail")
  @ApiOperation({ summary: "Is the email free for a new signup? {available} — checks UserTbl" })
  async checkEmail(@Query() dto: SignupEmailQueryDto) {
    const email = String(dto.email ?? "").trim().toLowerCase();
    if (!isEmail(email)) {
      return ciSuccess({ available: false }, "Invalid email");
    }
    const inUser = await erpKnexRead("Users.UserTbl").where({ EmailAddress: email, IsDeleted: 0 }).first("UserUID");
    return ciSuccess({ available: !inUser });
  }

  // Signup::checkUsername + Signup_model::isUsernameTaken — taken when any user already has the username
  @Get("checkUsername")
  @ApiOperation({ summary: "Is the username free for a new signup? {available} — checks UserTbl" })
  async checkUsername(@Query() dto: SignupUsernameQueryDto) {
    const username = String(dto.username ?? "").trim().toLowerCase();
    if (!username) {
      return ciSuccess({ available: false });
    }
    const inUser = await erpKnexRead("Users.UserTbl").where({ UserName: username, IsDeleted: 0 }).first("UserUID");
    return ciSuccess({ available: !inUser });
  }

  // Signup::checkGSTIN + Signup_model::isGSTINTaken — taken when any org already has the GSTIN
  @Get("checkGSTIN")
  @ApiOperation({ summary: "Is the GSTIN free for a new signup? {available} — checks OrganisationTbl" })
  async checkGSTIN(@Query() dto: SignupGstinQueryDto) {
    const gstin = String(dto.gstin ?? "").trim().toUpperCase();
    if (!GSTIN_PATTERN.test(gstin)) {
      return ciSuccess({ available: false }, "Invalid GSTIN format");
    }
    const inOrg = await erpKnexRead("Organisation.OrganisationTbl").where({ GSTIN: gstin, IsDeleted: 0 }).whereNot("GSTIN", "").first("OrgUID");
    return ciSuccess({ available: !inOrg });
  }
}
