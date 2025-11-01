// routes/reviews.ts
import { Router, Status } from "jsr:@oak/oak";
import {
  createReview,
  listReviewsByRestaurant,
  canUserReview,
  addOwnerReply,
  getReview,
  getRestaurant,
  getUserById,
  type Review,
} from "../database.ts";
import { debugLog } from "../lib/debug.ts";

export const reviewsRouter = new Router();

/* ─────────────────────── GET: List reviews for a restaurant ─────────────────────── */

reviewsRouter.get("/api/restaurants/:restaurantId/reviews", async (ctx) => {
  const restaurantId = ctx.params.restaurantId!;
  const limit = Number(ctx.request.url.searchParams.get("limit") ?? "50");

  try {
    const reviews = await listReviewsByRestaurant(restaurantId, Math.min(limit, 100));

    // Enrich with user data
    const enriched = await Promise.all(
      reviews.map(async (review) => {
        const user = await getUserById(review.userId);
        return {
          ...review,
          user: user ? {
            firstName: user.firstName,
            lastName: user.lastName,
          } : null,
        };
      })
    );

    ctx.response.status = Status.OK;
    ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
    ctx.response.body = JSON.stringify(enriched);
  } catch (e) {
    debugLog("[reviews] Error listing reviews:", String(e));
    ctx.response.status = Status.InternalServerError;
    ctx.response.body = JSON.stringify({ error: "Failed to load reviews" });
  }
});

/* ─────────────────────── POST: Create a review ─────────────────────── */

reviewsRouter.post("/api/restaurants/:restaurantId/reviews", async (ctx) => {
  const user = (ctx.state as any)?.user;
  if (!user) {
    ctx.response.status = Status.Unauthorized;
    ctx.response.body = JSON.stringify({ error: "Authentication required" });
    return;
  }

  const restaurantId = ctx.params.restaurantId!;

  try {
    const body = await ctx.request.body.json();
    const { reservationId, rating, comment } = body;

    if (!reservationId || !rating) {
      ctx.response.status = Status.BadRequest;
      ctx.response.body = JSON.stringify({ error: "Missing reservationId or rating" });
      return;
    }

    // Validate rating
    const numRating = Number(rating);
    if (!Number.isFinite(numRating) || numRating < 1 || numRating > 5) {
      ctx.response.status = Status.BadRequest;
      ctx.response.body = JSON.stringify({ error: "Rating must be between 1 and 5" });
      return;
    }

    // Check eligibility
    const eligible = await canUserReview(user.id, restaurantId, reservationId);
    if (!eligible) {
      ctx.response.status = Status.Forbidden;
      ctx.response.body = JSON.stringify({
        error: "You are not eligible to review this restaurant. Reviews can only be submitted 1-30 days after a completed visit."
      });
      return;
    }

    // Create review
    const review = await createReview({
      restaurantId,
      userId: user.id,
      reservationId,
      rating: numRating,
      comment: comment?.trim() || undefined,
    });

    debugLog("[reviews] Created review:", { id: review.id, restaurantId, rating: numRating });

    ctx.response.status = Status.Created;
    ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
    ctx.response.body = JSON.stringify({ ok: true, review });
  } catch (e) {
    debugLog("[reviews] Error creating review:", String(e));

    if (String(e).includes("create_review_race")) {
      ctx.response.status = Status.Conflict;
      ctx.response.body = JSON.stringify({ error: "You have already reviewed this visit" });
    } else {
      ctx.response.status = Status.InternalServerError;
      ctx.response.body = JSON.stringify({ error: "Failed to create review" });
    }
  }
});

/* ─────────────────────── POST: Owner reply to review ─────────────────────── */

reviewsRouter.post("/api/reviews/:reviewId/reply", async (ctx) => {
  const user = (ctx.state as any)?.user;
  if (!user || user.role !== "owner") {
    ctx.response.status = Status.Forbidden;
    ctx.response.body = JSON.stringify({ error: "Owner access required" });
    return;
  }

  const reviewId = ctx.params.reviewId!;

  try {
    const review = await getReview(reviewId);
    if (!review) {
      ctx.response.status = Status.NotFound;
      ctx.response.body = JSON.stringify({ error: "Review not found" });
      return;
    }

    // Verify owner owns this restaurant
    const restaurant = await getRestaurant(review.restaurantId);
    if (!restaurant || restaurant.ownerId !== user.id) {
      ctx.response.status = Status.Forbidden;
      ctx.response.body = JSON.stringify({ error: "You can only reply to reviews for your own restaurants" });
      return;
    }

    const body = await ctx.request.body.json();
    const { reply } = body;

    if (!reply || !reply.trim()) {
      ctx.response.status = Status.BadRequest;
      ctx.response.body = JSON.stringify({ error: "Reply text is required" });
      return;
    }

    const updated = await addOwnerReply(reviewId, reply.trim());

    debugLog("[reviews] Owner replied to review:", { reviewId, restaurantId: review.restaurantId });

    ctx.response.status = Status.OK;
    ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
    ctx.response.body = JSON.stringify({ ok: true, review: updated });
  } catch (e) {
    debugLog("[reviews] Error adding owner reply:", String(e));
    ctx.response.status = Status.InternalServerError;
    ctx.response.body = JSON.stringify({ error: "Failed to add reply" });
  }
});

export default reviewsRouter;
