const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const QRCode = require('qrcode');
const path = require('path');
const { 
  initDatabase, 
  runQuery, 
  selectQuery, 
  selectOne, 
  saveDatabase,
  cleanExpiredLocks 
} = require('./database');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend/build')));

const LOCK_DURATION_MINUTES = 10;

// ===========================================
// EVENTS API (unchanged)
// ===========================================

app.get('/api/events', async (req, res) => {
  try {
    const { category, search, upcoming } = req.query;
    let sql = `
      SELECT e.*, v.name as venue_name, v.city, v.address,
             (SELECT COUNT(*) FROM seats s 
              WHERE s.venue_id = e.venue_id
              AND s.id NOT IN (
                SELECT bs.seat_id FROM booking_seats bs 
                JOIN bookings b ON bs.booking_id = b.id 
                WHERE b.event_id = e.id AND b.status = 'confirmed'
              )
             ) as available_seats
      FROM events e
      JOIN venues v ON e.venue_id = v.id
      WHERE e.status = 'active'
    `;
    const params = [];
    if (category) { sql += ` AND e.category = ?`; params.push(category); }
    if (search) { sql += ` AND (e.name LIKE ? OR e.description LIKE ? OR v.city LIKE ?)`; params.push(`%${search}%`, `%${search}%`, `%${search}%`); }
    if (upcoming === 'true') { sql += ` AND e.date > datetime('now')`; }
    sql += ` ORDER BY e.date ASC`;
    res.json(selectQuery(sql, params));
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch events' });
  }
});

app.get('/api/events/:id', async (req, res) => {
  try {
    const event = selectOne(`
      SELECT e.*, v.name as venue_name, v.city, v.address, v.rows, v.seats_per_row, v.capacity
      FROM events e JOIN venues v ON e.venue_id = v.id WHERE e.id = ?
    `, [req.params.id]);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    res.json(event);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch event' });
  }
});

app.get('/api/categories', async (req, res) => {
  try {
    const categories = selectQuery(`SELECT DISTINCT category FROM events WHERE status = 'active'`);
    res.json(categories.map(c => c.category));
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch categories' });
  }
});

app.get('/api/events/:eventId/seats', async (req, res) => {
  try {
    const event = selectOne(`SELECT venue_id FROM events WHERE id = ?`, [req.params.eventId]);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    cleanExpiredLocks();
    const seats = selectQuery(`
      SELECT s.*,
             CASE WHEN bs.id IS NOT NULL THEN 'booked' WHEN sl.id IS NOT NULL THEN 'locked' ELSE 'available' END as status,
             sl.session_id as locked_by, sl.expires_at as lock_expires
      FROM seats s
      LEFT JOIN booking_seats bs ON s.id = bs.seat_id AND bs.booking_id IN (SELECT id FROM bookings WHERE event_id = ? AND status = 'confirmed')
      LEFT JOIN seat_locks sl ON s.id = sl.seat_id AND sl.event_id = ?
      WHERE s.venue_id = ?
      ORDER BY s.row_label, s.seat_number
    `, [req.params.eventId, req.params.eventId, event.venue_id]);
    const seatsByRow = {};
    seats.forEach(seat => {
      if (!seatsByRow[seat.row_label]) seatsByRow[seat.row_label] = [];
      seatsByRow[seat.row_label].push(seat);
    });
    res.json({ seats, seatsByRow });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch seats' });
  }
});

app.post('/api/events/:eventId/seats/lock', async (req, res) => {
  const { seatIds, sessionId } = req.body;
  const eventId = req.params.eventId;
  if (!seatIds || !Array.isArray(seatIds) || seatIds.length === 0) return res.status(400).json({ error: 'No seats specified' });
  if (!sessionId) return res.status(400).json({ error: 'Session ID required' });
  try {
    cleanExpiredLocks();
    const placeholders = seatIds.map(() => '?').join(',');
    const unavailable = selectQuery(`
      SELECT s.id, s.row_label, s.seat_number,
             CASE WHEN bs.id IS NOT NULL THEN 'booked' WHEN sl.id IS NOT NULL AND sl.session_id != ? THEN 'locked' ELSE NULL END as reason
      FROM seats s
      LEFT JOIN booking_seats bs ON s.id = bs.seat_id AND bs.booking_id IN (SELECT id FROM bookings WHERE event_id = ? AND status = 'confirmed')
      LEFT JOIN seat_locks sl ON s.id = sl.seat_id AND sl.event_id = ? AND sl.expires_at > datetime('now')
      WHERE s.id IN (${placeholders}) AND (bs.id IS NOT NULL OR (sl.id IS NOT NULL AND sl.session_id != ?))
    `, [sessionId, eventId, eventId, ...seatIds, sessionId]);
    if (unavailable.length > 0) return res.status(409).json({ error: 'Some seats are no longer available', unavailable });
    runQuery(`DELETE FROM seat_locks WHERE event_id = ? AND session_id = ?`, [eventId, sessionId]);
    const expiresAt = new Date(Date.now() + LOCK_DURATION_MINUTES * 60 * 1000).toISOString();
    for (const seatId of seatIds) {
      runQuery(`INSERT OR REPLACE INTO seat_locks (id, event_id, seat_id, session_id, expires_at) VALUES (?, ?, ?, ?, ?)`,
        [uuidv4(), eventId, seatId, sessionId, expiresAt]);
    }
    saveDatabase();
    res.json({ success: true, expiresAt, lockedSeats: seatIds.length });
  } catch (error) {
    res.status(500).json({ error: 'Failed to lock seats' });
  }
});

app.post('/api/events/:eventId/seats/release', async (req, res) => {
  const { sessionId } = req.body;
  try {
    runQuery(`DELETE FROM seat_locks WHERE event_id = ? AND session_id = ?`, [req.params.eventId, sessionId]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to release locks' });
  }
});

app.post('/api/bookings', async (req, res) => {
  const { eventId, seatIds, sessionId, userEmail, userName, userPhone } = req.body;
  if (!eventId || !seatIds || !sessionId || !userEmail || !userName) return res.status(400).json({ error: 'Missing required fields' });
  try {
    const placeholders = seatIds.map(() => '?').join(',');
    const locks = selectQuery(`
      SELECT seat_id FROM seat_locks WHERE event_id = ? AND session_id = ? AND seat_id IN (${placeholders}) AND expires_at > datetime('now')
    `, [eventId, sessionId, ...seatIds]);
    if (locks.length !== seatIds.length) return res.status(409).json({ error: 'Lock expired or invalid. Please select seats again.' });
    const event = selectOne(`SELECT * FROM events WHERE id = ?`, [eventId]);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    const seats = selectQuery(`SELECT * FROM seats WHERE id IN (${placeholders})`, seatIds);
    let totalAmount = 0;
    const seatPrices = seats.map(seat => {
      let price = event.base_price;
      if (seat.tier === 'vip') price = event.vip_price || event.base_price * 2;
      if (seat.tier === 'premium') price = event.premium_price || event.base_price * 1.5;
      totalAmount += price;
      return { seatId: seat.id, price };
    });
    const bookingId = uuidv4();
    runQuery(`INSERT INTO bookings (id, event_id, user_email, user_name, user_phone, total_amount, status) VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
      [bookingId, eventId, userEmail, userName, userPhone || null, totalAmount]);
    for (const sp of seatPrices) {
      runQuery(`INSERT INTO booking_seats (id, booking_id, seat_id, price) VALUES (?, ?, ?, ?)`, [uuidv4(), bookingId, sp.seatId, sp.price]);
    }
    runQuery(`DELETE FROM seat_locks WHERE event_id = ? AND session_id = ?`, [eventId, sessionId]);
    saveDatabase();
    res.json({ bookingId, totalAmount, seats: seats.length });
  } catch (error) {
    res.status(500).json({ error: 'Failed to create booking' });
  }
});

app.get('/api/bookings/:id', async (req, res) => {
  try {
    const booking = selectOne(`
      SELECT b.*, e.name as event_name, e.date as event_date, e.category, v.name as venue_name, v.address, v.city
      FROM bookings b JOIN events e ON b.event_id = e.id JOIN venues v ON e.venue_id = v.id WHERE b.id = ?
    `, [req.params.id]);
    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    const seats = selectQuery(`SELECT s.*, bs.price FROM booking_seats bs JOIN seats s ON bs.seat_id = s.id WHERE bs.booking_id = ? ORDER BY s.row_label, s.seat_number`, [req.params.id]);
    const payment = selectOne(`SELECT * FROM payments WHERE booking_id = ? ORDER BY created_at DESC`, [req.params.id]);
    res.json({ ...booking, seats, payment });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch booking' });
  }
});

app.post('/api/payments', async (req, res) => {
  const { bookingId, method } = req.body;
  if (!bookingId || !method) return res.status(400).json({ error: 'Missing required fields' });
  try {
    const booking = selectOne(`SELECT * FROM bookings WHERE id = ?`, [bookingId]);
    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    if (booking.status === 'confirmed') return res.status(400).json({ error: 'Booking already paid' });
    await new Promise(resolve => setTimeout(resolve, 1500));
    if (Math.random() < 0.1) return res.status(402).json({ error: 'Payment declined. Please try again.' });
    const paymentId = uuidv4();
    const transactionId = 'TXN' + Date.now().toString(36).toUpperCase();
    runQuery(`INSERT INTO payments (id, booking_id, amount, method, status, transaction_id, completed_at) VALUES (?, ?, ?, ?, 'completed', ?, datetime('now'))`,
      [paymentId, bookingId, booking.total_amount, method, transactionId]);
    const qrCode = await QRCode.toDataURL(JSON.stringify({ bookingId, transactionId, timestamp: Date.now() }), { width: 300, margin: 2 });
    runQuery(`UPDATE bookings SET status = 'confirmed', qr_code = ? WHERE id = ?`, [qrCode, bookingId]);
    saveDatabase();
    res.json({ success: true, paymentId, transactionId, qrCode });
  } catch (error) {
    res.status(500).json({ error: 'Payment processing failed' });
  }
});

app.get('/api/admin/stats', async (req, res) => {
  try {
    const totalRevenue = selectOne(`SELECT COALESCE(SUM(amount), 0) as total FROM payments WHERE status = 'completed'`);
    const totalBookings = selectOne(`SELECT COUNT(*) as total FROM bookings WHERE status = 'confirmed'`);
    const totalEvents = selectOne(`SELECT COUNT(*) as total FROM events WHERE status = 'active'`);
    const upcomingEvents = selectOne(`SELECT COUNT(*) as total FROM events WHERE status = 'active' AND date > datetime('now')`);
    const revenueByCategory = selectQuery(`SELECT e.category, SUM(p.amount) as revenue, COUNT(DISTINCT b.id) as bookings FROM payments p JOIN bookings b ON p.booking_id = b.id JOIN events e ON b.event_id = e.id WHERE p.status = 'completed' GROUP BY e.category`);
    const recentBookings = selectQuery(`SELECT b.*, e.name as event_name, e.category FROM bookings b JOIN events e ON b.event_id = e.id WHERE b.status = 'confirmed' ORDER BY b.created_at DESC LIMIT 10`);
    const eventsSales = selectQuery(`SELECT e.id, e.name, e.date, e.category, COUNT(DISTINCT b.id) as total_bookings, COALESCE(SUM(p.amount), 0) as total_revenue, (SELECT COUNT(*) FROM seats s WHERE s.venue_id = e.venue_id) as total_seats, (SELECT COUNT(*) FROM booking_seats bs JOIN bookings b2 ON bs.booking_id = b2.id WHERE b2.event_id = e.id AND b2.status = 'confirmed') as seats_sold FROM events e LEFT JOIN bookings b ON e.id = b.event_id AND b.status = 'confirmed' LEFT JOIN payments p ON b.id = p.booking_id AND p.status = 'completed' WHERE e.status = 'active' GROUP BY e.id ORDER BY e.date ASC`);
    const dailyRevenue = selectQuery(`SELECT DATE(p.completed_at) as date, SUM(p.amount) as revenue FROM payments p WHERE p.status = 'completed' AND p.completed_at >= datetime('now', '-30 days') GROUP BY DATE(p.completed_at) ORDER BY date`);
    res.json({ totalRevenue: totalRevenue.total, totalBookings: totalBookings.total, totalEvents: totalEvents.total, upcomingEvents: upcomingEvents.total, revenueByCategory, recentBookings, eventsSales, dailyRevenue });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

app.get('/api/admin/bookings', async (req, res) => {
  try {
    const { status, eventId, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;
    let sql = `SELECT b.*, e.name as event_name, e.date as event_date, e.category, v.name as venue_name, (SELECT COUNT(*) FROM booking_seats WHERE booking_id = b.id) as seat_count FROM bookings b JOIN events e ON b.event_id = e.id JOIN venues v ON e.venue_id = v.id WHERE 1=1`;
    const params = [];
    if (status) { sql += ` AND b.status = ?`; params.push(status); }
    if (eventId) { sql += ` AND b.event_id = ?`; params.push(eventId); }
    sql += ` ORDER BY b.created_at DESC LIMIT ? OFFSET ?`;
    params.push(parseInt(limit), parseInt(offset));
    const bookings = selectQuery(sql, params);
    const total = selectOne(`SELECT COUNT(*) as count FROM bookings b WHERE 1=1 ${status ? "AND b.status = '" + status + "'" : ""} ${eventId ? "AND b.event_id = '" + eventId + "'" : ""}`);
    res.json({ bookings, total: total.count, page: parseInt(page), limit: parseInt(limit) });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch bookings' });
  }
});

app.get('/api/venues', async (req, res) => {
  try {
    res.json(selectQuery(`SELECT * FROM venues ORDER BY name`));
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch venues' });
  }
});

// ===========================================
// SALON API
// ===========================================

// Get all salons (with outlet count)
app.get('/api/salons', async (req, res) => {
  try {
    const salons = selectQuery(`
      SELECT s.*, COUNT(so.id) as outlet_count
      FROM salons s
      LEFT JOIN salon_outlets so ON s.id = so.salon_id AND so.status = 'active'
      GROUP BY s.id
    `);
    res.json(salons);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch salons' });
  }
});

// Get single salon with outlets and services
app.get('/api/salons/:id', async (req, res) => {
  try {
    const salon = selectOne(`SELECT * FROM salons WHERE id = ?`, [req.params.id]);
    if (!salon) return res.status(404).json({ error: 'Salon not found' });
    const outlets = selectQuery(`SELECT * FROM salon_outlets WHERE salon_id = ? AND status = 'active' ORDER BY name`, [req.params.id]);
    const services = selectQuery(`SELECT * FROM salon_services WHERE salon_id = ? ORDER BY category, price`, [req.params.id]);
    res.json({ ...salon, outlets, services });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch salon' });
  }
});

// Get outlet details with seats
app.get('/api/salons/outlets/:outletId', async (req, res) => {
  try {
    const outlet = selectOne(`
      SELECT so.*, s.name as salon_name, s.tagline
      FROM salon_outlets so JOIN salons s ON so.salon_id = s.id
      WHERE so.id = ?
    `, [req.params.outletId]);
    if (!outlet) return res.status(404).json({ error: 'Outlet not found' });
    const seats = selectQuery(`SELECT * FROM salon_seats WHERE outlet_id = ? ORDER BY seat_number`, [req.params.outletId]);
    const services = selectQuery(`SELECT * FROM salon_services WHERE salon_id = (SELECT salon_id FROM salon_outlets WHERE id = ?) ORDER BY category, price`, [req.params.outletId]);
    res.json({ ...outlet, seats, services });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch outlet' });
  }
});

// Get seat availability for a specific outlet + date + time slot
app.get('/api/salons/outlets/:outletId/availability', async (req, res) => {
  try {
    const { date, time } = req.query;
    if (!date || !time) return res.status(400).json({ error: 'date and time required' });

    cleanExpiredLocks();

    const seats = selectQuery(`
      SELECT ss.*,
             CASE
               WHEN sb.id IS NOT NULL THEN 'booked'
               WHEN sl.id IS NOT NULL THEN 'locked'
               ELSE 'available'
             END as status,
             sl.session_id as locked_by
      FROM salon_seats ss
      LEFT JOIN salon_bookings sb ON ss.id = sb.seat_id 
        AND sb.outlet_id = ? AND sb.slot_date = ? AND sb.slot_time = ? AND sb.status = 'confirmed'
      LEFT JOIN salon_seat_locks sl ON ss.id = sl.seat_id
        AND sl.outlet_id = ? AND sl.slot_date = ? AND sl.slot_time = ?
      WHERE ss.outlet_id = ?
      ORDER BY ss.seat_number
    `, [req.params.outletId, date, time, req.params.outletId, date, time, req.params.outletId]);

    res.json({ seats, date, time });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch availability' });
  }
});

// Lock a salon seat for a slot
app.post('/api/salons/outlets/:outletId/lock', async (req, res) => {
  const { seatId, date, time, sessionId } = req.body;
  const outletId = req.params.outletId;
  if (!seatId || !date || !time || !sessionId) return res.status(400).json({ error: 'Missing required fields' });

  try {
    cleanExpiredLocks();

    // Check if seat is already booked/locked by someone else
    const conflict = selectOne(`
      SELECT 'booked' as reason FROM salon_bookings 
      WHERE outlet_id = ? AND seat_id = ? AND slot_date = ? AND slot_time = ? AND status = 'confirmed'
      UNION ALL
      SELECT 'locked' as reason FROM salon_seat_locks
      WHERE outlet_id = ? AND seat_id = ? AND slot_date = ? AND slot_time = ? AND session_id != ? AND expires_at > datetime('now')
    `, [outletId, seatId, date, time, outletId, seatId, date, time, sessionId]);

    if (conflict) return res.status(409).json({ error: `Seat is ${conflict.reason}. Please choose another.` });

    // Remove any existing lock for this session + slot
    runQuery(`DELETE FROM salon_seat_locks WHERE outlet_id = ? AND session_id = ? AND slot_date = ? AND slot_time = ?`,
      [outletId, sessionId, date, time]);

    const expiresAt = new Date(Date.now() + LOCK_DURATION_MINUTES * 60 * 1000).toISOString();
    runQuery(`INSERT OR REPLACE INTO salon_seat_locks (id, outlet_id, seat_id, slot_date, slot_time, session_id, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [uuidv4(), outletId, seatId, date, time, sessionId, expiresAt]);

    saveDatabase();
    res.json({ success: true, expiresAt });
  } catch (error) {
    res.status(500).json({ error: 'Failed to lock seat' });
  }
});

// Release salon seat lock
app.post('/api/salons/outlets/:outletId/release', async (req, res) => {
  const { sessionId, date, time } = req.body;
  try {
    runQuery(`DELETE FROM salon_seat_locks WHERE outlet_id = ? AND session_id = ? AND slot_date = ? AND slot_time = ?`,
      [req.params.outletId, sessionId, date, time]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to release lock' });
  }
});

// Create salon booking
app.post('/api/salons/bookings', async (req, res) => {
  const { outletId, serviceId, seatId, date, time, sessionId, userName, userEmail, userPhone } = req.body;
  if (!outletId || !serviceId || !seatId || !date || !time || !sessionId || !userName || !userEmail) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    // Verify lock
    const lock = selectOne(`
      SELECT * FROM salon_seat_locks 
      WHERE outlet_id = ? AND seat_id = ? AND slot_date = ? AND slot_time = ? AND session_id = ? AND expires_at > datetime('now')
    `, [outletId, seatId, date, time, sessionId]);

    if (!lock) return res.status(409).json({ error: 'Seat lock expired. Please select again.' });

    // Get service price
    const service = selectOne(`SELECT * FROM salon_services WHERE id = ?`, [serviceId]);
    if (!service) return res.status(404).json({ error: 'Service not found' });

    const bookingId = uuidv4();
    runQuery(`
      INSERT INTO salon_bookings (id, outlet_id, service_id, seat_id, slot_date, slot_time, user_name, user_email, user_phone, amount, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
    `, [bookingId, outletId, serviceId, seatId, date, time, userName, userEmail, userPhone || null, service.price]);

    // Release lock
    runQuery(`DELETE FROM salon_seat_locks WHERE outlet_id = ? AND session_id = ? AND slot_date = ? AND slot_time = ?`,
      [outletId, sessionId, date, time]);

    saveDatabase();
    res.json({ bookingId, amount: service.price });
  } catch (error) {
    res.status(500).json({ error: 'Failed to create booking' });
  }
});

// Get salon booking details
app.get('/api/salons/bookings/:id', async (req, res) => {
  try {
    const booking = selectOne(`
      SELECT sb.*, 
             so.name as outlet_name, so.address, so.city, so.phone as outlet_phone,
             s.name as salon_name,
             sv.name as service_name, sv.description as service_description, sv.duration_minutes,
             ss.label as seat_label, ss.seat_number
      FROM salon_bookings sb
      JOIN salon_outlets so ON sb.outlet_id = so.id
      JOIN salons s ON so.salon_id = s.id
      JOIN salon_services sv ON sb.service_id = sv.id
      JOIN salon_seats ss ON sb.seat_id = ss.id
      WHERE sb.id = ?
    `, [req.params.id]);
    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    res.json(booking);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch booking' });
  }
});

// Process salon payment
app.post('/api/salons/payments', async (req, res) => {
  const { bookingId, method } = req.body;
  if (!bookingId || !method) return res.status(400).json({ error: 'Missing required fields' });

  try {
    const booking = selectOne(`SELECT * FROM salon_bookings WHERE id = ?`, [bookingId]);
    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    if (booking.status === 'confirmed') return res.status(400).json({ error: 'Already paid' });

    await new Promise(resolve => setTimeout(resolve, 1500));
    if (Math.random() < 0.1) return res.status(402).json({ error: 'Payment declined. Please try again.' });

    const transactionId = 'SAL' + Date.now().toString(36).toUpperCase();
    const qrData = JSON.stringify({ bookingId, transactionId, type: 'salon', timestamp: Date.now() });
    const qrCode = await QRCode.toDataURL(qrData, { width: 300, margin: 2 });

    runQuery(`UPDATE salon_bookings SET status = 'confirmed', qr_code = ?, transaction_id = ? WHERE id = ?`,
      [qrCode, transactionId, bookingId]);

    saveDatabase();
    res.json({ success: true, transactionId, qrCode });
  } catch (error) {
    res.status(500).json({ error: 'Payment failed' });
  }
});

// Get available time slots for outlet on a date
app.get('/api/salons/outlets/:outletId/slots', async (req, res) => {
  try {
    const { date } = req.query;
    if (!date) return res.status(400).json({ error: 'date required' });

    const outlet = selectOne(`SELECT * FROM salon_outlets WHERE id = ?`, [req.params.outletId]);
    if (!outlet) return res.status(404).json({ error: 'Outlet not found' });

    // Generate hourly slots from open_time to close_time
    const slots = [];
    const [openH] = outlet.open_time.split(':').map(Number);
    const [closeH] = outlet.close_time.split(':').map(Number);

    cleanExpiredLocks();

    for (let h = openH; h < closeH; h++) {
      const time = `${h.toString().padStart(2, '0')}:00`;
      const bookedCount = selectOne(`
        SELECT COUNT(*) as count FROM salon_bookings 
        WHERE outlet_id = ? AND slot_date = ? AND slot_time = ? AND status = 'confirmed'
      `, [req.params.outletId, date, time]);
      const lockedCount = selectOne(`
        SELECT COUNT(*) as count FROM salon_seat_locks
        WHERE outlet_id = ? AND slot_date = ? AND slot_time = ? AND expires_at > datetime('now')
      `, [req.params.outletId, date, time]);
      const available = outlet.seat_count - bookedCount.count - lockedCount.count;
      slots.push({ time, available: Math.max(0, available), total: outlet.seat_count });
    }

    res.json({ slots, date });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch slots' });
  }
});

// Serve React app
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/build', 'index.html'));
});

initDatabase().then(() => {
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`API available at http://localhost:${PORT}/api`);
  });
}).catch(error => {
  console.error('Failed to initialize database:', error);
  process.exit(1);
});