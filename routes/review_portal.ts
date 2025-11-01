// routes/review_portal.ts
// Review submission via secure token link (no login required)

import { Router, Status } from "jsr:@oak/oak";
import { verifyReviewToken } from "../lib/token.ts";
import {
  getRestaurant,
  getReservationById,
  getUserById,
  createReview,
  isReviewTokenUsed,
  markReviewTokenUsed,
  hasUserReviewedReservation,
} from "../database.ts";
import { render } from "../lib/view.ts";
import { debugLog } from "../lib/debug.ts";

export const reviewPortalRouter = new Router();

/* ─────────────────────── GET: Show review form ─────────────────────── */

reviewPortalRouter.get("/review/:token", async (ctx) => {
  const token = String(ctx.params.token ?? "").trim();

  // Verify token
  const payload = await verifyReviewToken(token);
  if (!payload) {
    ctx.response.status = Status.NotFound;
    await render(ctx, "error", {
      title: "קישור לא תקין",
      message: "הקישור לא תקין או שפג תוקפו. קישורי ביקורת תקפים ל-7 ימים.",
    });
    return;
  }

  // Check if token already used
  const tokenUsed = await isReviewTokenUsed(payload.reservationId);
  if (tokenUsed) {
    ctx.response.status = Status.Gone;
    await render(ctx, "error", {
      title: "ביקורת כבר נשלחה",
      message: "כבר השתמשת בקישור זה כדי לכתוב ביקורת. תודה!",
    });
    return;
  }

  // Check if review already submitted (via API)
  const alreadyReviewed = await hasUserReviewedReservation(payload.reservationId);
  if (alreadyReviewed) {
    ctx.response.status = Status.Gone;
    await render(ctx, "error", {
      title: "ביקורת כבר קיימת",
      message: "כבר כתבת ביקורת על ביקור זה. תודה!",
    });
    return;
  }

  // Get reservation and restaurant data
  const reservation = await getReservationById(payload.reservationId);
  const restaurant = await getRestaurant(payload.restaurantId);
  const user = await getUserById(payload.userId);

  if (!reservation || !restaurant) {
    ctx.response.status = Status.NotFound;
    await render(ctx, "error", {
      title: "לא נמצא",
      message: "ההזמנה או המסעדה לא נמצאו.",
    });
    return;
  }

  // Render review form
  await render(ctx, "review_form", {
    title: `ביקורת - ${restaurant.name}`,
    page: "review_form",
    token,
    reservation,
    restaurant,
    user,
    error: null,
  });
});

/* ─────────────────────── POST: Submit review ─────────────────────── */

reviewPortalRouter.post("/review/:token", async (ctx) => {
  const token = String(ctx.params.token ?? "").trim();

  // Verify token
  const payload = await verifyReviewToken(token);
  if (!payload) {
    ctx.response.status = Status.NotFound;
    await render(ctx, "error", {
      title: "קישור לא תקין",
      message: "הקישור לא תקין או שפג תוקפו.",
    });
    return;
  }

  // Check if token already used
  const tokenUsed = await isReviewTokenUsed(payload.reservationId);
  if (tokenUsed) {
    ctx.response.status = Status.Gone;
    await render(ctx, "error", {
      title: "ביקורת כבר נשלחה",
      message: "כבר השתמשת בקישור זה.",
    });
    return;
  }

  // Check if review already exists
  const alreadyReviewed = await hasUserReviewedReservation(payload.reservationId);
  if (alreadyReviewed) {
    ctx.response.status = Status.Gone;
    await render(ctx, "error", {
      title: "ביקורת כבר קיימת",
      message: "כבר כתבת ביקורת על ביקור זה.",
    });
    return;
  }

  // Parse form data
  const body = await ctx.request.body.formData();
  const rating = Number(body.get("rating") ?? 0);
  const comment = String(body.get("comment") ?? "").trim();

  // Validate rating
  if (!rating || rating < 1 || rating > 5) {
    const reservation = await getReservationById(payload.reservationId);
    const restaurant = await getRestaurant(payload.restaurantId);
    const user = await getUserById(payload.userId);

    ctx.response.status = Status.BadRequest;
    await render(ctx, "review_form", {
      title: `ביקורת - ${restaurant?.name}`,
      page: "review_form",
      token,
      reservation,
      restaurant,
      user,
      error: "נא לבחור דירוג בין 1 ל-5 כוכבים",
    });
    return;
  }

  try {
    // Create review
    await createReview({
      restaurantId: payload.restaurantId,
      userId: payload.userId,
      reservationId: payload.reservationId,
      rating,
      comment: comment || undefined,
    });

    // Mark token as used
    await markReviewTokenUsed(payload.reservationId);

    debugLog("[review_portal] Review submitted:", {
      reservationId: payload.reservationId,
      restaurantId: payload.restaurantId,
      rating,
    });

    // Show success page
    const restaurant = await getRestaurant(payload.restaurantId);
    await render(ctx, "review_success", {
      title: "תודה!",
      page: "review_success",
      restaurant,
    });
  } catch (e) {
    debugLog("[review_portal] Error submitting review:", String(e));

    const reservation = await getReservationById(payload.reservationId);
    const restaurant = await getRestaurant(payload.restaurantId);
    const user = await getUserById(payload.userId);

    ctx.response.status = Status.InternalServerError;
    await render(ctx, "review_form", {
      title: `ביקורת - ${restaurant?.name}`,
      page: "review_form",
      token,
      reservation,
      restaurant,
      user,
      error: "אירעה שגיאה בשמירת הביקורת. נסה שוב.",
    });
  }
});

export default reviewPortalRouter;
