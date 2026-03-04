// src/routes/owner_deposit_settings.ts
// Deposit payment settings for restaurants — owners only
// Direct-to-restaurant payment links (Stripe, SumUp, PayPal.me, Revolut)

import { Router, Status } from "jsr:@oak/oak";
import { render } from "../lib/view.ts";
import { getRestaurant, updateRestaurant, type Restaurant } from "../database.ts";
import { requireOwner } from "../lib/auth.ts";
import { debugLog } from "../lib/debug.ts";

const ownerDepositRouter = new Router();

// Supported currencies
const CURRENCIES = [
  { code: "EUR", symbol: "€", label: "Euro (€)" },
  { code: "GBP", symbol: "£", label: "British Pound (£)" },
  { code: "USD", symbol: "$", label: "US Dollar ($)" },
] as const;

// Payment method definitions
const PAYMENT_METHODS = [
  {
    key: "stripePaymentLink",
    label: "Stripe Payment Link",
    placeholder: "https://buy.stripe.com/...",
    hint: "Create a payment link in your Stripe dashboard",
  },
  {
    key: "sumupPaymentLink",
    label: "SumUp Payment Link",
    placeholder: "https://pay.sumup.com/...",
    hint: "Create a payment link in your SumUp app",
  },
  {
    key: "paypalMe",
    label: "PayPal.me",
    placeholder: "username or https://paypal.me/username",
    hint: "Your PayPal.me username or full link",
  },
  {
    key: "revolutLink",
    label: "Revolut",
    placeholder: "username or https://revolut.me/username",
    hint: "Your Revolut username or payment link",
  },
] as const;

// Validate URL format (basic check)
function isValidUrl(str: string): boolean {
  if (!str) return false;
  try {
    new URL(str);
    return true;
  } catch {
    return false;
  }
}

// Normalize payment method URL/username
function normalizePaymentMethod(key: string, value: string): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;

  // For Stripe and SumUp, require full URL
  if (key === "stripePaymentLink" || key === "sumupPaymentLink") {
    return isValidUrl(trimmed) ? trimmed : undefined;
  }

  // For PayPal.me, accept username or URL
  if (key === "paypalMe") {
    if (isValidUrl(trimmed)) return trimmed;
    // Convert username to URL
    const username = trimmed.replace(/^@/, "").replace(/^https?:\/\/paypal\.me\//i, "");
    return username ? `https://paypal.me/${username}` : undefined;
  }

  // For Revolut, accept username or URL
  if (key === "revolutLink") {
    if (isValidUrl(trimmed)) return trimmed;
    // Convert username to URL
    const username = trimmed.replace(/^@/, "").replace(/^https?:\/\/revolut\.me\//i, "");
    return username ? `https://revolut.me/${username}` : undefined;
  }

  return trimmed;
}

// Check if at least one payment method is configured
function hasAnyPaymentMethod(pm: Restaurant["paymentMethods"]): boolean {
  if (!pm) return false;
  return !!(pm.stripePaymentLink || pm.sumupPaymentLink || pm.paypalMe || pm.revolutLink);
}

// ---------- GET: Deposit settings page ----------
ownerDepositRouter.get("/owner/restaurants/:id/deposit", async (ctx) => {
  if (!requireOwner(ctx)) return;

  const id = ctx.params.id!;
  debugLog("[owner_deposit][GET] enter", { path: ctx.request.url.pathname, id });

  const r = await getRestaurant(id);
  debugLog("[owner_deposit][GET] load", {
    id,
    found: !!r,
    ownerId: r?.ownerId,
    userId: (ctx.state as any)?.user?.id,
  });

  if (!r) {
    ctx.response.status = Status.NotFound;
    await render(ctx, "error", {
      title: "Not Found",
      message: "Restaurant not found.",
    });
    return;
  }
  if (r.ownerId !== (ctx.state as any)?.user?.id) {
    ctx.response.status = Status.Forbidden;
    await render(ctx, "error", {
      title: "Access Denied",
      message: "You do not have permission for this restaurant.",
    });
    return;
  }

  const saved = ctx.request.url.searchParams.get("saved") === "1";
  const error = ctx.request.url.searchParams.get("error");

  await render(ctx, "owner_deposit_settings.eta", {
    page: "owner_deposit",
    restaurant: r,
    saved,
    error,
    currencies: CURRENCIES,
    paymentMethods: PAYMENT_METHODS,
    // Convert cents to display value
    depositAmountDisplay: r.depositAmount ? (r.depositAmount / 100).toFixed(2) : "",
  });
});

// ---------- GET: Save deposit settings ----------
ownerDepositRouter.get("/owner/restaurants/:id/deposit/save", async (ctx) => {
  if (!requireOwner(ctx)) return;

  const id = ctx.params.id!;
  const r = await getRestaurant(id);

  if (!r) {
    ctx.response.status = Status.NotFound;
    await render(ctx, "error", {
      title: "Not Found",
      message: "Restaurant not found.",
    });
    return;
  }
  if (r.ownerId !== (ctx.state as any)?.user?.id) {
    ctx.response.status = Status.Forbidden;
    await render(ctx, "error", {
      title: "Access Denied",
      message: "You do not have permission for this restaurant.",
    });
    return;
  }

  const sp = ctx.request.url.searchParams;

  // Build payment methods object
  const paymentMethods: Restaurant["paymentMethods"] = {};
  for (const pm of PAYMENT_METHODS) {
    const value = sp.get(pm.key);
    if (value) {
      const normalized = normalizePaymentMethod(pm.key, value);
      if (normalized) {
        (paymentMethods as any)[pm.key] = normalized;
      }
    }
  }

  // Parse deposit amount (convert from display value to cents)
  const amountStr = sp.get("depositAmount") || "";
  const amountNum = parseFloat(amountStr.replace(",", "."));
  const depositAmount = Number.isFinite(amountNum) && amountNum > 0
    ? Math.round(amountNum * 100)
    : 0;

  // Parse currency
  const currencyRaw = sp.get("depositCurrency") || "EUR";
  const depositCurrency = CURRENCIES.some(c => c.code === currencyRaw)
    ? currencyRaw as "EUR" | "GBP" | "USD"
    : "EUR";

  // Parse enabled flag
  const depositEnabled = sp.get("depositEnabled") === "on";

  // Validation: if enabled, must have amount and at least one payment method
  if (depositEnabled) {
    if (depositAmount <= 0) {
      ctx.response.status = Status.SeeOther;
      ctx.response.headers.set(
        "Location",
        `/owner/restaurants/${encodeURIComponent(id)}/deposit?error=amount`,
      );
      return;
    }
    if (!hasAnyPaymentMethod(paymentMethods)) {
      ctx.response.status = Status.SeeOther;
      ctx.response.headers.set(
        "Location",
        `/owner/restaurants/${encodeURIComponent(id)}/deposit?error=method`,
      );
      return;
    }
  }

  const patch: Partial<Restaurant> = {
    depositEnabled,
    depositAmount,
    depositCurrency,
    paymentMethods,
  };

  debugLog("[owner_deposit][SAVE] patch", patch);

  await updateRestaurant(id, patch);

  ctx.response.status = Status.SeeOther;
  ctx.response.headers.set(
    "Location",
    `/owner/restaurants/${encodeURIComponent(id)}/deposit?saved=1`,
  );
});

// ---------- POST (backward compatibility) ----------
ownerDepositRouter.post("/owner/restaurants/:id/deposit", async (ctx) => {
  const id = ctx.params.id!;
  const sp = ctx.request.url.searchParams;
  ctx.response.status = Status.SeeOther;
  ctx.response.headers.set(
    "Location",
    `/owner/restaurants/${encodeURIComponent(id)}/deposit/save?${sp.toString()}`,
  );
});

export default ownerDepositRouter;
export { ownerDepositRouter };
