import { Injectable } from "@nestjs/common";
import { BaseRepository } from "../../core/base/base.repository";
import { DatabaseService } from "../../core/database/database.service";

export type RecipientType = "Customer" | "Vendor";

// One recipient's contact details (CI3 getCustomers / getVendors rows, only the fields used here)
export interface CommContact {
  UID: number;
  Name: string | null;
  CountryCode: string | null;
  MobileNumber: string | null;
  EmailAddress: string | null;
}

const PARTY_TABLES: Record<RecipientType, { table: string; uid: string }> = {
  Customer: { table: "Customers.CustomerTbl", uid: "CustomerUID" },
  Vendor: { table: "Vendors.VendorTbl", uid: "VendorUID" },
};

@Injectable()
export class CommunicationRepository extends BaseRepository {
  constructor(db: DatabaseService) {
    super(db);
  }

  // Active, not deleted recipients of the organisation among the given UIDs
  async findContacts(recipientType: RecipientType, orgUID: number, uids: number[]): Promise<CommContact[]> {
    const { table, uid } = PARTY_TABLES[recipientType];
    const rows: Record<string, string | null>[] = await this.read(`${table} as Party`)
      .select(`Party.${uid} as UID`, "Party.Name as Name", "Party.CountryCode as CountryCode", "Party.MobileNumber as MobileNumber", "Party.EmailAddress as EmailAddress")
      .where({ "Party.OrgUID": orgUID, "Party.IsDeleted": 0, "Party.IsActive": 1 })
      .whereIn(`Party.${uid}`, uids);
    return rows.map((row) => ({
      UID: Number(row.UID),
      Name: row.Name,
      CountryCode: row.CountryCode,
      MobileNumber: row.MobileNumber,
      EmailAddress: row.EmailAddress,
    }));
  }

  // Security.CommunicationLogTbl — one row per recipient attempted
  async insertLogs(logs: Record<string, unknown>[]): Promise<void> {
    if (logs.length === 0) return;
    await this.writer()("Security.CommunicationLogTbl").insert(logs);
  }
}
