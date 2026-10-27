import { Injectable } from "@nestjs/common";
import { BackgroundTaskService } from "../../core/background/background-task.service";
import { AddressInput } from "../../libraries/party-details/party-details.service";
import { LangCode, TranslationService, TypedText } from "../../libraries/translation/translation.service";
import { CustomersRepository } from "./customers.repository";

const TEXT_FIELDS = ["Name", "ContactPerson", "Notes", "Area", "CompanyName"] as const;
type TextField = (typeof TEXT_FIELDS)[number];

export type TypedCustomerText = Record<TextField, TypedText>;

export interface TypedAddress {
  Line1: string;
  Line2: string;
  CityText: string;
  StateText: string;
  lang: LangCode;
}

/**
 * Customer text in two languages (CI3 Customers::_triggerLangSave / _normalizeAddrPostData):
 * the base tables hold English, Customers.*_Lang hold Tamil. Text typed in Tamil is translated to
 * English before saving; the Tamil rows are written after the response, in the background.
 */
@Injectable()
export class CustomerTranslationService {
  constructor(
    private readonly translation: TranslationService,
    private readonly customers: CustomersRepository,
    private readonly background: BackgroundTaskService
  ) {}

  // Replaces Tamil text fields in the row with English; returns what the user typed, with its language.
  async normalizeCustomerRow(row: Record<string, unknown>): Promise<TypedCustomerText> {
    const typed = {} as TypedCustomerText;
    for (const field of TEXT_FIELDS) {
      const value = row[field];
      // CI3 keeps Name as posted and trims the other fields
      const text = value === null || value === undefined ? "" : field === "Name" ? String(value) : String(value).trim();
      const result = await this.translation.normalize(text);
      if (result.typed.lang === "ta") row[field] = result.english;
      typed[field] = result.typed;
    }
    return typed;
  }

  // An address typed in Tamil (detected from Line1) is stored in English; returns the typed text.
  async normalizeAddress(address: AddressInput): Promise<TypedAddress> {
    const typed: TypedAddress = {
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

  // Writes the Tamil rows after the response has been sent.
  scheduleTamilRows(
    customerUID: number,
    text: TypedCustomerText,
    addresses: { Billing?: TypedAddress; Shipping?: TypedAddress },
    userUID: number
  ): void {
    this.background.run(`Tamil text for customer ${customerUID}`, async () => {
      const tamil = (field: TextField) => this.translation.toTamil(text[field].text, text[field].lang);
      await this.customers.saveLangRow(
        customerUID,
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

      await this.saveAddressRows(customerUID, addresses, userUID);
    });
  }

  // Tamil rows for addresses only (e.g. after a billing-address edit), written after the response.
  scheduleAddressRows(customerUID: number, addresses: { Billing?: TypedAddress; Shipping?: TypedAddress }, userUID: number): void {
    this.background.run(`Tamil address for customer ${customerUID}`, () => this.saveAddressRows(customerUID, addresses, userUID));
  }

  private async saveAddressRows(customerUID: number, addresses: { Billing?: TypedAddress; Shipping?: TypedAddress }, userUID: number) {
    const saved = await this.customers.findAddresses(customerUID, "en");
    for (const address of saved) {
      const typed = address.AddressType === "Billing" ? addresses.Billing : addresses.Shipping;
      if (!typed) continue;
      const tamilOf = (value: string) => this.translation.toTamil(value, typed.lang);
      await this.customers.saveAddressLangRow(
        Number(address.CustAddressUID),
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
