-- Default seed records for a newly created organisation.
-- Replace every :orgId occurrence with the actual OrgUID before executing.

-- ── TransactionSettingsTbl ────────────────────────────────────────────────────
INSERT INTO `TransactionSettingsTbl`
  (`OrgUID`,`PurchaseShowTerms`,`AutoUpdatePurchasePrice`,
   `InvoiceCancelAction`,`SalesReturnCancelAction`,`SalesReturnItemMethod`,
   `TermsAndConditions`,`HideNavOnTransForm`,`PurchaseShowSignature`,`UpdatedBy`,
   `PurchaseReturnCancelAction`,`PurchaseReturnItemMethod`,`ShowProductDescription`,
   `DCDefaultReturnDays`,`QuotValidityDays`,`MaxAdditionalCharges`,
   `ShowTransactionStats`,`ComboPriceDistribution`,`BelowPurchasePriceAction`,
   `DefaultTransactionType`,`AutoDraftSave`,`PurchaseCancelAction`)
VALUES
  (:orgId,0,'ask','ask','ask','Both',NULL,b'0',b'0',NULL,
   'ask','Manual',1,7,7,5,1,'ratio','warn','regular',1,'ask');

-- ── OrgProductSettingsTbl ─────────────────────────────────────────────────────
INSERT INTO `OrgProductSettingsTbl`
  (`OrgUID`,`DefaultProductTypeUID`,`DefaultDiscountTypeUID`,
   `DefaultProductTaxUID`,`DefaultTaxDetailUID`,`UpdatedBy`)
VALUES
  (:orgId,1,1,1,2,NULL);

-- ── PrintThemeConfigTbl ───────────────────────────────────────────────────────
INSERT INTO `PrintThemeConfigTbl`
  (`OrgUID`,`ModuleUID`,`TransactionType`,`ThemeKey`,`TemplateUID`,`PrimaryColor`,`AccentColor`,
   `ShowLogo`,`ShowOrgAddress`,`ShowGSTIN`,`ShowHSN`,`ShowTaxBreakdown`,`ShowPartyBalance`,`ShowTime`,
   `FontFamily`,`FontSizePx`,`IsActive`,`IsDeleted`,`CreatedBy`,`UpdatedBy`)
VALUES
  (:orgId,101,'Quotation',      'swipe_formal',   7,'#0041a3','#3278e2',b'1',b'1',b'1',b'1',b'1',b'1',b'1','Montserrat',12,b'1',b'0',NULL,NULL),
  (:orgId,102,'SalesOrder',     'swipe_clean',    7,'#1a3c6e','#f59e0b',b'1',b'1',b'1',b'1',b'1',b'1',b'0','Montserrat',12,b'1',b'0',NULL,NULL),
  (:orgId,103,'Invoice',        'swipe_formal',   7,'#1a3c6e','#f59e0b',b'1',b'1',b'1',b'1',b'1',b'1',b'0','Montserrat',12,b'1',b'0',NULL,NULL),
  (:orgId,104,'Purchase Orders','swipe_formal',   7,'#1a3c6e','#4371b6',b'1',b'1',b'1',b'1',b'1',b'1',b'0','Montserrat',12,b'1',b'0',NULL,NULL),
  (:orgId,105,'Purchases',      'swipe_formal',   7,'#0041a3','#3278e2',b'1',b'1',b'1',b'1',b'1',b'1',b'0','Montserrat',12,b'1',b'0',NULL,NULL),
  (:orgId,106,'Sales Returns',  'swipe_formal',   7,'#1a3c6e','#f59e0b',b'1',b'1',b'1',b'1',b'1',b'1',b'0','Montserrat',12,b'1',b'0',NULL,NULL),
  (:orgId,107,'CreditNote',     'swipe_formal',   7,'#1a3c6e','#f59e0b',b'1',b'1',b'1',b'1',b'1',b'1',b'0','Montserrat',12,b'1',b'0',NULL,NULL),
  (:orgId,108,'Purchase Returns','swipe_formal',  7,'#1a3c6e','#4371b6',b'1',b'1',b'1',b'1',b'1',b'1',b'0','Montserrat',12,b'1',b'0',NULL,NULL),
  (:orgId,109,'DebitNote',      'swipe_formal',   7,'#1a3c6e','#4371b6',b'1',b'1',b'1',b'1',b'1',b'1',b'0','Montserrat',12,b'1',b'0',NULL,NULL),
  (:orgId,110,'Payment',        'payment_receipt',8,'#1a3c6e','#f59e0b',b'1',b'1',b'1',b'1',b'1',b'1',b'0','Montserrat',12,b'1',b'0',NULL,NULL),
  (:orgId,111,'PayOut',         'swipe_formal',   7,'#1a3c6e','#f59e0b',b'1',b'1',b'1',b'1',b'1',b'1',b'0','Montserrat',12,b'1',b'0',NULL,NULL),
  (:orgId,112,'Delivery Challans','swipe_formal', 7,'#1a3c6e','#4371b6',b'1',b'1',b'1',b'1',b'1',b'1',b'0','Montserrat',11,b'1',b'0',NULL,NULL),
  (:orgId,113,'Proforma Invoices','swipe_formal', 7,'#1a3c6e','#4371b6',b'1',b'1',b'1',b'1',b'1',b'1',b'0','Montserrat',11,b'1',b'0',NULL,NULL),
  (:orgId,114,'Expenses',       'classic',        1,'#1a3c6e','#f59e0b',b'0',b'0',b'0',b'0',b'0',b'0',b'0','Arial',     20,b'1',b'0',NULL,NULL),
  (:orgId,115,'IndirectIncome', 'classic',        1,'#1a3c6e','#f59e0b',b'0',b'0',b'0',b'0',b'0',b'0',b'0','Arial',     20,b'1',b'0',NULL,NULL);

-- ── TransactionPrefixTbl ──────────────────────────────────────────────────────
INSERT INTO `TransactionPrefixTbl`
  (`OrgUID`,`ModuleUID`,`Name`,`IncludeFiscalYear`,`FiscalYearFormat`,`IncludeShortName`,
   `ShortName`,`Separator`,`NumberPadding`,`IsDefault`,`IsDeleted`,`IsActive`,`ComponentConfig`)
VALUES
  (:orgId,101,'EST', 1,'SHORT',0,'','/',3,b'1',b'0',b'1',NULL),
  (:orgId,102,'SO',  1,'SHORT',0,'','/',3,b'1',b'0',b'1',NULL),
  (:orgId,103,'INV', 1,'SHORT',0,'','/',3,b'1',b'0',b'1',NULL),
  (:orgId,104,'PO',  1,'SHORT',0,'','/',3,b'1',b'0',b'1',NULL),
  (:orgId,105,'PUR', 1,'SHORT',0,'','/',3,b'1',b'0',b'1',NULL),
  (:orgId,106,'SRT', 1,'SHORT',0,'','/',3,b'1',b'0',b'1',NULL),
  (:orgId,107,'CRN', 1,'SHORT',0,'','/',3,b'1',b'0',b'1',NULL),
  (:orgId,108,'PRT', 1,'SHORT',0,'','/',3,b'1',b'0',b'1',NULL),
  (:orgId,109,'DBN', 1,'SHORT',0,'','/',3,b'1',b'0',b'1',NULL),
  (:orgId,110,'PIN', 1,'SHORT',0,'','/',3,b'1',b'0',b'1',NULL),
  (:orgId,111,'POUT',1,'SHORT',0,'','/',3,b'1',b'0',b'1',NULL),
  (:orgId,112,'DCH', 1,'SHORT',0,'','/',3,b'1',b'0',b'1',NULL),
  (:orgId,113,'PFI', 1,'SHORT',0,'','/',3,b'1',b'0',b'1',NULL),
  (:orgId,114,'EXP', 1,'SHORT',0,'','/',3,b'1',b'0',b'1',NULL),
  (:orgId,115,'IDC', 1,'SHORT',0,'','/',3,b'1',b'0',b'1',NULL);
