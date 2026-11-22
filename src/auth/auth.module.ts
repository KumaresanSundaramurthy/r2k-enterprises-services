import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { AuthController } from "./controllers/auth.controller";
import { CiSubscriptionController } from "./controllers/ci-subscription.controller";
import { CiLaunchController } from "./controllers/ci-launch.controller";
import { CiSignupController } from "./controllers/ci-signup.controller";
import { CiBillingController } from "./controllers/ci-billing.controller";
import { RazorpayController } from "./controllers/razorpay.controller";
import { CiCheckoutController } from "./controllers/ci-checkout.controller";
import { SubscribeController } from "./controllers/subscribe.controller";
import { SubscriptionController } from "./controllers/subscription.controller";
import { RenewalController } from "./controllers/renewal.controller";
import { RenewalTokenGuard } from "./guards/renewal-token.guard";
import { SignupService } from "./services/signup.service";
import { SubscriptionBillingService } from "./services/subscription-billing.service";
import { BillingPlanService } from "./services/billing-plan.service";
import { RazorpaySubscriptionService } from "./services/razorpay-subscription.service";
import { RazorpayInvoiceService } from "./services/razorpay-invoice.service";
import { SubscriptionCheckoutService } from "./services/subscription-checkout.service";
import { BillingModule } from "../modules/billing/billing.module";
import { CiDevToolsController } from "./controllers/ci-dev-tools.controller";
import { CiUserLookupController } from "./controllers/ci-user-lookup.controller";
import { EmailVerificationController } from "./controllers/email-verification.controller";
import { OAuthController } from "./controllers/oauth.controller";
import { OnboardingController } from "./controllers/onboarding.controller";
import { PasswordController } from "./controllers/password.controller";
import { ErpSessionGuard } from "./guards/erp-session.guard";
import { ErpUserRepository } from "./repositories/erp-user.repository";
import { OrganisationRepository } from "./repositories/organisation.repository";
import { SecurityRepository } from "./repositories/security.repository";
import { SessionDataRepository } from "./repositories/session-data.repository";
import { SubscriptionRepository } from "./repositories/subscription.repository";
import { AuthTokenService } from "./services/auth-token.service";
import { EmailVerificationService } from "./services/email-verification.service";
import { LoginService } from "./services/login.service";
import { OAuthService } from "./services/oauth.service";
import { OnboardingService } from "./services/onboarding.service";
import { PasswordService } from "./services/password.service";
import { SessionService } from "./services/session.service";
import { SubscriptionCheckService } from "./services/subscription-check.service";

// ERP (CI3) user authentication. Sessions are shared with the CI3 app through Redis and the JWT_KEY-signed cookie.
@Module({
  imports: [JwtModule.register({ secret: process.env.JWT_KEY, signOptions: { algorithm: "HS256" } }), BillingModule],
  controllers: [AuthController, PasswordController, EmailVerificationController, OAuthController, OnboardingController, CiUserLookupController, CiSubscriptionController, CiLaunchController, CiSignupController, CiBillingController, CiCheckoutController, SubscribeController, SubscriptionController, RenewalController, RazorpayController, CiDevToolsController],
  providers: [
    SignupService,
    SubscriptionBillingService,
    BillingPlanService,
    RenewalTokenGuard,
    RazorpaySubscriptionService,
    RazorpayInvoiceService,
    SubscriptionCheckoutService,
    AuthTokenService,
    SessionService,
    LoginService,
    PasswordService,
    EmailVerificationService,
    OAuthService,
    OnboardingService,
    SubscriptionCheckService,
    ErpUserRepository,
    SecurityRepository,
    SessionDataRepository,
    OrganisationRepository,
    SubscriptionRepository,
    ErpSessionGuard,
  ],
  exports: [ErpSessionGuard, AuthTokenService, ErpUserRepository, SessionService, SessionDataRepository],
})
export class AuthModule {}
