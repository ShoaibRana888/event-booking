# 🎫 EVENTIX - Advanced Event Booking System

A full-stack event booking system with seat selection, real-time concurrency control, payment simulation, and QR ticket generation.

## ✨ Features

### Customer Features
- **Browse Events** - Filter by category, search by name/venue/city
- **Interactive Seat Selection** - Visual seat map with tier-based pricing (VIP, Premium, Standard)
- **Real-time Seat Locking** - Prevents double-booking with automatic lock expiration
- **Secure Checkout** - Simulated payment processing
- **QR Tickets** - Digital tickets with scannable QR codes

### Admin Features
- **Analytics Dashboard** - Revenue tracking, booking statistics
- **Revenue by Category** - Visual breakdown of sales
- **Event Performance** - Occupancy rates, tickets sold
- **Recent Bookings** - Live feed of new bookings

## 🏗️ Technical Architecture

### Backend (Node.js + Express)
- **Database**: SQLite (sql.js) with proper schema design
- **Concurrency Control**: Row-level seat locking with automatic expiration
- **Race Condition Handling**: Transaction-safe seat reservation
- **QR Generation**: Server-side QR code creation

### Database Schema
- venues - Venue info with seating configuration
- events - Event details with tiered pricing
- seats - Individual seats with tier assignments
- seat_locks - Temporary reservations (expires after 10 min)
- bookings - Customer bookings
- booking_seats - Junction table for booking-seat relationships
- payments - Payment transaction records

## 🚀 Getting Started

```bash
cd event-booking
npm install
npm start
```

Open http://localhost:3001

## 📡 API Endpoints

### Events
- GET /api/events - List events (with filters)
- GET /api/events/:id - Get event details
- GET /api/categories - List categories

### Seats
- GET /api/events/:id/seats - Get seats with availability
- POST /api/events/:id/seats/lock - Lock seats (10 min)
- POST /api/events/:id/seats/release - Release locked seats

### Bookings
- POST /api/bookings - Create booking
- GET /api/bookings/:id - Get booking details

### Payments
- POST /api/payments - Process payment (simulated)

### Admin
- GET /api/admin/stats - Dashboard statistics

## 🔒 Concurrency Control

1. Session-based Locking - Each user gets a unique session
2. Timed Locks - Seats auto-release after 10 minutes
3. Conflict Detection - Real-time availability checking
4. Automatic Cleanup - Background job removes expired locks

## 📦 Project Structure

```
event-booking/
├── backend/
│   ├── server.js      # Express API server (18KB)
│   └── database.js    # SQLite database layer (9KB)
├── frontend/
│   └── build/
│       └── index.html # Single-file React app (no build required)
├── package.json
└── README.md
```

## 🧪 Sample Data (Auto-seeded on first run)

- 3 Venues: Grand Concert Hall (NY), Downtown Theater (LA), Metro Arena (Chicago)
- 6 Events: Rock Symphony, Hamilton, Comedy Festival, NBA Watch Party, Electronic Dreams, Jazz Evening
- Seats: VIP (front rows), Premium (middle), Standard (back)

---

Built with Node.js, Express, SQLite, and React
