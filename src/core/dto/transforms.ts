// Reusable class-transformer helpers for request DTOs.

// A single value or an array → array (CI3 filters accept both); empty → undefined.
export const toArray = ({ value }: { value: unknown }) =>
  value === undefined || value === null || value === "" ? undefined : ([] as unknown[]).concat(value);

// Optional numeric filter: CI3 treats "" as "no filter", so empty → undefined, anything else → number.
// (Use instead of @Type(() => Number), which would turn "" into 0.)
export const toOptionalNumber = ({ value }: { value: unknown }) =>
  value === undefined || value === null || value === "" ? undefined : Number(value);
