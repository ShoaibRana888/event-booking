const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

let db = null;

const DB_PATH = path.join(__dirname, 'events.db');

async function initDatabase() {
  const SQL = await initSqlJs();
  
  // Load existing database or create new one
  if (fs.existsSync(DB_PATH)) {
    const buffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  // ── Original event tables ──────────────────────────────────────────────────

  db.run(`
    CREATE TABLE IF NOT EXISTS venues (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      address TEXT NOT NULL,
      city TEXT NOT NULL,
      capacity INTEGER NOT NULL,
      rows INTEGER NOT NULL,
      seats_per_row INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      venue_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      category TEXT NOT NULL,
      date DATETIME NOT NULL,
      image_url TEXT,
      base_price REAL NOT NULL,
      vip_price REAL,
      premium_price REAL,
      status TEXT DEFAULT 'active',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (venue_id) REFERENCES venues(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS seats (
      id TEXT PRIMARY KEY,
      venue_id TEXT NOT NULL,
      row_label TEXT NOT NULL,
      seat_number INTEGER NOT NULL,
      tier TEXT NOT NULL DEFAULT 'standard',
      FOREIGN KEY (venue_id) REFERENCES venues(id),
      UNIQUE(venue_id, row_label, seat_number)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS seat_locks (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL,
      seat_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      locked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      expires_at DATETIME NOT NULL,
      FOREIGN KEY (event_id) REFERENCES events(id),
      FOREIGN KEY (seat_id) REFERENCES seats(id),
      UNIQUE(event_id, seat_id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS bookings (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL,
      user_email TEXT NOT NULL,
      user_name TEXT NOT NULL,
      user_phone TEXT,
      total_amount REAL NOT NULL,
      status TEXT DEFAULT 'pending',
      qr_code TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (event_id) REFERENCES events(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS booking_seats (
      id TEXT PRIMARY KEY,
      booking_id TEXT NOT NULL,
      seat_id TEXT NOT NULL,
      price REAL NOT NULL,
      FOREIGN KEY (booking_id) REFERENCES bookings(id),
      FOREIGN KEY (seat_id) REFERENCES seats(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS payments (
      id TEXT PRIMARY KEY,
      booking_id TEXT NOT NULL,
      amount REAL NOT NULL,
      method TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      transaction_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME,
      FOREIGN KEY (booking_id) REFERENCES bookings(id)
    )
  `);

  // ── Salon tables ───────────────────────────────────────────────────────────

  db.run(`
    CREATE TABLE IF NOT EXISTS salons (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      tagline TEXT,
      description TEXT,
      category TEXT NOT NULL DEFAULT 'Beauty & Wellness',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS salon_outlets (
      id TEXT PRIMARY KEY,
      salon_id TEXT NOT NULL,
      name TEXT NOT NULL,
      address TEXT NOT NULL,
      city TEXT NOT NULL,
      phone TEXT,
      open_time TEXT NOT NULL DEFAULT '09:00',
      close_time TEXT NOT NULL DEFAULT '21:00',
      seat_count INTEGER NOT NULL DEFAULT 10,
      status TEXT DEFAULT 'active',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (salon_id) REFERENCES salons(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS salon_services (
      id TEXT PRIMARY KEY,
      salon_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      duration_minutes INTEGER NOT NULL DEFAULT 60,
      price REAL NOT NULL,
      category TEXT NOT NULL DEFAULT 'General',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (salon_id) REFERENCES salons(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS salon_seats (
      id TEXT PRIMARY KEY,
      outlet_id TEXT NOT NULL,
      seat_number INTEGER NOT NULL,
      label TEXT NOT NULL,
      FOREIGN KEY (outlet_id) REFERENCES salon_outlets(id),
      UNIQUE(outlet_id, seat_number)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS salon_seat_locks (
      id TEXT PRIMARY KEY,
      outlet_id TEXT NOT NULL,
      seat_id TEXT NOT NULL,
      slot_date TEXT NOT NULL,
      slot_time TEXT NOT NULL,
      session_id TEXT NOT NULL,
      locked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      expires_at DATETIME NOT NULL,
      FOREIGN KEY (outlet_id) REFERENCES salon_outlets(id),
      FOREIGN KEY (seat_id) REFERENCES salon_seats(id),
      UNIQUE(outlet_id, seat_id, slot_date, slot_time)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS salon_bookings (
      id TEXT PRIMARY KEY,
      outlet_id TEXT NOT NULL,
      service_id TEXT NOT NULL,
      seat_id TEXT NOT NULL,
      slot_date TEXT NOT NULL,
      slot_time TEXT NOT NULL,
      user_name TEXT NOT NULL,
      user_email TEXT NOT NULL,
      user_phone TEXT,
      amount REAL NOT NULL,
      status TEXT DEFAULT 'pending',
      qr_code TEXT,
      transaction_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (outlet_id) REFERENCES salon_outlets(id),
      FOREIGN KEY (service_id) REFERENCES salon_services(id),
      FOREIGN KEY (seat_id) REFERENCES salon_seats(id)
    )
  `);

  // Indexes
  db.run(`CREATE INDEX IF NOT EXISTS idx_events_date ON events(date)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_events_status ON events(status)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_seat_locks_expires ON seat_locks(expires_at)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_bookings_event ON bookings(event_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_booking_seats_booking ON booking_seats(booking_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_salon_seat_locks_expires ON salon_seat_locks(expires_at)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_salon_bookings_outlet ON salon_bookings(outlet_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_salon_bookings_slot ON salon_bookings(slot_date, slot_time)`);

  saveDatabase();
  
  // Seed if empty
  const venueCount = db.exec("SELECT COUNT(*) as count FROM venues");
  if (venueCount[0].values[0][0] === 0) {
    await seedDatabase();
  }

  const salonCount = db.exec("SELECT COUNT(*) as count FROM salons");
  if (salonCount[0].values[0][0] === 0) {
    await seedSalonDatabase();
  }

  return db;
}

function saveDatabase() {
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(DB_PATH, buffer);
}

async function seedDatabase() {
  const { v4: uuidv4 } = require('uuid');
  
  const venues = [
    { id: uuidv4(), name: 'Grand Concert Hall', address: '123 Music Avenue', city: 'New York', capacity: 300, rows: 15, seats_per_row: 20 },
    { id: uuidv4(), name: 'Downtown Theater', address: '456 Broadway St', city: 'Los Angeles', capacity: 200, rows: 10, seats_per_row: 20 },
    { id: uuidv4(), name: 'Metro Arena', address: '789 Sports Way', city: 'Chicago', capacity: 500, rows: 20, seats_per_row: 25 }
  ];

  for (const venue of venues) {
    db.run(`INSERT INTO venues (id, name, address, city, capacity, rows, seats_per_row) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [venue.id, venue.name, venue.address, venue.city, venue.capacity, venue.rows, venue.seats_per_row]);

    const rowLabels = 'ABCDEFGHIJKLMNOPQRST'.split('');
    for (let r = 0; r < venue.rows; r++) {
      for (let s = 1; s <= venue.seats_per_row; s++) {
        let tier = 'standard';
        if (r < 2) tier = 'vip';
        else if (r < 5) tier = 'premium';
        db.run(`INSERT INTO seats (id, venue_id, row_label, seat_number, tier) VALUES (?, ?, ?, ?, ?)`,
          [uuidv4(), venue.id, rowLabels[r], s, tier]);
      }
    }
  }

  const venueIds = db.exec("SELECT id FROM venues")[0].values.map(v => v[0]);

  const events = [
    { name: 'Rock Symphony Night', description: 'Experience the ultimate fusion of classical orchestra and rock legends.', category: 'Concert', daysFromNow: 7, base_price: 75, vip_price: 200, premium_price: 125, venue_idx: 0 },
    { name: 'Hamilton - The Musical', description: 'The story of America then, told by America now. Winner of 11 Tony Awards.', category: 'Theater', daysFromNow: 14, base_price: 150, vip_price: 400, premium_price: 250, venue_idx: 1 },
    { name: 'Stand-Up Comedy Festival', description: 'Laugh until you cry with top comedians from around the world.', category: 'Comedy', daysFromNow: 3, base_price: 45, vip_price: 100, premium_price: 70, venue_idx: 1 },
    { name: 'NBA Finals Watch Party', description: 'Watch the big game on giant screens with fellow fans!', category: 'Sports', daysFromNow: 21, base_price: 25, vip_price: 75, premium_price: 45, venue_idx: 2 },
    { name: 'Electronic Dreams Festival', description: 'Top DJs, incredible light shows, and an unforgettable atmosphere.', category: 'Concert', daysFromNow: 30, base_price: 95, vip_price: 300, premium_price: 175, venue_idx: 0 },
    { name: 'Jazz & Blues Evening', description: 'Smooth jazz and soulful blues performed by Grammy winners.', category: 'Concert', daysFromNow: 10, base_price: 65, vip_price: 180, premium_price: 110, venue_idx: 0 }
  ];

  for (const event of events) {
    const eventDate = new Date();
    eventDate.setDate(eventDate.getDate() + event.daysFromNow);
    eventDate.setHours(19, 30, 0, 0);
    db.run(`INSERT INTO events (id, venue_id, name, description, category, date, base_price, vip_price, premium_price) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [uuidv4(), venueIds[event.venue_idx], event.name, event.description, event.category, eventDate.toISOString(), event.base_price, event.vip_price, event.premium_price]);
  }

  saveDatabase();
  console.log('Events database seeded!');
}

async function seedSalonDatabase() {
  const { v4: uuidv4 } = require('uuid');

  // Create one salon brand with 3 outlets
  const salonId = uuidv4();
  db.run(`INSERT INTO salons (id, name, tagline, description, category) VALUES (?, ?, ?, ?, ?)`, [
    salonId,
    'Lumière Salon & Spa',
    'Where Beauty Meets Serenity',
    'A premium salon experience offering haircuts, color, skincare, and wellness treatments.',
    'Beauty & Wellness'
  ]);

  const outlets = [
    { name: 'Lumière — Gulberg', address: '45 Main Boulevard, Gulberg III', city: 'Lahore', phone: '+92-42-111-0001' },
    { name: 'Lumière — DHA', address: 'Shop 12, Phase 6 Commercial Area', city: 'Lahore', phone: '+92-42-111-0002' },
    { name: 'Lumière — Bahria Town', address: 'Civic Center, Sector C', city: 'Lahore', phone: '+92-42-111-0003' }
  ];

  const outletIds = [];
  for (const outlet of outlets) {
    const outletId = uuidv4();
    outletIds.push(outletId);
    db.run(`INSERT INTO salon_outlets (id, salon_id, name, address, city, phone, open_time, close_time, seat_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      outletId, salonId, outlet.name, outlet.address, outlet.city, outlet.phone, '09:00', '21:00', 10
    ]);

    // Create 10 seats per outlet
    const seatLabels = ['Chair 1','Chair 2','Chair 3','Chair 4','Chair 5','Chair 6','Chair 7','Chair 8','Chair 9','Chair 10'];
    for (let i = 0; i < 10; i++) {
      db.run(`INSERT INTO salon_seats (id, outlet_id, seat_number, label) VALUES (?, ?, ?, ?)`, [
        uuidv4(), outletId, i + 1, seatLabels[i]
      ]);
    }
  }

  // Services
  const services = [
    { name: 'Haircut & Style', description: 'Precision cut with blowdry and finish', duration_minutes: 60, price: 2500, category: 'Hair' },
    { name: 'Hair Color', description: 'Full color application with treatment', duration_minutes: 120, price: 6000, category: 'Hair' },
    { name: 'Highlights', description: 'Partial or full highlights with toning', duration_minutes: 150, price: 8000, category: 'Hair' },
    { name: 'Keratin Treatment', description: 'Smoothing treatment for frizz-free hair', duration_minutes: 180, price: 12000, category: 'Hair' },
    { name: 'Classic Facial', description: 'Deep cleanse, exfoliation & hydration', duration_minutes: 75, price: 3500, category: 'Skincare' },
    { name: 'Gold Facial', description: '24K gold infusion for radiant skin', duration_minutes: 90, price: 5500, category: 'Skincare' },
    { name: 'Manicure', description: 'Nail shaping, cuticle care & polish', duration_minutes: 45, price: 1500, category: 'Nails' },
    { name: 'Pedicure', description: 'Foot soak, scrub, massage & polish', duration_minutes: 60, price: 2000, category: 'Nails' },
    { name: 'Full Body Massage', description: 'Swedish or deep tissue relaxation', duration_minutes: 90, price: 7000, category: 'Wellness' },
    { name: 'Bridal Package', description: 'Complete head-to-toe bridal prep', duration_minutes: 300, price: 25000, category: 'Special' }
  ];

  for (const service of services) {
    db.run(`INSERT INTO salon_services (id, salon_id, name, description, duration_minutes, price, category) VALUES (?, ?, ?, ?, ?, ?, ?)`, [
      uuidv4(), salonId, service.name, service.description, service.duration_minutes, service.price, service.category
    ]);
  }

  saveDatabase();
  console.log('Salon database seeded!');
}

function getDb() { return db; }

function runQuery(sql, params = []) {
  try {
    db.run(sql, params);
    saveDatabase();
    return { success: true };
  } catch (error) {
    console.error('Query error:', error);
    return { success: false, error: error.message };
  }
}

function selectQuery(sql, params = []) {
  try {
    const stmt = db.prepare(sql);
    if (params.length > 0) stmt.bind(params);
    const results = [];
    while (stmt.step()) results.push(stmt.getAsObject());
    stmt.free();
    return results;
  } catch (error) {
    console.error('Select error:', error);
    return [];
  }
}

function selectOne(sql, params = []) {
  const results = selectQuery(sql, params);
  return results.length > 0 ? results[0] : null;
}

function cleanExpiredLocks() {
  db.run(`DELETE FROM seat_locks WHERE expires_at < datetime('now')`);
  db.run(`DELETE FROM salon_seat_locks WHERE expires_at < datetime('now')`);
  saveDatabase();
}

setInterval(cleanExpiredLocks, 30000);

module.exports = { initDatabase, getDb, runQuery, selectQuery, selectOne, saveDatabase, cleanExpiredLocks };