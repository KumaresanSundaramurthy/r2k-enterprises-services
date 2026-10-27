/**
 * CI3 getPostValue(): a missing key, null or "" gives the default; an array is joined with commas
 * when `commaJoin` is set (Tags, CCEmails), otherwise returned as-is.
 */
export function postValue<T = unknown>(data: object, key: string, defaultValue: T | null = null, commaJoin = false): unknown {
  const record = data as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(record, key)) return defaultValue;
  const value = record[key];
  if (value === "" || value === null || value === undefined) return defaultValue;
  if (Array.isArray(value) && commaJoin) return value.length > 0 ? value.join(",") : defaultValue;
  return value;
}

export const postString = (data: object, key: string, defaultValue: string | null = null): string | null => {
  const value = postValue(data, key, defaultValue);
  return value === null ? null : String(value);
};

// PHP (int)(bool)$value: "0", "", false, null → 0; anything else → 1
export const postFlag = (data: object, key: string): number => {
  const value = postValue(data, key);
  return value === null || value === false || value === "0" || value === 0 ? 0 : 1;
};

// PHP (int)$value on a posted value (leading digits, otherwise 0)
export const postInt = (data: object, key: string, defaultValue = 0): number => {
  const parsed = parseInt(String(postValue(data, key, defaultValue)).replace(/^["']+|["']+$/g, ""), 10);
  return Number.isNaN(parsed) ? 0 : parsed;
};

// Positive integer IDs from an array, a single value or a comma-separated string (CI3 array_filter(array_map('intval', …)))
export function postIntList(data: object, key: string): number[] {
  const value = postValue(data, key);
  if (value === null) return [];
  const items = Array.isArray(value) ? value : String(value).split(",");
  return items.map((item) => parseInt(String(item), 10)).filter((id) => Number.isInteger(id) && id > 0);
}

// A JSON array posted as a string or as an array; anything else → []
export function postJsonArray<T>(data: object, key: string): T[] {
  const value = postValue(data, key);
  if (Array.isArray(value)) return value as T[];
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? (parsed as T[]) : [];
    } catch {
      return [];
    }
  }
  return [];
}
