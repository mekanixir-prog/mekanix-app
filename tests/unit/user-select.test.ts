import { describe, expect, it } from "vitest";
import {
  ADMIN_USER_SELECT,
  AUTH_USER_SELECT,
  PARTICIPANT_USER_SELECT,
} from "@/lib/user-select";

function expectCredentialFree(select: Record<string, unknown>) {
  expect(select).not.toHaveProperty("password");
  expect(select).not.toHaveProperty("passwordHash");
  expect(select).not.toHaveProperty("sessions");
  expect(select).not.toHaveProperty("otps");
  expect(select).not.toHaveProperty("otpCodes");
}

describe("credential-free User response projections", () => {
  it("never selects legacy password or credential-like fields for participants", () => {
    expectCredentialFree(PARTICIPANT_USER_SELECT);
    expect(PARTICIPANT_USER_SELECT).not.toHaveProperty("phone");
    expect(PARTICIPANT_USER_SELECT).not.toHaveProperty("email");
  });

  it("allows required contact fields for authentication responses but never credentials", () => {
    expect(AUTH_USER_SELECT).toHaveProperty("id", true);
    expect(AUTH_USER_SELECT).toHaveProperty("name", true);
    expect(AUTH_USER_SELECT).toHaveProperty("phone", true);
    expect(AUTH_USER_SELECT).toHaveProperty("phoneVerified", true);
    expect(AUTH_USER_SELECT).toHaveProperty("email", true);
    expectCredentialFree(AUTH_USER_SELECT);
  });

  it("allows account contact fields for admin operations but never credentials", () => {
    expect(ADMIN_USER_SELECT).toHaveProperty("phone", true);
    expect(ADMIN_USER_SELECT).toHaveProperty("email", true);
    expect(ADMIN_USER_SELECT).toHaveProperty("phoneVerified", true);
    expectCredentialFree(ADMIN_USER_SELECT);
  });
});
