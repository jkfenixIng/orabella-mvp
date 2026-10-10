import { describe, expect, it } from "vitest";
import { toPostgrestTimestamp } from "@/src/shared/db/timestamps";

describe("toPostgrestTimestamp", () => {
  it.each([
    ["microseconds and Bogotá offset", "2026-10-09 14:32:18.123456-05", "2026-10-09T14:32:18.123456-05:00"],
    ["one microsecond", "2026-10-09 19:32:18.000001+00", "2026-10-09T19:32:18.000001+00:00"],
    ["no fraction", "2026-10-09 19:32:18+00", "2026-10-09T19:32:18+00:00"],
    ["an offset with minutes", "2026-10-10 01:02:18.5+05:30", "2026-10-10T01:02:18.5+05:30"],
    ["an offset with seconds", "1890-01-01 00:00:00-04:56:16", "1890-01-01T00:00:00-04:56:16"],
    ["PostgREST ISO is unchanged", "2026-10-09T14:32:18.123456-05:00", "2026-10-09T14:32:18.123456-05:00"],
  ])("%s", (_label, input, expected) => expect(toPostgrestTimestamp(input)).toBe(expected));

  it("keeps null and PostgreSQL infinity", () => {
    expect(toPostgrestTimestamp(null)).toBeNull();
    expect(toPostgrestTimestamp("infinity")).toBe("infinity");
  });

  it("returns a valid instant equal to the input", () => {
    expect(new Date(toPostgrestTimestamp("2026-10-09 14:32:18.123456-05")).toISOString()).toBe("2026-10-09T19:32:18.123Z");
  });

  it("rejects what is not a timestamptz text", () => {
    for (const bad of ["2026-10-09", "yesterday", "2026-10-09 14:32:18", "0044-03-15 12:00:00+00 BC"]) {
      expect(() => toPostgrestTimestamp(bad)).toThrow(/timestamptz/);
    }
  });
});
