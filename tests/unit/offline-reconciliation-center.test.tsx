// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { clearQueue, enqueueAction, getQueuedActions, getQueueSize } from "@/lib/offline-queue";
import { OfflineReconciliationCenter } from "@/components/mek/shared/offline-reconciliation-center";

const sync = vi.fn();

function response(data: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  };
}

beforeEach(() => {
  clearQueue();
  vi.clearAllMocks();
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
  sync.mockResolvedValue({
    synced: 0, failed: 0, conflicts: 0, remaining: getQueueSize(), reconciliationRequired: 0,
  });
});

function renderCenter(queueSize = getQueueSize()) {
  return render(
    <OfflineReconciliationCenter
      open
      isOnline
      queueSize={queueSize}
      onSync={sync}
    />
  );
}

describe("offline reconciliation center", () => {
  it("removes an action only after the read-only server lookup confirms it committed", async () => {
    enqueueAction({ url: "/api/wallets/withdraw", method: "POST", body: { amount: 500 } });
    const action = getQueuedActions()[0];
    // Simulate an ambiguous prior outcome so the action is visible in the center.
    const stored = getQueuedActions();
    stored[0].needsReconciliation = true;
    localStorage.setItem("mekanix-offline-queue", JSON.stringify(stored));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({
      state: "COMMITTED",
      withdrawal: { code: "WD-1001", amount: 500, status: "REQUESTED" },
    })));

    renderCenter(1);
    fireEvent.click(screen.getByRole("button", { name: "بررسی وضعیت سرور" }));

    await screen.findByText("سرور ثبت عملیات را تأیید کرد");
    expect(screen.getByText("WD-1001")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "تأیید ثبت و حذف از صف" }));
    expect(getQueueSize()).toBe(0);
    expect(sync).not.toHaveBeenCalled();
    expect(action.id).toBeTruthy();
  });

  it("offers retry only after the authoritative lookup proves a withdrawal was not committed", async () => {
    enqueueAction({ url: "/api/wallets/withdraw", method: "POST", body: { amount: 500 } });
    const stored = getQueuedActions();
    stored[0].needsReconciliation = true;
    localStorage.setItem("mekanix-offline-queue", JSON.stringify(stored));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ state: "NOT_COMMITTED" })));

    renderCenter(1);
    fireEvent.click(screen.getByRole("button", { name: "بررسی وضعیت سرور" }));
    await screen.findByText("عملیات در سرور ثبت نشده است");
    const retry = screen.getByRole("button", { name: "ارسال دوباره امن" });
    expect(retry).toBeTruthy();
    fireEvent.click(retry);
    await waitFor(() => expect(sync).toHaveBeenCalledTimes(1));
    expect(getQueuedActions()[0].needsReconciliation).toBe(false);
  });

  it("keeps partial prepay financial state unresolved and does not offer retry", async () => {
    enqueueAction({ url: "/api/prepay", method: "POST", body: { jobId: "job-1" } });
    const stored = getQueuedActions();
    stored[0].needsReconciliation = true;
    localStorage.setItem("mekanix-offline-queue", JSON.stringify(stored));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({
      state: "RECONCILIATION_REQUIRED", recordedFinancialRows: 2, expectedFinancialRows: 4,
    }, 409)));

    renderCenter(1);
    fireEvent.click(screen.getByRole("button", { name: "بررسی وضعیت سرور" }));
    await screen.findByText("سوابق مالی ناقص یا ناسازگار است؛ بررسی مدیر لازم است");
    expect(screen.queryByRole("button", { name: "ارسال دوباره امن" })).toBeNull();
    expect(getQueueSize()).toBe(1);
  });

  it("shows a clear error and retains the action when the status service is unavailable", async () => {
    enqueueAction({ url: "/api/wallets/withdraw", method: "POST", body: { amount: 500 } });
    const stored = getQueuedActions();
    stored[0].needsReconciliation = true;
    localStorage.setItem("mekanix-offline-queue", JSON.stringify(stored));
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

    renderCenter(1);
    fireEvent.click(screen.getByRole("button", { name: "بررسی وضعیت سرور" }));
    await screen.findByText("همگام‌سازی ناموفق بود");
    expect(getQueueSize()).toBe(1);
  });

  it("requires explicit confirmation before local cancellation", async () => {
    enqueueAction({ url: "/api/service-requests", method: "POST", body: { title: "Repair" } });
    renderCenter(1);
    fireEvent.click(screen.getByRole("button", { name: "لغو و حذف از دستگاه" }));
    expect(screen.getByText(/از حذف این عملیات معوق مطمئن هستید/)).toBeTruthy();
    expect(getQueueSize()).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "بله، حذف شود" }));
    expect(getQueueSize()).toBe(0);
  });

  it("disables other actions while a server check is in flight", async () => {
    enqueueAction({ url: "/api/wallets/withdraw", method: "POST", body: { amount: 500 } });
    let finish!: (value: any) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise((resolve) => { finish = resolve; })));
    renderCenter(1);
    const check = screen.getByRole("button", { name: "بررسی وضعیت سرور" });
    fireEvent.click(check);
    await waitFor(() => expect(check).toBeDisabled());
    finish(response({ state: "NOT_COMMITTED" }));
    await screen.findByText("عملیات در سرور ثبت نشده است");
  });

  it("does not offer a status check or retry for an endpoint without a read-only contract", () => {
    enqueueAction({ url: "/api/service-requests", method: "POST", body: { title: "Repair" } });
    renderCenter(1);
    expect(screen.queryByRole("button", { name: "بررسی وضعیت سرور" })).toBeNull();
    expect(screen.queryByRole("button", { name: "ارسال دوباره امن" })).toBeNull();
  });
});
