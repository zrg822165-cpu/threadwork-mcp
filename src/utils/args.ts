import { NotFoundError } from "../errors.js";

export function stringArg(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function requiredString(value: unknown, name: string): string {
  const parsed = stringArg(value);
  if (!parsed) {
    throw new NotFoundError(`Missing required argument: ${name}`);
  }
  return parsed;
}

export function stringArrayArg(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : undefined;
}

export function booleanArg(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export function numberArg(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}
