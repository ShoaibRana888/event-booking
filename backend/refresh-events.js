// One-time utility: refresh the event catalog with a fresh slate of upcoming
// events (the originally-seeded events are now in the past). Also creates a
// National Stadium venue so people can book stadium tickets.
//
//   node backend/refresh-events.js
//
// Safe to re-run: existing venue/upcoming events with the same name are skipped.

const { initDatabase, getDb, selectOne, saveDatabase } = require('./database');
const { v4: uuidv4 } = require('uuid');

async function main() {
  await initDatabase();
  const db = getDb();

  // ── Ensure a National Stadium venue exists (with seats) ────────────────────
  let stadium = selectOne(`SELECT * FROM venues WHERE name = ?`, ['National Stadium']);
  if (!stadium) {
    const stadiumId = uuidv4();
    const rows = 26, seatsPerRow = 30; // 780 seats across the stands
    db.run(`INSERT INTO venues (id, name, address, city, capacity, rows, seats_per_row) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [stadiumId, 'National Stadium', '1 Stadium Road', 'Karachi', rows * seatsPerRow, rows, seatsPerRow]);

    const rowLabels = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
    for (let r = 0; r < rows; r++) {
      for (let s = 1; s <= seatsPerRow; s++) {
        let tier = 'standard';        // General stands
        if (r < 2) tier = 'vip';      // VIP boxes
        else if (r < 6) tier = 'premium'; // Premium enclosure
        db.run(`INSERT INTO seats (id, venue_id, row_label, seat_number, tier) VALUES (?, ?, ?, ?, ?)`,
          [uuidv4(), stadiumId, rowLabels[r], s, tier]);
      }
    }
    stadium = selectOne(`SELECT * FROM venues WHERE id = ?`, [stadiumId]);
    console.log('Created National Stadium venue (780 seats)');
  }

  const venueByName = (name) => selectOne(`SELECT id FROM venues WHERE name = ?`, [name]);
  const grandHall = venueByName('Grand Concert Hall');
  const theater = venueByName('Downtown Theater');
  const arena = venueByName('Metro Arena');

  // ── Fresh upcoming events (incl. stadium ticket booking) ───────────────────
  const events = [
    { venue: grandHall, name: 'Rock Symphony Night', description: 'Experience the ultimate fusion of classical orchestra and rock legends.', category: 'Concert', daysFromNow: 8, base_price: 75, vip_price: 200, premium_price: 125 },
    { venue: theater, name: 'Hamilton - The Musical', description: 'The story of America then, told by America now. Winner of 11 Tony Awards.', category: 'Theater', daysFromNow: 12, base_price: 150, vip_price: 400, premium_price: 250 },
    { venue: theater, name: 'Stand-Up Comedy Festival', description: 'Laugh until you cry with top comedians from around the world.', category: 'Comedy', daysFromNow: 5, base_price: 45, vip_price: 100, premium_price: 70 },
    { venue: grandHall, name: 'Electronic Dreams Festival', description: 'Top DJs, incredible light shows, and an unforgettable atmosphere.', category: 'Festival', daysFromNow: 20, base_price: 95, vip_price: 300, premium_price: 175 },
    { venue: grandHall, name: 'Jazz & Blues Evening', description: 'Smooth jazz and soulful blues performed by Grammy winners.', category: 'Concert', daysFromNow: 15, base_price: 65, vip_price: 180, premium_price: 110 },
    { venue: arena, name: 'NBA Finals Watch Party', description: 'Watch the big game on giant screens with fellow fans!', category: 'Sports', daysFromNow: 18, base_price: 25, vip_price: 75, premium_price: 45 },
    // Stadium ticket booking event
    { venue: stadium, name: 'Champions League Final 2026', description: 'Book your seat in the stands for the biggest night in club football — live at the National Stadium.', category: 'Sports', daysFromNow: 25, base_price: 150, vip_price: 500, premium_price: 300 },
  ];

  let added = 0;
  for (const e of events) {
    if (!e.venue) { console.warn(`Skipping "${e.name}" — venue not found`); continue; }
    const exists = selectOne(`SELECT id FROM events WHERE name = ? AND date > datetime('now')`, [e.name]);
    if (exists) { console.log(`Skipping "${e.name}" — already upcoming`); continue; }

    const date = new Date();
    date.setDate(date.getDate() + e.daysFromNow);
    date.setHours(19, 30, 0, 0);
    db.run(`INSERT INTO events (id, venue_id, name, description, category, date, base_price, vip_price, premium_price) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [uuidv4(), e.venue.id, e.name, e.description, e.category, date.toISOString(), e.base_price, e.vip_price, e.premium_price]);
    added++;
    console.log(`Added "${e.name}" (${e.category})`);
  }

  saveDatabase();
  console.log(`\nDone. ${added} new upcoming event(s) added.`);
  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
