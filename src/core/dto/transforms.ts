import { ClassConstructor, plainToInstance } from "class-transformer";

// Reusable class-transformer helpers for request DTOs.

// Nested object sent as a JSON string in the query (or already an object) → instance of cls;
// invalid JSON is left as is so @ValidateNested() rejects it.
export const toJsonObject =
  <T extends object>(cls: ClassConstructor<T>) =>
  ({ value }: { value: unknown }) => {
    if (value === undefined || value === null || value === "") return undefined;
    let raw = value;
    if (typeof value === "string") {
      try {
        raw = JSON.parse(value);
      } catch {
        return value;
      }
    }
    return raw && typeof raw === "object" ? plainToInstance(cls, raw) : value;
  };

// A single value or an array → array (CI3 filters accept both); empty → undefined.
export const toArray = ({ value }: { value: unknown }) =>
  value === undefined || value === null || value === "" ? undefined : ([] as unknown[]).concat(value);

// Optional numeric filter: CI3 treats "" as "no filter", so empty → undefined, anything else → number.
// (Use instead of @Type(() => Number), which would turn "" into 0.)
export const toOptionalNumber = ({ value }: { value: unknown }) =>
  value === undefined || value === null || value === "" ? undefined : Number(value);
