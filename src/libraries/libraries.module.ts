import { Global, Module } from "@nestjs/common";
import { AccountLedgerRepository } from "./account-ledger/account-ledger.repository";
import { AccountLedgerService } from "./account-ledger/account-ledger.service";
import { AuditLogService } from "./audit-log/audit-log.service";
import { CacheHelperService } from "./cache-helper/cache-helper.service";
import { CommunicationRepository } from "./communication/communication.repository";
import { CommunicationService } from "./communication/communication.service";
import { SmsService } from "./communication/sms.service";
import { CreditSettingsService } from "./credit-settings/credit-settings.service";
import { CurlService } from "./curl/curl.service";
import { CustomerBalanceRepository } from "./customer-balance/customer-balance.repository";
import { CustomerBalanceService } from "./customer-balance/customer-balance.service";
import { ExportService } from "./export/export.service";
import { FileUploadService } from "./file-upload/file-upload.service";
import { LocationService } from "./location/location.service";
import { PartyDetailsService } from "./party-details/party-details.service";
import { TransactionPaymentService } from "./transaction-payment/transaction-payment.service";
import { TranslationService } from "./translation/translation.service";
import { VendorBalanceRepository } from "./vendor-balance/vendor-balance.repository";
import { VendorBalanceService } from "./vendor-balance/vendor-balance.service";

const services = [
  CurlService,
  TranslationService,
  CacheHelperService,
  CreditSettingsService,
  CustomerBalanceService,
  VendorBalanceService,
  AccountLedgerService,
  AuditLogService,
  PartyDetailsService,
  TransactionPaymentService,
  ExportService,
  FileUploadService,
  LocationService,
  SmsService,
  CommunicationService,
];

// Reusable services (CI3's application/libraries). Each one is injected wherever it is needed.
@Global()
@Module({
  providers: [...services, CustomerBalanceRepository, VendorBalanceRepository, AccountLedgerRepository, CommunicationRepository],
  exports: services,
})
export class LibrariesModule {}
