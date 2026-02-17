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

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend/build')));

// Lock duration in minutes
const LOCK_DURATION_MINUTES = 10;

// ===========================================
// EVENTS API
// ===========================================

// Get all events
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
    
    if (category) {
      sql += ` AND e.category = ?`;
      params.push(category);
    }
    
    if (search) {
      sql += ` AND (e.name LIKE ? OR e.description LIKE ? OR v.city LIKE ?)`;
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    
    if (upcoming === 'true') {
      sql += ` AND e.date > datetime('now')`;
    }
    
    sql += ` ORDER BY e.date ASC`;
    
    const events = selectQuery(sql, params);
    res.json(events);
  } catch (error) {
    console.error('Error fetching events:', error);
    res.status(500).json({ error: 'Failed to fetch events' });
  }
});

// Get single event with venue details
app.get('/api/events/:id', async (req, res) => {
  try {
    const event = selectOne(`
      SELECT e.*, v.name as venue_name, v.city, v.address, 
             v.rows, v.seats_per_row, v.capacity
      FROM events e
      JOIN venues v ON e.venue_id = v.id
      WHERE e.id = ?
    `, [req.params.id]);
    
    if (!event) {
      return res.status(404).json({ error: 'Event not found' });
    }
    
    res.json(event);
  } catch (error) {
    console.error('Error fetching event:', error);
    res.status(500).json({ error: 'Failed to fetch event' });
  }
});

// Get event categories
app.get('/api/categories', async (req, res) => {
  try {
    const categories = selectQuery(`
      SELECT DISTINCT category FROM events WHERE status = 'active'
    `);
    res.json(categories.map(c => c.category));
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch categories' });
  }
});

// ===========================================
// SEATS API
// ===========================================

// Get seats for an event with availability
app.get('/api/events/:eventId/seats', async (req, res) => {
  try {
    const event = selectOne(`SELECT venue_id FROM events WHERE id = ?`, [req.params.eventId]);
    if (!event) {
      return res.status(404).json({ error: 'Event not found' });
    }

    // Clean expired locks first
    cleanExpiredLocks();

    const seats = selectQuery(`
      SELECT s.*,
             CASE 
               WHEN bs.id IS NOT NULL THEN 'booked'
               WHEN sl.id IS NOT NULL THEN 'locked'
               ELSE 'available'
             END as status,
             sl.session_id as locked_by,
             sl.expires_at as lock_expires
      FROM seats s
      LEFT JOIN booking_seats bs ON s.id = bs.seat_id 
        AND bs.booking_id IN (
          SELECT id FROM bookings 
          WHERE event_id = ? AND status = 'confirmed'
        )
      LEFT JOIN seat_locks sl ON s.id = sl.seat_id AND sl.event_id = ?
      WHERE s.venue_id = ?
      ORDER BY s.row_label, s.seat_number
    `, [req.params.eventId, req.params.eventId, event.venue_id]);

    // Group seats by row
    const seatsByRow = {};
    seats.forEach(seat => {
      if (!seatsByRow[seat.row_label]) {
        seatsByRow[seat.row_label] = [];
      }
      seatsByRow[seat.row_label].push(seat);
    });

    res.json({ seats, seatsByRow });
  } catch (error) {
    console.error('Error fetching seats:', error);
    res.status(500).json({ error: 'Failed to fetch seats' });
  }
});

// Lock seats (with race condition handling)
app.post('/api/events/:eventId/seats/lock', async (req, res) => {
  const { seatIds, sessionId } = req.body;
  const eventId = req.params.eventId;

  if (!seatIds || !Array.isArray(seatIds) || seatIds.length === 0) {
    return res.status(400).json({ error: 'No seats specified' });
  }

  if (!sessionId) {
    return res.status(400).json({ error: 'Session ID required' });
  }

  try {
    // Clean expired locks first
    cleanExpiredLocks();

    // Check if any seats are already booked or locked by others
    const placeholders = seatIds.map(() => '?').join(',');
    const unavailable = selectQuery(`
      SELECT s.id, s.row_label, s.seat_number,
             CASE 
               WHEN bs.id IS NOT NULL THEN 'booked'
               WHEN sl.id IS NOT NULL AND sl.session_id != ? THEN 'locked'
               ELSE NULL
             END as reason
      FROM seats s
      LEFT JOIN booking_seats bs ON s.id = bs.seat_id 
        AND bs.booking_id IN (
          SELECT id FROM bookings 
          WHERE event_id = ? AND status = 'confirmed'
        )
      LEFT JOIN seat_locks sl ON s.id = sl.seat_id 
        AND sl.event_id = ?
        AND sl.expires_at > datetime('now')
      WHERE s.id IN (${placeholders})
      AND (bs.id IS NOT NULL OR (sl.id IS NOT NULL AND sl.session_id != ?))
    `, [sessionId, eventId, eventId, ...seatIds, sessionId]);

    if (unavailable.length > 0) {
      return res.status(409).json({ 
        error: 'Some seats are no longer available',
        unavailable: unavailable 
      });
    }

    // Remove any existing locks for this session
    runQuery(`
      DELETE FROM seat_locks 
      WHERE event_id = ? AND session_id = ?
    `, [eventId, sessionId]);

    // Lock the seats
    const expiresAt = new Date(Date.now() + LOCK_DURATION_MINUTES * 60 * 1000).toISOString();
    
    for (const seatId of seatIds) {
      const lockId = uuidv4();
      runQuery(`
        INSERT OR REPLACE INTO seat_locks (id, event_id, seat_id, session_id, expires_at)
        VALUES (?, ?, ?, ?, ?)
      `, [lockId, eventId, seatId, sessionId, expiresAt]);
    }

    saveDatabase();
    
    res.json({ 
      success: true, 
      expiresAt,
      lockedSeats: seatIds.length 
    });
  } catch (error) {
    console.error('Error locking seats:', error);
    res.status(500).json({ error: 'Failed to lock seats' });
  }
});

// Release locks
app.post('/api/events/:eventId/seats/release', async (req, res) => {
  const { sessionId } = req.body;
  const eventId = req.params.eventId;

  try {
    runQuery(`
      DELETE FROM seat_locks 
      WHERE event_id = ? AND session_id = ?
    `, [eventId, sessionId]);
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error releasing locks:', error);
    res.status(500).json({ error: 'Failed to release locks' });
  }
});

// ===========================================
// BOOKING API
// ===========================================

// Create booking
app.post('/api/bookings', async (req, res) => {
  const { eventId, seatIds, sessionId, userEmail, userName, userPhone } = req.body;

  if (!eventId || !seatIds || !sessionId || !userEmail || !userName) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    // Verify locks belong to this session
    const placeholders = seatIds.map(() => '?').join(',');
    const locks = selectQuery(`
      SELECT seat_id FROM seat_locks 
      WHERE event_id = ? 
        AND session_id = ? 
        AND seat_id IN (${placeholders})
        AND expires_at > datetime('now')
    `, [eventId, sessionId, ...seatIds]);

    if (locks.length !== seatIds.length) {
      return res.status(409).json({ 
        error: 'Lock expired or invalid. Please select seats again.' 
      });
    }

    // Get event pricing
    const event = selectOne(`SELECT * FROM events WHERE id = ?`, [eventId]);
    if (!event) {
      return res.status(404).json({ error: 'Event not found' });
    }

    // Get seat details and calculate total
    const seats = selectQuery(`
      SELECT * FROM seats WHERE id IN (${placeholders})
    `, seatIds);

    let totalAmount = 0;
    const seatPrices = seats.map(seat => {
      let price = event.base_price;
      if (seat.tier === 'vip') price = event.vip_price || event.base_price * 2;
      if (seat.tier === 'premium') price = event.premium_price || event.base_price * 1.5;
      totalAmount += price;
      return { seatId: seat.id, price };
    });

    // Create booking
    const bookingId = uuidv4();
    runQuery(`
      INSERT INTO bookings (id, event_id, user_email, user_name, user_phone, total_amount, status)
      VALUES (?, ?, ?, ?, ?, ?, 'pending')
    `, [bookingId, eventId, userEmail, userName, userPhone || null, totalAmount]);

    // Add booking seats
    for (const sp of seatPrices) {
      runQuery(`
        INSERT INTO booking_seats (id, booking_id, seat_id, price)
        VALUES (?, ?, ?, ?)
      `, [uuidv4(), bookingId, sp.seatId, sp.price]);
    }

    // Remove locks (seats are now in pending booking)
    runQuery(`
      DELETE FROM seat_locks 
      WHERE event_id = ? AND session_id = ?
    `, [eventId, sessionId]);

    saveDatabase();

    res.json({ 
      bookingId, 
      totalAmount,
      seats: seats.length
    });
  } catch (error) {
    console.error('Error creating booking:', error);
    res.status(500).json({ error: 'Failed to create booking' });
  }
});

// Get booking details
app.get('/api/bookings/:id', async (req, res) => {
  try {
    const booking = selectOne(`
      SELECT b.*, e.name as event_name, e.date as event_date, e.category,
             v.name as venue_name, v.address, v.city
      FROM bookings b
      JOIN events e ON b.event_id = e.id
      JOIN venues v ON e.venue_id = v.id
      WHERE b.id = ?
    `, [req.params.id]);

    if (!booking) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    const seats = selectQuery(`
      SELECT s.*, bs.price
      FROM booking_seats bs
      JOIN seats s ON bs.seat_id = s.id
      WHERE bs.booking_id = ?
      ORDER BY s.row_label, s.seat_number
    `, [req.params.id]);

    const payment = selectOne(`
      SELECT * FROM payments WHERE booking_id = ? ORDER BY created_at DESC
    `, [req.params.id]);

    res.json({ ...booking, seats, payment });
  } catch (error) {
    console.error('Error fetching booking:', error);
    res.status(500).json({ error: 'Failed to fetch booking' });
  }
});

// ===========================================
// PAYMENT API
// ===========================================

// Process payment (simulation)
app.post('/api/payments', async (req, res) => {
  const { bookingId, method, cardNumber, cardExpiry, cardCvv } = req.body;

  if (!bookingId || !method) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const booking = selectOne(`SELECT * FROM bookings WHERE id = ?`, [bookingId]);
    if (!booking) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    if (booking.status === 'confirmed') {
      return res.status(400).json({ error: 'Booking already paid' });
    }

    // Simulate payment processing
    await new Promise(resolve => setTimeout(resolve, 1500));

    // Simulate occasional failures for realism (10% chance)
    if (Math.random() < 0.1) {
      return res.status(402).json({ 
        error: 'Payment declined. Please try again or use a different payment method.' 
      });
    }

    const paymentId = uuidv4();
    const transactionId = 'TXN' + Date.now().toString(36).toUpperCase();
    
    runQuery(`
      INSERT INTO payments (id, booking_id, amount, method, status, transaction_id, completed_at)
      VALUES (?, ?, ?, ?, 'completed', ?, datetime('now'))
    `, [paymentId, bookingId, booking.total_amount, method, transactionId]);

    // Generate QR code
    const qrData = JSON.stringify({
      bookingId,
      transactionId,
      timestamp: Date.now()
    });
    const qrCode = await QRCode.toDataURL(qrData, {
      width: 300,
      margin: 2,
      color: { dark: '#000000', light: '#ffffff' }
    });

    // Update booking status
    runQuery(`
      UPDATE bookings SET status = 'confirmed', qr_code = ? WHERE id = ?
    `, [qrCode, bookingId]);

    saveDatabase();

    res.json({ 
      success: true,
      paymentId,
      transactionId,
      qrCode
    });
  } catch (error) {
    console.error('Error processing payment:', error);
    res.status(500).json({ error: 'Payment processing failed' });
  }
});

// ===========================================
// ADMIN ANALYTICS API
// ===========================================

// Get dashboard stats
app.get('/api/admin/stats', async (req, res) => {
  try {
    const totalRevenue = selectOne(`
      SELECT COALESCE(SUM(amount), 0) as total 
      FROM payments WHERE status = 'completed'
    `);

    const totalBookings = selectOne(`
      SELECT COUNT(*) as total FROM bookings WHERE status = 'confirmed'
    `);

    const totalEvents = selectOne(`
      SELECT COUNT(*) as total FROM events WHERE status = 'active'
    `);

    const upcomingEvents = selectOne(`
      SELECT COUNT(*) as total FROM events 
      WHERE status = 'active' AND date > datetime('now')
    `);

    const revenueByCategory = selectQuery(`
      SELECT e.category, SUM(p.amount) as revenue, COUNT(DISTINCT b.id) as bookings
      FROM payments p
      JOIN bookings b ON p.booking_id = b.id
      JOIN events e ON b.event_id = e.id
      WHERE p.status = 'completed'
      GROUP BY e.category
    `);

    const recentBookings = selectQuery(`
      SELECT b.*, e.name as event_name, e.category
      FROM bookings b
      JOIN events e ON b.event_id = e.id
      WHERE b.status = 'confirmed'
      ORDER BY b.created_at DESC
      LIMIT 10
    `);

    const eventsSales = selectQuery(`
      SELECT e.id, e.name, e.date, e.category,
             COUNT(DISTINCT b.id) as total_bookings,
             COALESCE(SUM(p.amount), 0) as total_revenue,
             (SELECT COUNT(*) FROM seats s WHERE s.venue_id = e.venue_id) as total_seats,
             (SELECT COUNT(*) FROM booking_seats bs 
              JOIN bookings b2 ON bs.booking_id = b2.id 
              WHERE b2.event_id = e.id AND b2.status = 'confirmed') as seats_sold
      FROM events e
      LEFT JOIN bookings b ON e.id = b.event_id AND b.status = 'confirmed'
      LEFT JOIN payments p ON b.id = p.booking_id AND p.status = 'completed'
      WHERE e.status = 'active'
      GROUP BY e.id
      ORDER BY e.date ASC
    `);

    const dailyRevenue = selectQuery(`
      SELECT DATE(p.completed_at) as date, SUM(p.amount) as revenue
      FROM payments p
      WHERE p.status = 'completed'
        AND p.completed_at >= datetime('now', '-30 days')
      GROUP BY DATE(p.completed_at)
      ORDER BY date
    `);

    res.json({
      totalRevenue: totalRevenue.total,
      totalBookings: totalBookings.total,
      totalEvents: totalEvents.total,
      upcomingEvents: upcomingEvents.total,
      revenueByCategory,
      recentBookings,
      eventsSales,
      dailyRevenue
    });
  } catch (error) {
    console.error('Error fetching admin stats:', error);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// Get all bookings with filters
app.get('/api/admin/bookings', async (req, res) => {
  try {
    const { status, eventId, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;

    let sql = `
      SELECT b.*, e.name as event_name, e.date as event_date, e.category,
             v.name as venue_name,
             (SELECT COUNT(*) FROM booking_seats WHERE booking_id = b.id) as seat_count
      FROM bookings b
      JOIN events e ON b.event_id = e.id
      JOIN venues v ON e.venue_id = v.id
      WHERE 1=1
    `;
    const params = [];

    if (status) {
      sql += ` AND b.status = ?`;
      params.push(status);
    }

    if (eventId) {
      sql += ` AND b.event_id = ?`;
      params.push(eventId);
    }

    sql += ` ORDER BY b.created_at DESC LIMIT ? OFFSET ?`;
    params.push(parseInt(limit), parseInt(offset));

    const bookings = selectQuery(sql, params);
    
    const total = selectOne(`
      SELECT COUNT(*) as count FROM bookings b
      WHERE 1=1 ${status ? "AND b.status = '" + status + "'" : ""}
      ${eventId ? "AND b.event_id = '" + eventId + "'" : ""}
    `);

    res.json({ bookings, total: total.count, page: parseInt(page), limit: parseInt(limit) });
  } catch (error) {
    console.error('Error fetching bookings:', error);
    res.status(500).json({ error: 'Failed to fetch bookings' });
  }
});

// ===========================================
// VENUES API
// ===========================================

app.get('/api/venues', async (req, res) => {
  try {
    const venues = selectQuery(`SELECT * FROM venues ORDER BY name`);
    res.json(venues);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch venues' });
  }
});

// Serve React app for all other routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/build', 'index.html'));
});

// Initialize database and start server
initDatabase().then(() => {
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`API available at http://localhost:${PORT}/api`);
  });
}).catch(error => {
  console.error('Failed to initialize database:', error);
  process.exit(1);
});
