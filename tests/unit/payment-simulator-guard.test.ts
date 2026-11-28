import { describe, expect, it } from "vitest";
import { isPaymentSimulatorRouteEnabled } from "@/lib/payment-simulator-guard";

describe("payment simulator route environment guard", () => {
  it("allows only explicit local development with the simulator selected", () => {
    expect(isPaymentSimulatorRouteEnabled({
      NODE_ENV: "development",
      PAYMENT_PROVIDER: "simulator",
    })).toBe(true);
  });

  it("allows test execution without enabling simulator routes in deployed environments", () => {
    expect(isPaymentSimulatorRouteEnabled({
      NODE_ENV: "test",
      PAYMENT_PROVIDER: "simulator",
    })).toBe(true);
  });

  it("rejects production even when simulator is configured", () => {
    expect(isPaymentSimulatorRouteEnabled({
      NODE_ENV: "production",
      PAYMENT_PROVIDER: "simulator",
    })).toBe(false);
  });

  it("fails closed when NODE_ENV is missing or unknown", () => {
    expect(isPaymentSimulatorRouteEnabled({
      PAYMENT_PROVIDER: "simulator",
    })).toBe(false);
    expect(isPaymentSimulatorRouteEnabled({
      NODE_ENV: "preview",
      PAYMENT_PROVIDER: "simulator",
    })).toBe(false);
  });

  it("does not expose simulator routes when a real provider is selected", () => {
    expect(isPaymentSimulatorRouteEnabled({
      NODE_ENV: "development",
      PAYMENT_PROVIDER: "zarinpal",
    })).toBe(false);
    expect(isPaymentSimulatorRouteEnabled({
      NODE_ENV: "development",
      PAYMENT_PROVIDER: "idpay",
    })).toBe(false);
  });

  it("requires an explicit simulator selection in development", () => {
    expect(isPaymentSimulatorRouteEnabled({
      NODE_ENV: "development",
    })).toBe(false);
    expect(isPaymentSimulatorRouteEnabled({
      NODE_ENV: "development",
      PAYMENT_PROVIDER: "",
    })).toBe(false);
  });
});
