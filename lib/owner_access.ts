import { isRestaurantOwner } from "../services/authz.ts";

export async function requireRestaurantOwner(ctx: any, restaurantId: string): Promise<boolean> {
  if (restaurantId && await isRestaurantOwner(ctx.state?.user ?? null, restaurantId)) return true;
  ctx.response.status = 403;
  ctx.response.body = "Forbidden";
  return false;
}
