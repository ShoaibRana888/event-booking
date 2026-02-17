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

  // Create tables
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

  // Create indexes for performance
  db.run(`CREATE INDEX IF NOT EXISTS idx_events_date ON events(date)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_events_status ON events(status)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_seat_locks_expires ON seat_locks(expires_at)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_bookings_event ON bookings(event_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_booking_seats_booking ON booking_seats(booking_id)`);

  saveDatabase();
  
  // Seed initial data if empty
  const venueCount = db.exec("SELECT COUNT(*) as count FROM venues");
  if (venueCount[0].values[0][0] === 0) {
    await seedDatabase();
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
  
  // Create venues
  const venues = [
    {
      id: uuidv4(),
      name: 'Grand Concert Hall',
      address: '123 Music Avenue',
      city: 'New York',
      capacity: 300,
      rows: 15,
      seats_per_row: 20
    },
    {
      id: uuidv4(),
      name: 'Downtown Theater',
      address: '456 Broadway St',
      city: 'Los Angeles',
      capacity: 200,
      rows: 10,
      seats_per_row: 20
    },
    {
      id: uuidv4(),
      name: 'Metro Arena',
      address: '789 Sports Way',
      city: 'Chicago',
      capacity: 500,
      rows: 20,
      seats_per_row: 25
    }
  ];

  for (const venue of venues) {
    db.run(`
      INSERT INTO venues (id, name, address, city, capacity, rows, seats_per_row)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [venue.id, venue.name, venue.address, venue.city, venue.capacity, venue.rows, venue.seats_per_row]);

    // Create seats for each venue
    const rowLabels = 'ABCDEFGHIJKLMNOPQRST'.split('');
    for (let r = 0; r < venue.rows; r++) {
      for (let s = 1; s <= venue.seats_per_row; s++) {
        const seatId = uuidv4();
        let tier = 'standard';
        if (r < 2) tier = 'vip';
        else if (r < 5) tier = 'premium';
        
        db.run(`
          INSERT INTO seats (id, venue_id, row_label, seat_number, tier)
          VALUES (?, ?, ?, ?, ?)
        `, [seatId, venue.id, rowLabels[r], s, tier]);
      }
    }
  }

  // Get venue IDs
  const venueIds = db.exec("SELECT id FROM venues");
  const venueIdList = venueIds[0].values.map(v => v[0]);

  // Create events
  const events = [
    {
      name: 'Rock Symphony Night',
      description: 'Experience the ultimate fusion of classical orchestra and rock legends. A night to remember!',
      category: 'Concert',
      daysFromNow: 7,
      base_price: 75,
      vip_price: 200,
      premium_price: 125,
      venue_idx: 0
    },
    {
      name: 'Hamilton - The Musical',
      description: 'The story of America then, told by America now. Winner of 11 Tony Awards.',
      category: 'Theater',
      daysFromNow: 14,
      base_price: 150,
      vip_price: 400,
      premium_price: 250,
      venue_idx: 1
    },
    {
      name: 'Stand-Up Comedy Festival',
      description: 'Laugh until you cry with top comedians from around the world.',
      category: 'Comedy',
      daysFromNow: 3,
      base_price: 45,
      vip_price: 100,
      premium_price: 70,
      venue_idx: 1
    },
    {
      name: 'NBA Finals Watch Party',
      description: 'Watch the big game on giant screens with fellow fans!',
      category: 'Sports',
      daysFromNow: 21,
      base_price: 25,
      vip_price: 75,
      premium_price: 45,
      venue_idx: 2
    },
    {
      name: 'Electronic Dreams Festival',
      description: 'Top DJs, incredible light shows, and an unforgettable atmosphere.',
      category: 'Concert',
      daysFromNow: 30,
      base_price: 95,
      vip_price: 300,
      premium_price: 175,
      venue_idx: 0
    },
    {
      name: 'Jazz & Blues Evening',
      description: 'Smooth jazz and soulful blues performed by Grammy winners.',
      category: 'Concert',
      daysFromNow: 10,
      base_price: 65,
      vip_price: 180,
      premium_price: 110,
      venue_idx: 0
    }
  ];

  for (const event of events) {
    const eventDate = new Date();
    eventDate.setDate(eventDate.getDate() + event.daysFromNow);
    eventDate.setHours(19, 30, 0, 0);
    
    db.run(`
      INSERT INTO events (id, venue_id, name, description, category, date, base_price, vip_price, premium_price)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      uuidv4(),
      venueIdList[event.venue_idx],
      event.name,
      event.description,
      event.category,
      eventDate.toISOString(),
      event.base_price,
      event.vip_price,
      event.premium_price
    ]);
  }

  saveDatabase();
  console.log('Database seeded successfully!');
}

function getDb() {
  return db;
}

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
    if (params.length > 0) {
      stmt.bind(params);
    }
    const results = [];
    while (stmt.step()) {
      results.push(stmt.getAsObject());
    }
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

// Clean up expired locks
function cleanExpiredLocks() {
  db.run(`DELETE FROM seat_locks WHERE expires_at < datetime('now')`);
  saveDatabase();
}

// Run cleanup every 30 seconds
setInterval(cleanExpiredLocks, 30000);

module.exports = {
  initDatabase,
  getDb,
  runQuery,
  selectQuery,
  selectOne,
  saveDatabase,
  cleanExpiredLocks
};
