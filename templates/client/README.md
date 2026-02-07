# Restaurant Floor Plan Client

React-based floor plan editor and live view for restaurant management.

## Setup

```bash
# Install dependencies
npm install

# Development (Vite dev server on port 5173)
npm run dev

# Build for production
npm run build
# Output: ../public/dist/
```

## Development Workflow

### Option 1: Two Terminal Setup (Recommended)

**Terminal 1** - Deno server (port 8000):
```bash
deno task dev
```

**Terminal 2** - Vite dev server with HMR (port 5173):
```bash
deno task dev:client
# or: cd client && npm run dev
```

Then visit: `http://localhost:8000/owner/restaurants/{id}/floor`

The template will load the dev server bundle from Vite (with hot reload).

### Option 2: Production Build

```bash
# Build client
deno task build:client

# Run server
deno task dev
```

Visit: `http://localhost:8000/owner/restaurants/{id}/floor`

## Project Structure

```
client/
├── src/
│   ├── main.tsx          # Entry point
│   ├── App.tsx           # Main app component
│   ├── index.css         # Global styles
│   └── components/
│       ├── FloorEditor.tsx    # Grid-based floor editor
│       └── FloorEditor.css
├── index.html            # HTML template
├── vite.config.ts        # Vite configuration
├── tsconfig.json         # TypeScript config
└── package.json
```

## Features

### Floor Editor
- Drag-and-drop table placement on grid
- Multiple table shapes (round, square, rectangular, booth)
- Edit table properties (name, seats)
- Save/load floor plans

### Live View (Coming Soon)
- Real-time table status
- Active orders display
- Server-sent events for updates

## API Endpoints

- `GET /api/floor-plans/:restaurantId` - Get floor plan
- `POST /api/floor-plans/:restaurantId` - Save floor plan

## Tech Stack

- **React 18** - UI framework
- **TypeScript** - Type safety
- **Vite 5** - Build tool with HMR
- **Native Drag & Drop** - No external libraries
- **CSS Grid** - Layout system
