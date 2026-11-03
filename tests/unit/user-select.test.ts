import { describe, expect, it } from "vitest";
import {
  ADMIN_USER_SELECT,
  PARTICIPANT_USER_SELECT,
} from "@/lib/user-select";

describe("credential-free User response projections", () => {
  it("never selects legacy password or credential-like fields for participants", () => {
    expect(PARTICIPANT_USER_SELECT).not.toHaveProperty("password");
    expect(PARTICIPANT_USER_SELECT).not.toHaveProperty("passwordHash");
    expect(PARTICIPANT_USER_SELECT).not.toHaveProperty("sessions");
    expect(PARTICIPANT_USER_SELECT).not.toHaveProperty("otps");
    expect(PARTICIPANT_USER_SELECT).not.toHaveProperty("phone");
    expect(PARTICIPANT_USER_SELECT).not.toHaveProperty("email");
  });

  it("allows account contact fields for admin operations but never credentials", () => {
    expect(ADMIN_USER_SELECT).toHaveProperty("phone", true);
    expect(ADMIN_USER_SELECT).toHaveProperty("email", true);
    expect(ADMIN_USER_SELECT).toHaveProperty("phoneVerified", true);
    expect(ADMIN_USER_SELECT).not.toHaveProperty("password");
    expect(ADMIN_USER_SELECT).not.toHaveProperty("passwordHash");
    expect(ADMIN_USER_SELECT).not.toHaveProperty("sessions");
    expect(ADMIN_USER_SELECT).not.toHaveProperty("otps");
  });
});
