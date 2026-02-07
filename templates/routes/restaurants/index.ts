// src/routes/restaurants/index.ts
import { Router } from "jsr:@oak/oak";
import * as Restaurant from "./restaurant.controller.ts";
import * as Reservation from "./reservation.controller.ts";
import * as Owner from "./owner.controller.ts";
import * as Manage from "./manage.controller.ts";

export const restaurantsRouter = new Router();

// API
restaurantsRouter.get("/api/restaurants", Restaurant.autocomplete);

// שלב 1
restaurantsRouter.get("/restaurants/:id", Restaurant.view);

// זמינות
restaurantsRouter.post("/api/restaurants/:id/check", Reservation.checkApi);
restaurantsRouter.post("/restaurants/:id/reserve", Reservation.reservePost);

// שלב 2 + אישור
restaurantsRouter.get("/restaurants/:id/details", Reservation.detailsGet);
restaurantsRouter.get("/restaurants/:id/confirm", Reservation.confirmGet);
restaurantsRouter.post("/restaurants/:id/confirm", Reservation.confirmPost);

// בעלים – שעות פתיחה
restaurantsRouter.post("/restaurants/:id/hours", Owner.saveHours);

// ניהול עצמי
restaurantsRouter.get("/r/:token", Manage.manageGet);
restaurantsRouter.post("/r/:token", Manage.managePost);

export default restaurantsRouter;
export const router = restaurantsRouter;
