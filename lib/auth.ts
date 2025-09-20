import { compare, genSalt, hash } from "bcrypt";

export async function hashPassword(plain: string) {
  const salt = await genSalt(10);
  return await hash(plain, salt);
}

export async function verifyPassword(plain: string, passwordHash: string) {
  return await compare(plain, passwordHash);
}

export function requireAuth(ctx: any) {
  if (!ctx.state.user) {
    ctx.response.redirect("/login");
    return false;
  }
  return true;
}

export function requireOwner(ctx: any) {
  if (!ctx.state.user || ctx.state.user.role !== "owner") {
    ctx.response.status = 403;
    ctx.response.body = "Forbidden";
    return false;
  }
  return true;
}
