/**
 * CI3 form_validation, reproduced for API input: same rules, same default messages, and the same
 * behaviour of only validating fields that are present in the submitted data. Values are trimmed
 * before checking (CI3 'trim'); rules other than `required` are skipped for empty values.
 */

// Returns an error message, or null when the value is valid.
export type FieldCallback = (value: string, data: Record<string, unknown>) => string | null;

export interface FieldRule {
  label: string;
  required?: boolean;
  minLength?: number;
  maxLength?: number;
  numeric?: boolean;
  inList?: string[];
  regex?: RegExp;
  greaterThanOrEqual?: number;
  lessThanOrEqual?: number;
  callbacks?: FieldCallback[];
}

export type FieldRules = Record<string, FieldRule>;

// CI3 'numeric' rule
const NUMERIC = /^[-+]?[0-9]*\.?[0-9]+$/;

export class CiFormValidator {
  constructor(private readonly rules: FieldRules) {}

  /** Field → message map (CI3 error_array()); empty when the data is valid. */
  validate(data: Record<string, unknown>): Record<string, string> {
    const errors: Record<string, string> = {};
    for (const [field, rule] of Object.entries(this.rules)) {
      if (!Object.prototype.hasOwnProperty.call(data, field)) continue;
      const message = this.check(String(data[field] ?? "").trim(), rule, data);
      if (message) errors[field] = message;
    }
    return errors;
  }

  private check(value: string, rule: FieldRule, data: Record<string, unknown>): string | null {
    const field = rule.label;
    if (value === "") {
      return rule.required ? `The ${field} field is required.` : null;
    }
    if (rule.minLength !== undefined && [...value].length < rule.minLength) {
      return `The ${field} field must be at least ${rule.minLength} characters in length.`;
    }
    if (rule.maxLength !== undefined && [...value].length > rule.maxLength) {
      return `The ${field} field cannot exceed ${rule.maxLength} characters in length.`;
    }
    if (rule.numeric && !NUMERIC.test(value)) {
      return `The ${field} field must contain only numbers.`;
    }
    if (rule.inList && !rule.inList.includes(value)) {
      return `The ${field} field must be one of: ${rule.inList.join(",")}.`;
    }
    if (rule.regex && !rule.regex.test(value)) {
      return `The ${field} field is not in the correct format.`;
    }
    if (rule.greaterThanOrEqual !== undefined && !(Number(value) >= rule.greaterThanOrEqual)) {
      return `The ${field} field must contain a number greater than or equal to ${rule.greaterThanOrEqual}.`;
    }
    if (rule.lessThanOrEqual !== undefined && !(Number(value) <= rule.lessThanOrEqual)) {
      return `The ${field} field must contain a number less than or equal to ${rule.lessThanOrEqual}.`;
    }
    for (const callback of rule.callbacks ?? []) {
      const message = callback(value, data);
      if (message) return message.replace("{field}", field);
    }
    return null;
  }
}
