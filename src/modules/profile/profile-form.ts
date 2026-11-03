import { CiFormValidator } from "../../core/validation/ci-form-validator";

// Uploads on the profile page are limited to 5 MB
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

export const WORK_STATUSES = ["Active", "Resigned", "Terminated", "OnLeave"];
export const EMPLOYMENT_TYPES = ["Permanent", "Contract", "Part-time", "Intern", "Consultant"];
export const REIMBURSEMENT_TYPES = ["Travel", "Medical", "Food & Entertainment", "Accommodation", "Communication", "Office Supplies", "Others"];

/**
 * Formvalidation_model::profValidateForm as it actually runs in CI3: the per-field rules are never applied
 * (its loop reads values instead of field names), so only the password fields are checked, and only when one
 * of them is filled. The other checks are in ProfileService.
 */
export const passwordFormValidator = new CiFormValidator({
  oldPassword: { label: "Old Password", required: true, minLength: 6, maxLength: 20 },
  newPassword: { label: "New Password", required: true },
  confirmPassword: {
    label: "Confirm Password",
    required: true,
    callbacks: [(value, data) => (value === String(data.newPassword ?? "").trim() ? null : "The {field} field does not match the New Password field.")],
  },
});

// Trimmed text, or null when empty, cut to `max` characters (CI3 substr(trim(...), 0, max) ?: null)
export function textOrNull(value: unknown, max?: number): string | null {
  const text = String(value ?? "").trim();
  const cut = max === undefined ? text : text.slice(0, max);
  return cut === "" ? null : cut;
}

// CI3 date('Y-m-d', strtotime($value)): a readable date as YYYY-MM-DD, otherwise null
export function dateOrNull(value: unknown): string | null {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const ymd = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (ymd) return `${ymd[1]}-${ymd[2]}-${ymd[3]}`;
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return null;
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
