import { describe, expect, it } from "vitest";
import { reconcilePagination } from "@/app/(dashboard)/dashboard/usage/components/ProviderLimits/pagination.js";

const makeQuotas = (count) => Array.from({ length: count }, (_, index) => ({ name: `Quota ${index + 1}` }));
const totalPages = (quotas) => Math.max(1, Math.ceil(quotas.length / 10));
const reconcile = (pagination, quotas = pagination.quotas, sortMode = pagination.sortMode) =>
  reconcilePagination(pagination, quotas, sortMode, totalPages(quotas));

// Use the same array-identity contract as QuotaTable's former [quotas, sortMode] effect.
describe("quota table pagination", () => {
  const quotas = makeQuotas(25);

  it("preserves the selected page and state identity when inputs are unchanged", () => {
    const pagination = { quotas, sortMode: "default", page: 2 };
    expect(reconcile(pagination)).toBe(pagination);
  });

  it.each(["remaining-asc", "remaining-desc", "default"])("resets to page one on sorting to %s", (sortMode) => {
    const previousSort = sortMode === "default" ? "remaining-desc" : "default";
    const pagination = { quotas, sortMode: previousSort, page: 3 };
    expect(reconcile(pagination, quotas, sortMode)).toEqual({ quotas, sortMode, page: 1 });
  });

  it.each([25, 15, 5, 0])("resets to page one when filtering/replacing quotas with %i rows", (count) => {
    const pagination = { quotas, sortMode: "default", page: 3 };
    const filtered = makeQuotas(count);
    expect(reconcile(pagination, filtered)).toEqual({ quotas: filtered, sortMode: "default", page: 1 });
  });

  it("resets even when a filter leaves the same number of pages", () => {
    const pagination = { quotas, sortMode: "default", page: 3 };
    const filtered = quotas.slice(1);
    expect(totalPages(filtered)).toBe(totalPages(quotas));
    expect(reconcile(pagination, filtered).page).toBe(1);
  });

  it("clamps to the last available page if the page count shrinks with the same inputs", () => {
    const rows = makeQuotas(25);
    const pagination = { quotas: rows, sortMode: "default", page: 3 };
    rows.length = 15;
    const clamped = reconcile(pagination);
    expect(clamped.page).toBe(2);
    expect(rows.slice((clamped.page - 1) * 10, clamped.page * 10)).toHaveLength(5);
    expect(reconcile(clamped)).toBe(clamped);
  });

  it("keeps page one for an empty or single-page result", () => {
    const rows = makeQuotas(25);
    const pagination = { quotas: rows, sortMode: "default", page: 3 };
    rows.length = 0;
    expect(reconcile(pagination).page).toBe(1);
    rows.push(...makeQuotas(5));
    expect(reconcile(pagination).page).toBe(1);
  });

  it("does not resurrect an old page after a shrink and subsequent growth", () => {
    const pagination = { quotas, sortMode: "default", page: 3 };
    const clamped = reconcilePagination(pagination, quotas, "default", 2);
    expect(reconcile(clamped).page).toBe(2);
  });

  it("does not resurrect an old page when sorting or filtering back to the original inputs", () => {
    const pagination = { quotas, sortMode: "default", page: 3 };
    const sorted = reconcile(pagination, quotas, "remaining-asc");
    expect(reconcile(sorted, quotas, "default").page).toBe(1);
    const filtered = reconcile(pagination, quotas.slice(0, 15));
    expect(reconcile(filtered, quotas).page).toBe(1);
  });

  it("allows navigation from the reset/clamped page and preserves subsequent rerenders", () => {
    const pagination = { quotas, sortMode: "default", page: 3 };
    const sorted = reconcile(pagination, quotas, "remaining-asc");
    const next = { ...sorted, page: sorted.page + 1 };
    expect(reconcile(next)).toBe(next);
    expect(next.page).toBe(2);
  });
});
