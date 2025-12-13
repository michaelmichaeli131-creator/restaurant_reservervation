// src/middleware/staff_context.ts
// --------------------------------------------------------
// טוען הקשר Staff ל-ctx.state עבור משתמשים עם role="staff".
// נועד כדי להגביל עובד למסעדה אחת (המסעדה שמשויכת אליו ב-StaffMember).
//
// ctx.state שמתווסף:
// - staffMemberships: StaffMember[] (כל השיוכים של העובד)
// - staff: StaffMember | null (השייכות הפעילה שנבחרה)
// - staffRestaurantId: string | null (restaurantId של staff)
//
// כללי בחירה:
// 1) מעדיפים membership שהוא approved + active
// 2) אם אין כזה: נבחר הראשון (אם קיים) אבל נחשיב את העובד כלא-מאושר ברמת הראוטרים
//    (כלומר: requireRestaurantAccess ייחסם).
// --------------------------------------------------------

import type { StaffMember } from "../database.ts";
import { listStaffMembershipsByUser } from "../services/staff_db.ts";

function pickActive(memberships: StaffMember[]): StaffMember | null {
  const approvedActive = memberships.find((m) =>
    m.approvalStatus === "approved" && m.status === "active"
  );
  return approvedActive ?? memberships[0] ?? null;
}

export function staffContextMiddleware() {
  return async (ctx: any, next: () => Promise<unknown>) => {
    const user = (ctx.state as any).user as { id: string; role: string } | null;

    // לנקות תמיד כדי לא להשאיר זבל בין בקשות
    (ctx.state as any).staffMemberships = [];
    (ctx.state as any).staff = null;
    (ctx.state as any).staffRestaurantId = null;

    if (!user || user.role !== "staff") {
      await next();
      return;
    }

    try {
      const memberships = await listStaffMembershipsByUser(user.id);
      (ctx.state as any).staffMemberships = memberships;

      const active = pickActive(memberships);
      (ctx.state as any).staff = active;
      (ctx.state as any).staffRestaurantId = active?.restaurantId ?? null;
    } catch (err) {
      console.warn("[staff-context] failed:", String(err));
      // נשאיר null — הראוטרים יחזירו 403
    }

    await next();
  };
}
