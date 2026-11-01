import { UseInterceptors } from "@nestjs/common";
import { FileFieldsInterceptor, NoFilesInterceptor } from "@nestjs/platform-express";

export type FileFields = Record<string, Express.Multer.File[]> | undefined;

// Images posted as <name>[] (the CI3 FormData name) or <name>
export const AcceptFiles = (name: string) =>
  UseInterceptors(
    FileFieldsInterceptor([
      { name: `${name}[]`, maxCount: 10 },
      { name, maxCount: 10 },
    ])
  );

export const filesOf = (files: FileFields, name: string) => [...(files?.[`${name}[]`] ?? []), ...(files?.[name] ?? [])];

// Form posts without files: the CI3 JS sends some of them as FormData (multipart), which Nest only reads through multer
export const AcceptForm = () => UseInterceptors(NoFilesInterceptor());
