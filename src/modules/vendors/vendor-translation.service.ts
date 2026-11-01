import { Injectable } from "@nestjs/common";
import { BackgroundTaskService } from "../../core/background/background-task.service";
import { AddressInput } from "../../libraries/party-details/party-details.service";
import { LangCode, TranslationService, TypedText } from "../../libraries/translation/translation.service";
import { VendorsRepository } from "./vendors.repository";

const TEXT_FIELDS = ["Name", "ContactPerson", "Notes", "Area", "CompanyName"] as const;
type TextField = (typeof TEXT_FIELDS)[number];

export type TypedVendorText = Record<TextField, TypedText>;

export interface TypedVendorAddress {
  Line1: string;
  Line2: string;
  CityText: string;
  StateText: string;
  lang: LangCode;
}

export type TypedVendorAddresses = { Billing?: TypedVendorAddress; Shipping?: TypedVendorAddress };

/**
 * Vendor text in two languages (CI3 Vendors::_triggerVendLangSave / _normalizeVendAddrPostData /
 * _triggerVendAddrLangSave): base tables hold English, Vendors.*_Lang hold Tamil. Text typed in Tamil is
 * translated to English before saving; the Tamil rows are written after the response, in the background.
 */
@Injectable()
export class VendorTranslationService {
  constructor(
    private readonly translation: TranslationService,
    private readonly vendors: VendorsRepository,
    private readonly background: BackgroundTaskService
  ) {}

  // Replaces Tamil text fields in the row with English; returns what the user typed, with its language.
  async normalizeVendorRow(row: Record<string, unknown>): Promise<TypedVendorText> {
    const typed = {} as TypedVendorText;
    for (const field of TEXT_FIELDS) {
      const value = row[field];
      const text = value === null || value === undefined ? "" : String(value).trim();
      const result = await this.translation.normalize(text);
      if (result.typed.lang === "ta") row[field] = result.english;
      typed[field] = result.typed;
    }
    return typed;
  }

  // An address typed in Tamil (detected from Line1) is stored in English; returns the typed text.
  async normalizeAddress(address: AddressInput): Promise<TypedVendorAddress> {
    const typed: TypedVendorAddress = {
      Line1: (address.line1 ?? "").trim(),
      Line2: (address.line2 ?? "").trim(),
      CityText: (address.cityText ?? "").trim(),
      StateText: (address.stateText ?? "").trim(),
      lang: "en",
    };
    typed.lang = typed.Line1 !== "" ? this.translation.detectLang(typed.Line1) : "en";
    if (typed.lang === "ta") {
      if (typed.Line1) address.line1 = await this.translation.translate(typed.Line1, "ta", "en");
      if (typed.Line2) address.line2 = await this.translation.translate(typed.Line2, "ta", "en");
      if (typed.CityText) address.cityText = await this.translation.translate(typed.CityText, "ta", "en");
      if (typed.StateText) address.stateText = await this.translation.translate(typed.StateText, "ta", "en");
    }
    return typed;
  }

  // Writes the Tamil vendor and address rows after the response has been sent.
  scheduleTamilRows(vendorUID: number, text: TypedVendorText, addresses: TypedVendorAddresses, userUID: number): void {
    this.background.run(`Tamil text for vendor ${vendorUID}`, async () => {
      const tamil = (field: TextField) => this.translation.toTamil(text[field].text, text[field].lang);
      await this.vendors.saveLangRow(
        vendorUID,
        "ta",
        {
          Name: (await tamil("Name")) ?? "",
          ContactPerson: await tamil("ContactPerson"),
          Notes: await tamil("Notes"),
          Area: await tamil("Area"),
          CompanyName: await tamil("CompanyName"),
        },
        userUID
      );
      await this.saveAddressRows(vendorUID, addresses, userUID);
    });
  }

  // Tamil rows for addresses only (after a billing-address edit), written after the response.
  scheduleAddressRows(vendorUID: number, addresses: TypedVendorAddresses, userUID: number): void {
    this.background.run(`Tamil address for vendor ${vendorUID}`, () => this.saveAddressRows(vendorUID, addresses, userUID));
  }

  private async saveAddressRows(vendorUID: number, addresses: TypedVendorAddresses, userUID: number) {
    const saved = await this.vendors.findAddresses(vendorUID, "en");
    for (const address of saved) {
      const typed = address.AddressType === "Billing" ? addresses.Billing : addresses.Shipping;
      if (!typed) continue;
      const tamilOf = (value: string) => this.translation.toTamil(value, typed.lang);
      await this.vendors.saveAddressLangRow(
        Number(address.VendAddressUID),
        "ta",
        {
          Line1: await tamilOf(typed.Line1),
          Line2: await tamilOf(typed.Line2),
          CityText: await tamilOf(typed.CityText),
          StateText: await tamilOf(typed.StateText),
        },
        userUID
      );
    }
  }
}
