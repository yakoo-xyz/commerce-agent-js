import type { VoucherSpec } from "./query-parser.js";

export function voucherMaxTotalPrice(voucher: VoucherSpec): number | null {
  const discountType = voucher.discount_type ?? "percentage";
  const discountRate = Number(voucher.discount_value ?? 0);
  const minRequired = Number(voucher.threshold ?? 0);
  const discountCap = Number(voucher.cap ?? 0);
  const budget = Number(voucher.budget ?? 0);

  if (discountType === "fixed") {
    const maxPrice = budget + discountRate;
    if (maxPrice <= minRequired) return minRequired;
    return maxPrice;
  }

  const rate = discountRate > 1 ? discountRate / 100 : discountRate;
  if (rate <= 0 || rate >= 1) return null;

  let maxPrice: number;
  if (discountCap > 0 && budget / (1 - rate) > budget + discountCap) {
    maxPrice = budget + discountCap;
  } else {
    maxPrice = budget / (1 - rate);
  }

  if (maxPrice <= minRequired) return minRequired;
  return maxPrice;
}

export interface VoucherCalculation {
  prices: number[];
  total_before: number;
  discount_amount: number;
  total_after: number;
  within_budget: boolean;
  voucher_applied: boolean;
  budget: number;
}

export function calculateVoucher(
  productPrices: string,
  voucherType: string,
  discountValue: number,
  threshold: number,
  budget: number,
  cap = 0,
): VoucherCalculation | { error: string } {
  const prices = productPrices
    .split(",")
    .map((p) => Number(p.trim()))
    .filter((n) => Number.isFinite(n));

  if (!prices.length) {
    return { error: "Invalid product_prices format. Use comma-separated numbers." };
  }

  const total = prices.reduce((s, n) => s + n, 0);
  let discount = 0;
  let voucherApplied = false;

  if (total >= threshold) {
    voucherApplied = true;
    if (voucherType === "fixed") {
      discount = discountValue;
    } else {
      discount = total * (discountValue / 100);
      if (cap > 0) discount = Math.min(discount, cap);
    }
  }

  const totalAfter = total - discount;
  return {
    prices,
    total_before: Math.round(total * 100) / 100,
    discount_amount: Math.round(discount * 100) / 100,
    total_after: Math.round(totalAfter * 100) / 100,
    within_budget: totalAfter <= budget,
    voucher_applied: voucherApplied,
    budget,
  };
}
