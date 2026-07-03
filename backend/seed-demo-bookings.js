// Seed demo bookings + completed payments so the admin dashboard shows real
// numbers (revenue, bookings, occupancy, revenue-by-category, daily revenue).
//
//   node backend/seed-demo-bookings.js
//
// Idempotent: demo rows are tagged with the "@demo.eventix" email domain and
// wiped + regenerated on each run, so it never double-books seats.

const { initDatabase, getDb, selectQuery, selectOne, saveDatabase } = require('./database');
const { v4: uuidv4 } = require('uuid');

const DEMO_DOMAIN = '@demo.eventix';

const FIRST = ['Ayesha', 'Bilal', 'Chris', 'Dana', 'Emre', 'Fatima', 'George', 'Hina', 'Imran', 'Julia', 'Kamal', 'Lena', 'Mona', 'Noah', 'Omar', 'Priya', 'Qasim', 'Rania', 'Sara', 'Tariq', 'Usman', 'Vera', 'Wasim', 'Zoya'];
const LAST = ['Ahmed', 'Khan', 'Malik', 'Smith', 'Rossi', 'Chen', 'Patel', 'Garcia', 'Nguyen', 'Ali', 'Shah', 'Farooq', 'Iqbal', 'Butt', 'Raza'];
const METHODS = ['card', 'card', 'card', 'paypal', 'apple'];

const rand = (n) => Math.floor(Math.random() * n);
const pick = (arr) => arr[rand(arr.length)];

function priceFor(seat, event) {
  if (seat.tier === 'vip') return event.vip_price || event.base_price * 2;
  if (seat.tier === 'premium') return event.premium_price || event.base_price * 1.5;
  return event.base_price;
}

async function main() {
  await initDatabase();
  const db = getDb();

  // ── Wipe previous demo data ────────────────────────────────────────────────
  db.run(`DELETE FROM payments WHERE booking_id IN (SELECT id FROM bookings WHERE user_email LIKE '%${DEMO_DOMAIN}')`);
  db.run(`DELETE FROM booking_seats WHERE booking_id IN (SELECT id FROM bookings WHERE user_email LIKE '%${DEMO_DOMAIN}')`);
  db.run(`DELETE FROM bookings WHERE user_email LIKE '%${DEMO_DOMAIN}'`);

  const events = selectQuery(`SELECT e.*, v.id as venue_id FROM events e JOIN venues v ON e.venue_id = v.id WHERE e.status = 'active' AND e.date > datetime('now')`);
  if (events.length === 0) {
    console.log('No upcoming events found. Run refresh-events.js first.');
    process.exit(0);
  }

  let bookingCount = 0, seatCount = 0, revenue = 0;

  for (const event of events) {
    const seats = selectQuery(`SELECT * FROM seats WHERE venue_id = ?`, [event.venue_id]);
    // Shuffle and take a slice so occupancy varies (~15%–45% per event).
    const shuffled = seats.sort(() => Math.random() - 0.5);
    const fill = 0.15 + Math.random() * 0.30;
    const toBook = shuffled.slice(0, Math.floor(seats.length * fill));

    let i = 0;
    while (i < toBook.length) {
      const groupSize = Math.min(1 + rand(4), toBook.length - i); // 1–4 seats per booking
      const group = toBook.slice(i, i + groupSize);
      i += groupSize;

      const first = pick(FIRST), last = pick(LAST);
      const email = `${first.toLowerCase()}.${last.toLowerCase()}${rand(900) + 100}${DEMO_DOMAIN}`;
      const amount = group.reduce((sum, s) => sum + priceFor(s, event), 0);

      // Spread purchases across the last 21 days for the daily-revenue chart.
      const ts = new Date(Date.now() - rand(21) * 86400000 - rand(86400) * 1000).toISOString();
      const bookingId = uuidv4();

      db.run(`INSERT INTO bookings (id, event_id, user_email, user_name, user_phone, total_amount, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'confirmed', ?)`,
        [bookingId, event.id, email, `${first} ${last}`, null, amount, ts]);

      for (const s of group) {
        db.run(`INSERT INTO booking_seats (id, booking_id, seat_id, price) VALUES (?, ?, ?, ?)`,
          [uuidv4(), bookingId, s.id, priceFor(s, event)]);
        seatCount++;
      }

      db.run(`INSERT INTO payments (id, booking_id, amount, method, status, transaction_id, created_at, completed_at) VALUES (?, ?, ?, ?, 'completed', ?, ?, ?)`,
        [uuidv4(), bookingId, amount, pick(METHODS), 'TXN' + uuidv4().slice(0, 8).toUpperCase(), ts, ts]);

      bookingCount++;
      revenue += amount;
    }
    console.log(`${event.name}: booked ${toBook.length} seats`);
  }

  saveDatabase();
  console.log(`\nDone. ${bookingCount} bookings, ${seatCount} seats, $${revenue.toLocaleString()} revenue across ${events.length} events.`);
  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
