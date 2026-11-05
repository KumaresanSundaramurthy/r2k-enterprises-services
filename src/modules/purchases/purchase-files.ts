import { UseInterceptors } from "@nestjs/common";
import { FileFieldsInterceptor } from "@nestjs/platform-express";
import { FileFields, filesOf } from "../products/product-files";

// Document files (AttachFiles[] / Attachments[]) and payment files (PaymentFiles[], CI3 $_FILES['PaymentFiles'])
export const AcceptDocumentFiles = () =>
  UseInterceptors(
    FileFieldsInterceptor([
      { name: "AttachFiles[]", maxCount: 20 },
      { name: "AttachFiles", maxCount: 20 },
      { name: "Attachments[]", maxCount: 20 },
      { name: "Attachments", maxCount: 20 },
      { name: "PaymentFiles[]", maxCount: 3 },
      { name: "PaymentFiles", maxCount: 3 },
    ])
  );

export const paymentFiles = (files: FileFields) => filesOf(files, "PaymentFiles");
