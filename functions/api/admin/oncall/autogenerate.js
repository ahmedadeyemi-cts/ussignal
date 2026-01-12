// ----------------------------
// Rotation state per department
// ----------------------------
const rotationIndex = {};
for (const dept of Object.keys(roster)) {
  rotationIndex[dept] = Number(seedIndex) || 0;
}

// ----------------------------
// Build weekly entries
// ----------------------------
const entries = [];
let cursor = nextFriday(toDate(startYMD));
const endLimit = toDate(endYMD);
let entryId = 1;

while (cursor <= endLimit) {
  const start = new Date(cursor);
  const end = endFriday(start);

  const departments = {};

  for (const [dept, users] of Object.entries(roster)) {
    if (!Array.isArray(users) || !users.length) continue;

    const idx = rotationIndex[dept] % users.length;
    const user = users[idx];

    departments[dept] = {
      name: user.name || "",
      email: user.email || "",
      phone: user.phone || ""
    };

    rotationIndex[dept]++; // ✅ advance per department
  }

  entries.push({
    id: entryId++,
    startISO: toISO(start),
    endISO: toISO(end),
    departments
  });

  cursor = addDays(cursor, 7);
}
