# GeoTable Restaurant Reservation System - Complete Overview

## 🏗️ Architecture Overview

**GeoTable** is a full-featured restaurant reservation platform built with **Deno**, **Oak** (web framework), and **Deno KV** (embedded key-value database). The system supports Hebrew (RTL) and English, with role-based access for customers, restaurant owners, and admins.

### Tech Stack
- **Runtime:** Deno 2.5.4 (TypeScript native)
- **Framework:** Oak 17.x (like Express for Deno)
- **Database:** Deno KV (embedded key-value store, no SQL needed)
- **Templates:** Eta 3.x (like EJS)
- **Authentication:** Session-based with bcrypt password hashing
- **Styling:** Custom CSS with RTL support

---

## 📁 Project Structure

```
restaurant_reservervation/
├── server.ts                    # Main entry point - HTTP server (432 lines)
├── database.ts                  # Database layer & KV operations (~1200 lines)
├── deno.json                    # Dependencies & task definitions
├── .env                         # Environment variables (SECRETS - not committed)
├── .env.example                 # Template for environment setup
│
├── lib/                         # Shared utilities & middleware
│   ├── auth.ts                  # Password hashing/verification (bcrypt)
│   ├── session.ts               # Cookie-based sessions (stored in KV)
│   ├── view.ts                  # Eta template rendering engine
│   ├── mail.ts                  # Email sending (verification, password reset)
│   ├── token.ts                 # JWT/token generation & validation
│   ├── log_mw.ts                # Request logging middleware
│   └── debug.ts                 # Debug utilities
│
├── routes/                      # HTTP route handlers (~3500 lines total)
│   ├── auth.ts                  # Login, register, email verification, password reset
│   ├── admin.ts                 # Admin dashboard (approve restaurants, manage users)
│   ├── owner.ts                 # Restaurant owner dashboard
│   ├── owner_capacity.ts        # Capacity management
│   ├── owner_calendar.ts        # Daily occupancy calendar/timeline view
│   ├── owner_hours.ts           # Opening hours management
│   ├── owner_manage.ts          # Restaurant editing
│   ├── owner_photos.ts          # Photo upload/management
│   ├── reservation_portal.ts   # Email-based reservation management
│   ├── opening.ts               # Opening hours UI
│   ├── diag.ts                  # Diagnostics & debugging endpoints
│   ├── root.ts                  # Root routes
│   └── restaurants/             # Public restaurant & reservation routes
│       ├── index.ts             # Route definitions
│       ├── restaurant.controller.ts    # Restaurant listing, search, autocomplete
│       ├── reservation.controller.ts   # Booking flow (check availability, reserve, confirm)
│       ├── owner.controller.ts         # Owner-specific restaurant operations
│       ├── manage.controller.ts        # Self-service reservation management
│       └── _utils/              # Shared utilities
│           ├── datetime.ts      # Date/time helpers
│           ├── hours.ts         # Opening hours parsing
│           ├── body.ts          # Request body parsing
│           ├── rtl.ts           # RTL text handling
│           └── misc.ts          # Miscellaneous helpers
│
├── services/                    # Business logic services
│   ├── occupancy.ts             # Calculate seat/table occupancy per time slot
│   └── timeline.ts              # Generate time slot grids for reservations
│
├── templates/                   # Eta HTML templates (server-side rendered)
│   ├── _layout.eta              # Main layout wrapper (header, nav, footer)
│   ├── index.eta                # Homepage (search + carousel)
│   ├── restaurant.eta           # Restaurant detail + booking form
│   ├── restaurant_detail.eta    # Alternative restaurant view
│   ├── reservation_details.eta  # Reservation confirmation details
│   ├── reservation_confirmed.eta # Booking success page
│   ├── reservation_manage.eta   # Customer self-service management
│   ├── owner_dashboard.eta      # Restaurant owner dashboard
│   ├── owner_restaurant_edit.eta # Restaurant editing form
│   ├── owner_hours.eta          # Opening hours editor
│   ├── owner_calendar.eta       # Daily occupancy timeline
│   ├── owner_photos.eta         # Photo manager
│   ├── admin_dashboard.eta      # Admin panel
│   ├── admin_restaurants.eta    # Restaurant approval queue
│   ├── verify_notice.eta        # Email verification prompt
│   ├── verify_done.eta          # Verification success
│   ├── signup.eta               # Registration page
│   └── auth/                    # Authentication templates
│       ├── _layout.eta          # Auth-specific layout
│       ├── login.eta            # Login form
│       ├── register.eta         # Registration form
│       ├── forgot.eta           # Password reset request
│       └── reset.eta            # Password reset form
│
└── public/                      # Static assets
    ├── styles.css               # Global styles
    ├── app.js                   # Client-side JavaScript
    ├── placeholder.png          # Default restaurant image
    ├── css/                     # Component-specific styles
    │   ├── spotbook.css
    │   └── owner_calendar.css
    ├── js/                      # JavaScript modules
    └── img/                     # Images
        ├── logo-spotbook.png
        └── restaurants/         # Restaurant photos
```

---

## 🗄️ Database Architecture (Deno KV)

### What is Deno KV?
Deno KV is an **embedded key-value database** (like SQLite but simpler). It stores data locally in a binary file and uses hierarchical keys for organization.

### Local Storage Location
- **Development:** `./deno_kv_data` (auto-created in project root)
- **Production (Deno Deploy):** Managed cloud KV store

### Data Models

#### User (`database.ts:5-19`)
```typescript
{
  id: string;              // UUID
  email: string;           // Normalized lowercase
  username: string;        // Unique
  firstName: string;
  lastName: string;
  age?: number;
  businessType?: string;
  passwordHash?: string;   // bcrypt (local auth only)
  role: "user" | "owner";  // Authorization level
  provider: "local" | "google"; // Auth method
  emailVerified?: boolean; // Email confirmation status
  isActive?: boolean;      // Account enabled/disabled
  createdAt: number;       // Unix timestamp
}
```

#### Restaurant (`database.ts:26-43`)
```typescript
{
  id: string;
  ownerId: string;         // Links to User.id
  name: string;
  city: string;
  address: string;
  phone?: string;
  description?: string;
  menu: Array<{name, price, desc}>;
  capacity: number;        // Max simultaneous diners
  slotIntervalMinutes: 15; // Time grid resolution
  serviceDurationMinutes: 120; // Default meal duration
  weeklySchedule?: {       // Opening hours per day
    0: {open: "11:00", close: "22:00"}, // Sunday
    1: {open: "11:00", close: "22:00"}, // Monday
    // ... etc
  };
  photos?: string[];       // Base64 data URLs or paths
  approved?: boolean;      // Admin approval required
  createdAt: number;
}
```

#### Reservation (`database.ts:45-62`)
```typescript
{
  id: string;
  restaurantId: string;
  userId: string;          // Or "manual-block:<ownerId>" for owner blocks
  date: "2025-01-15";      // YYYY-MM-DD
  time: "18:30";           // HH:mm
  people: number;          // Party size
  firstName?: string;
  lastName?: string;
  phone?: string;
  note?: string;           // Special requests
  durationMinutes?: 120;
  status?: "new" | "confirmed" | "canceled" | "blocked" | "arrived" | etc.
  createdAt: number;
}
```

### KV Key Patterns (`database.ts:70-81`)

The database uses hierarchical keys:

```
["user", userId]                           → User object
["user_email", normalizedEmail]            → userId (index)
["user_username", normalizedUsername]      → userId (index)
["restaurant", restaurantId]               → Restaurant object
["restaurant_owner", ownerId, restaurantId] → Restaurant object (index)
["reservation", reservationId]             → Reservation object
["reservation_user", userId, reservationId] → Reservation object (index)
["reservation_rest", restaurantId, date, reservationId] → Reservation (index)
["sess", sessionId]                        → Session data
["verify_token", token]                    → {userId, expires}
["reset_token", token]                     → {userId, expires}
```

---

## 🔐 Authentication & Authorization

### Session Flow (`lib/session.ts:36`)
1. Browser → Request
2. Middleware checks cookie `sid`
3. If missing → Generate new UUID session ID
4. Load session data from KV: `["sess", sid]`
5. Store in `ctx.state.session`
6. Set cookie (HttpOnly, SameSite, Secure in production)

### User Loading (`server.ts:163-180`)
After session middleware:
1. Get `userId` from session
2. Load user from KV: `["user", userId]`
3. Store in `ctx.state.user`
4. Templates can access via `it.user`

### Protected Routes (`server.ts:311-345`)
Auth gate middleware blocks:
- `/owner/*` - Requires logged in + verified email + active account
- `/dashboard/*`
- `/manage/*`
- `/opening/*`

Redirects to `/auth/login?redirect={originalPath}` if not authenticated.

### Password Security (`lib/auth.ts`)
- **Hashing:** bcrypt (salt rounds: 10)
- **Verification:** Timing-safe comparison
- **Password Reset:** Tokens expire in 1 hour

---

## 🚀 Development Workflow

### Starting the Server

**Command Line (with hot reload):**
```bash
deno task dev
# Runs: deno run --allow-net --allow-env --allow-read --unstable-kv --env-file=.env server.ts
```

**IntelliJ IDEA:**
- Select **"Deno Dev (Run)"** from dropdown → Click Run ▶️
- Select **"Deno Dev (Debug)"** from dropdown → Click Debug 🐛

### ⚠️ Hot Reload Status
**NO BUILT-IN HOT RELOAD** - You must manually restart the server after code changes.

**Workarounds:**
1. Use `deno task dev --watch` (experimental, may be unstable)
2. Use external tools like `denon` or `watchexec`
3. Manually restart (Ctrl+C → re-run)

### Debugging Locally

**IntelliJ:**
1. Set breakpoints (click gutter)
2. Run "Deno Dev (Debug)" configuration
3. Server starts with `--inspect-wait` flag
4. Debugger pauses at breakpoints
5. Inspect variables, step through code

**Chrome DevTools:**
1. Run with `--inspect` or `--inspect-brk`
2. Open `chrome://inspect`
3. Click "inspect" under Remote Target
4. Full debugger, console, network tab

### Local URLs
- **Homepage:** http://localhost:8000
- **Admin Panel:** http://localhost:8000/admin
- **Login:** http://localhost:8000/auth/login
- **Health Check:** http://localhost:8000/__health
- **Echo (debug):** http://localhost:8000/__echo

---

## 🎯 Key Features

### For Customers
1. **Search & Browse** (`routes/restaurants/restaurant.controller.ts`)
   - Full-text search by name, city, cuisine
   - Autocomplete with thumbnails
   - Approved restaurants only

2. **Book Reservations** (`routes/restaurants/reservation.controller.ts`)
   - Select date/time/party size
   - Real-time availability check (considers capacity + existing bookings)
   - Confirmation email with management token

3. **Manage Bookings** (`routes/restaurants/manage.controller.ts`)
   - Token-based access (no login required)
   - Cancel/reschedule via email link

### For Restaurant Owners
1. **Dashboard** (`routes/owner.ts`)
   - View all owned restaurants
   - Today's reservations summary
   - Quick stats

2. **Restaurant Management** (`routes/owner_manage.ts`)
   - Edit name, address, description, menu
   - Set capacity & slot intervals
   - Upload photos (base64 storage)

3. **Opening Hours** (`routes/owner_hours.ts`)
   - Visual weekly schedule editor
   - Per-day time ranges (open/close)
   - Closed days configuration

4. **Calendar View** (`routes/owner_calendar.ts`)
   - Daily timeline with occupancy heatmap
   - See all reservations per time slot
   - Manual blocking (reserve slots for events)
   - Drag-to-select time ranges
   - Status updates (arrived, canceled, etc.)

5. **Capacity Planning** (`routes/owner_capacity.ts`)
   - Set max simultaneous diners
   - Configure slot intervals (15/30/60 min)
   - Default service duration

### For Admins
1. **Approve Restaurants** (`routes/admin.ts`)
   - Queue of pending restaurants
   - Bulk approve/reject
   - View owner details

2. **User Management**
   - Activate/deactivate accounts
   - Change roles (user ↔ owner)
   - Force email verification

---

## 🌐 Routing Structure

### Public Routes
| Route | Method | Handler | Description |
|-------|--------|---------|-------------|
| `/` | GET | `server.ts:233` | Homepage (search + recommended) |
| `/restaurants/:id` | GET | `restaurant.controller.ts` | Restaurant detail page |
| `/api/restaurants` | GET | `restaurant.controller.ts:autocomplete` | Search autocomplete |
| `/api/restaurants/:id/check` | POST | `reservation.controller.ts:checkApi` | Check availability |
| `/restaurants/:id/reserve` | POST | `reservation.controller.ts:reservePost` | Create reservation |
| `/restaurants/:id/confirm` | GET/POST | `reservation.controller.ts:confirm*` | Confirm booking |
| `/r/:token` | GET/POST | `manage.controller.ts` | Manage reservation |

### Auth Routes (`routes/auth.ts`)
| Route | Method | Description |
|-------|--------|-------------|
| `/auth/login` | GET/POST | Login form |
| `/auth/register` | GET/POST | Registration |
| `/auth/logout` | GET | Destroy session |
| `/auth/verify/:token` | GET | Email verification |
| `/auth/forgot` | GET/POST | Request password reset |
| `/auth/reset/:token` | GET/POST | Reset password |

### Owner Routes (Protected)
| Route | Method | Description |
|-------|--------|-------------|
| `/owner` | GET | Owner dashboard |
| `/owner/restaurants/new` | GET/POST | Create restaurant |
| `/owner/restaurants/:id/edit` | GET/POST | Edit restaurant |
| `/owner/restaurants/:id/hours` | GET/POST | Opening hours |
| `/owner/restaurants/:id/photos` | GET/POST | Photo manager |
| `/owner/restaurants/:id/calendar` | GET | Daily occupancy timeline |
| `/owner/restaurants/:id/capacity` | GET/POST | Capacity settings |

### Admin Routes (`routes/admin.ts`)
Requires `ADMIN_SECRET` query parameter.

---

## 🔧 Configuration

### Environment Variables (`.env`)

```bash
# Server
PORT=8000                          # HTTP port
NODE_ENV=development               # "development" | "production"
BASE_URL=http://localhost:8000     # For email links

# Security
TOKEN_SECRET=your-secret-32-chars  # JWT signing key
ADMIN_SECRET=admin-secret          # Admin panel password
TOKEN_EXP_DAYS=7                   # Token expiration
TOKEN_CLOCK_SKEW_MS=60000          # Clock drift tolerance

# Email (optional - logs to console if not set)
RESEND_API_KEY=re_xxx              # Resend.com API key
MAIL_FROM=noreply@example.com      # Sender email
RESEND_DRY_RUN=true                # Log emails instead of sending

# Debug
DEBUG=true                         # Enable verbose logging
ENV=development                    # Environment name
```

### Deno Permissions (`deno.json:3`)
```json
{
  "tasks": {
    "dev": "deno run --allow-net --allow-env --allow-read --unstable-kv --env-file=.env server.ts"
  }
}
```

- `--allow-net` - HTTP server + outbound requests
- `--allow-env` - Read environment variables
- `--allow-read` - Templates, static files
- `--unstable-kv` - Deno KV database API
- `--env-file=.env` - Load .env automatically

---

## 🧪 Testing & Debugging

### Debug Endpoints (`routes/diag.ts`)
- `/__health` - Health check (200 OK + timestamp)
- `/__echo` - Echo request details (method, headers, query)
- `/__env?key={ADMIN_SECRET}` - Show environment config
- `/__mailtest?key={ADMIN_SECRET}&to={email}` - Test email sending

### Logging
- All requests logged with: `[RES {reqId}] {status} {method} {path} {duration}ms`
- Errors logged with stack traces
- User activity tracked: `user={email}({id})`

### Common Issues

**1. `Deno.openKv is not a function`**
- **Fix:** Add `--unstable-kv` flag

**2. `TOKEN_SECRET not set` warning**
- **Fix:** Set TOKEN_SECRET in `.env` (32+ chars)

**3. Templates not found**
- **Check:** `lib/view.ts:91` picks template directory
- **Candidates:** `/templates`, `./templates`, `../templates`

**4. Session not persisting**
- **Check:** Cookies enabled in browser
- **Check:** HTTPS in production (secure cookies)

**5. Email not sending**
- **Expected:** Emails log to console if RESEND_API_KEY not set
- **Check:** RESEND_DRY_RUN=false to actually send

---

## 📊 Code Statistics

- **Total TypeScript:** ~6,000 lines
- **Routes:** ~3,500 lines
- **Database:** ~1,200 lines
- **Server:** 432 lines
- **Templates:** 20+ Eta files
- **Middleware:** 7 files in `lib/`

---

## 🚢 Deployment Notes

### Deno Deploy (Recommended)
1. Push to GitHub
2. Connect to Deno Deploy
3. Set environment variables in dashboard
4. Auto-deploys on push

### Self-Hosted
1. Install Deno
2. Clone repository
3. Copy `.env.example` → `.env` and configure
4. Run: `deno task dev`
5. Use systemd/PM2 for process management

### Production Checklist
- [ ] Set strong `TOKEN_SECRET` (32+ random chars)
- [ ] Set strong `ADMIN_SECRET`
- [ ] Configure `BASE_URL` to production domain
- [ ] Set `NODE_ENV=production`
- [ ] Enable HTTPS (required for secure cookies)
- [ ] Configure email (RESEND_API_KEY)
- [ ] Set `RESEND_DRY_RUN=false`

---

## 🎨 Frontend Architecture

### Template Engine (Eta)
- Embedded JavaScript templates (like EJS)
- Compile to functions (cached)
- Supports layouts, partials, includes
- Auto-escape HTML by default

### Styling
- Custom CSS (no framework)
- RTL support via `dir="rtl"` + logical properties
- Responsive (mobile-first)
- CSS Grid + Flexbox

### JavaScript
- Minimal vanilla JS
- No build step required
- Client-side autocomplete
- Form validation
- Photo upload preview

---

## 🔄 Data Flow Examples

### Customer Books a Table
1. Customer visits `/restaurants/123` (restaurant detail)
2. Selects date/time/people, clicks "Check Availability"
3. POST `/api/restaurants/123/check` → `reservation.controller.ts:checkApi`
4. Server queries existing reservations for that date/time
5. Calculates occupancy using `services/occupancy.ts`
6. Returns available slots
7. Customer submits booking → POST `/restaurants/123/reserve`
8. Creates reservation in KV: `["reservation", newId]`
9. Generates management token
10. Sends confirmation email with `/r/{token}` link
11. Redirects to confirmation page

### Owner Views Calendar
1. Owner logs in → `/owner`
2. Clicks restaurant → `/owner/restaurants/123/calendar`
3. `owner_calendar.ts` queries:
   - Restaurant details
   - All reservations for selected date
   - Opening hours from `weeklySchedule`
4. `services/timeline.ts` generates time slots (e.g., 10:00, 10:15, 10:30...)
5. `services/occupancy.ts` calculates occupancy % per slot
6. Template renders heatmap (green=free, yellow=busy, red=full)
7. Owner can click slots to add manual blocks

---

## 🛠️ Common Development Tasks

### Add a New Route
1. Create handler in `routes/` or `routes/restaurants/`
2. Import in `server.ts`
3. Add to router: `app.use(newRouter.routes())`
4. Create template in `templates/`

### Add Database Model
1. Define interface in `database.ts`
2. Create CRUD functions (create, read, update, delete)
3. Use `kv.set()` / `kv.get()` with hierarchical keys
4. Add indexes for queries

### Change Opening Hours Logic
- Edit: `routes/owner_hours.ts` (UI)
- Edit: `database.ts:weeklySchedule` (schema)
- Edit: `services/timeline.ts` (slot generation)

### Add Email Template
1. Configure `lib/mail.ts`
2. Add HTML template string
3. Call `sendEmail(to, subject, html)`

---

## 📚 Key Concepts

### Deno vs Node.js
- No `npm install` - imports are URLs
- TypeScript native (no compilation needed)
- Secure by default (explicit permissions)
- Modern APIs (fetch, Web Crypto)

### Why Deno KV?
- Zero-config database (no PostgreSQL install)
- Perfect for prototypes & small apps
- Built-in replication (Deno Deploy)
- ACID transactions
- Hierarchical keys (like file paths)

### Middleware Chain (`server.ts:89-180`)
1. Request ID generation
2. Global error handler
3. Security headers (CSP, HSTS)
4. HTTPS enforcement (production)
5. Logger
6. Session middleware
7. User loader
8. Request logger (detailed)
9. Static files
10. Build tag header
11. Route handlers
12. 404 handler

---

This is a well-structured, production-ready restaurant reservation system with authentication, authorization, multi-role support, and a sophisticated booking engine. The codebase is clean, well-commented (Hebrew + English), and follows modern Deno best practices.
