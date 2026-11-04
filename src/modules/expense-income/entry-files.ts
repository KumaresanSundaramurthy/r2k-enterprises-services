import { UseInterceptors } from "@nestjs/common";
import { FileFieldsInterceptor } from "@nestjs/platform-express";
import { FileFields, filesOf } from "../products/product-files";

// Record attachments: AttachFiles[] (shared attachment zone) or Attachments[] (expense modal); payments: PaymentFiles[]
export const AcceptEntryFiles = () =>
  UseInterceptors(
    FileFieldsInterceptor([
      { name: "AttachFiles[]", maxCount: 20 },
      { name: "AttachFiles", maxCount: 20 },
      { name: "Attachments[]", maxCount: 20 },
      { name: "Attachments", maxCount: 20 },
    ])
  );

// CI3 reads $_FILES['AttachFiles'] and falls back to $_FILES['Attachments']
export function recordFiles(files: FileFields) {
  const attachFiles = filesOf(files, "AttachFiles");
  return attachFiles.length > 0 ? attachFiles : filesOf(files, "Attachments");
}
