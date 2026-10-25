import { BadRequestException, ConflictException, Injectable, Logger } from "@nestjs/common";
import { RedisService } from "../../common/redis/redis.service";
import { toInt } from "../../common/utils/php-compat";
import { ErpSessionContext } from "../interfaces/erp-session.interface";
import { OrganisationRepository } from "../repositories/organisation.repository";
import { CompleteOnboardingDto } from "../dto/onboarding.dto";

const DEFAULT_TIMEZONE_UID = 181;
const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;

interface GstinDetails {
  pan: string | null;
  state: string | null;
  line1: string | null;
  city: string | null;
  pincode: string | null;
}

// Onboarding::completeProfile — organisation profile for users who signed up with Google.
@Injectable()
export class OnboardingService {
  private readonly logger = new Logger(OnboardingService.name);

  constructor(
    private readonly organisationRepository: OrganisationRepository,
    private readonly redis: RedisService
  ) {}

  getStates() {
    return this.organisationRepository.getIndianStates();
  }

  getTimezones() {
    return this.organisationRepository.getTimezones();
  }

  async complete(session: ErpSessionContext, dto: CompleteOnboardingDto) {
    const orgUID = toInt(session.data.Org.OrgUID);
    const userUID = toInt(session.data.User.UserUID);
    if (orgUID <= 0) {
      throw new BadRequestException("Organisation not found in session.");
    }

    const orgName = dto.orgName.trim();
    const brandName = dto.brandName.trim();
    const shortCode = dto.shortCode.trim().toUpperCase();
    const mobile = dto.mobile.replace(/\D/g, "");
    const gstin = (dto.gstin ?? "").trim().toUpperCase();
    const timezoneUID = dto.timezoneUID && dto.timezoneUID > 0 ? dto.timezoneUID : DEFAULT_TIMEZONE_UID;
    const [stateCode = "", stateName = ""] = dto.state.split("|", 2);

    if (orgName.length < 3) throw new BadRequestException("Organisation name must be at least 3 characters.");
    if (brandName.length < 3) throw new BadRequestException("Brand name must be at least 3 characters.");
    if (!/^[A-Z0-9]{3}$/.test(shortCode)) {
      throw new BadRequestException("Short code must be exactly 3 alphanumeric characters (e.g. R2K).");
    }
    if (mobile.length !== 10) throw new BadRequestException("Enter a valid 10-digit mobile number.");
    if (!stateCode || !stateName) throw new BadRequestException("Invalid state selected.");
    if (gstin && !GSTIN_PATTERN.test(gstin)) {
      throw new BadRequestException("Invalid GSTIN format (e.g. 22AAAAA0000A1Z5).");
    }

    if (await this.organisationRepository.isMobileTaken(mobile, orgUID)) {
      throw new ConflictException("This mobile number is already registered with another account.");
    }
    if (gstin && (await this.organisationRepository.isGstinTaken(gstin, orgUID))) {
      throw new ConflictException("This GSTIN is already registered with another account.");
    }

    const gstDetails = gstin ? await this.verifyGstin(gstin) : null;

    await this.organisationRepository.update(orgUID, {
      Name: orgName,
      BrandName: brandName,
      ShortCode: shortCode,
      MobileNumber: mobile,
      StateCode: stateCode,
      StateName: stateName,
      TimezoneUID: timezoneUID,
      GSTIN: gstin || null,
      GSTINValidation: gstDetails ? 1 : 0,
      PANNumber: gstDetails?.pan ?? null,
      IsOnboardingComplete: 1,
      UpdatedBy: userUID,
    });

    // Billing address — from the GSTIN record when verified, otherwise from the form
    const address = gstDetails
      ? { Line1: gstDetails.line1, Line2: null, CityText: gstDetails.city, Pincode: gstDetails.pincode, StateText: gstDetails.state }
      : {
          Line1: dto.addressLine1?.trim() || null,
          Line2: dto.addressLine2?.trim() || null,
          CityText: dto.addressCity?.trim() || null,
          Pincode: dto.addressPincode?.trim() || null,
          StateText: stateName || null,
        };
    if (address.Line1) {
      await this.organisationRepository
        .insertBillingAddress({ OrgUID: orgUID, ...address, CreatedBy: userUID, UpdatedBy: userUID })
        .catch((err) => this.logger.error(`Billing address for org ${orgUID} failed: ${(err as Error).message}`));
    }

    if (gstDetails) {
      await this.organisationRepository.updateHeadOfficeBranch(orgUID, { GSTIN: gstin, StateText: stateName, UpdatedBy: userUID });
    }

    // Update the live session so the onboarding gate no longer applies
    const ttl = await this.redis.ttl(session.key);
    session.data.Org.IsOnboardingComplete = 1;
    session.data.Org.OrgName = orgName;
    session.data.Org.OrgMobile = mobile;
    session.data.Org.StateCode = stateCode;
    session.data.Org.StateName = stateName;
    await this.redis.set(session.key, session.data, ttl > 0 ? ttl : Number(process.env.LOGIN_EXPIRE_SECS) || 86400);

    return { message: "Profile completed successfully." };
  }

  private async verifyGstin(gstin: string): Promise<GstinDetails> {
    let body: Record<string, unknown> = {};
    try {
      const res = await fetch(`https://gstverify.co.in/api/v1/verify/${encodeURIComponent(gstin)}`, {
        headers: { Accept: "application/json", "X-API-Key": process.env.GSTIN_API_KEY || "" },
        signal: AbortSignal.timeout(15000),
      });
      body = (await res.json()) as Record<string, unknown>;
    } catch {
      throw new BadRequestException("GSTIN verification failed. Please try again or leave the field empty to skip.");
    }
    if (body.success !== true) {
      const apiMessage = [body.message, body.error, body.msg].find((value) => typeof value === "string" && value);
      throw new BadRequestException((apiMessage as string) || "GSTIN not found or invalid. Please verify the number.");
    }

    const data = (body.data ?? {}) as Record<string, string | undefined>;
    // Address comes as "line1, city — pincode"
    const rawAddress = (data.address ?? "").trim();
    let line1: string | null = rawAddress || null;
    let city: string | null = null;
    let pincode: string | null = null;
    const dashPos = rawAddress.indexOf("—");
    if (dashPos !== -1) {
      const left = rawAddress.slice(0, dashPos).trim();
      pincode = rawAddress.slice(dashPos + 1).replace(/\D/g, "") || null;
      const commaPos = left.lastIndexOf(",");
      if (commaPos !== -1) {
        city = left.slice(commaPos + 1).trim() || null;
        line1 = left.slice(0, commaPos).trim() || null;
      } else {
        line1 = left || null;
      }
    }
    return { pan: data.pan ?? null, state: data.state ?? null, line1, city, pincode };
  }
}
