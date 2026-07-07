const PARKS = {
  disneyland: {
    id: "disneyland",
    name: "Disneyland",
    queueTimesParkId: 16,
    themeParksEntityId: "7340550b-c14d-4def-80bb-acdb51d49a66",
    bounds: {
      north: 33.8152,
      south: 33.8078,
      west: -117.9232,
      east: -117.9154
    }
  },
  dca: {
    id: "dca",
    name: "Disney California Adventure",
    queueTimesParkId: 17,
    themeParksEntityId: "832fcd51-ea19-4e77-85c7-75d5843b127c",
    bounds: {
      north: 33.8102,
      south: 33.803,
      west: -117.924,
      east: -117.9162
    }
  }
};

const ATTRACTION_META = {
  "Alice in Wonderland": { lat: 33.8132, lon: -117.9184, land: "Fantasyland" },
  "Autopia": { lat: 33.8146, lon: -117.9176, land: "Tomorrowland" },
  "Big Thunder Mountain Railroad": { lat: 33.8121, lon: -117.9206, land: "Frontierland" },
  "Buzz Lightyear Astro Blasters": { lat: 33.8126, lon: -117.9175, land: "Tomorrowland" },
  "Haunted Mansion": { lat: 33.8111, lon: -117.9221, land: "New Orleans Square" },
  "Indiana Jones Adventure": { lat: 33.8118, lon: -117.9209, land: "Adventureland" },
  "it's a small world": { lat: 33.8146, lon: -117.9188, land: "Fantasyland" },
  "Matterhorn Bobsleds": { lat: 33.8134, lon: -117.9179, land: "Fantasyland" },
  "Millennium Falcon: Smugglers Run": { lat: 33.814, lon: -117.9216, land: "Star Wars: Galaxy's Edge" },
  "Mickey & Minnie's Runaway Railway": { lat: 33.815, lon: -117.9196, land: "Mickey's Toontown" },
  "Pirates of the Caribbean": { lat: 33.8113, lon: -117.9206, land: "New Orleans Square" },
  "Space Mountain": { lat: 33.8129, lon: -117.9167, land: "Tomorrowland" },
  "Star Wars: Rise of the Resistance": { lat: 33.8146, lon: -117.922, land: "Star Wars: Galaxy's Edge" },
  "Tiana's Bayou Adventure": { lat: 33.8116, lon: -117.9226, land: "Critter Country" },
  "Toy Story Midway Mania!": { lat: 33.8049, lon: -117.9213, land: "Pixar Pier" },
  "Incredicoaster": { lat: 33.8054, lon: -117.9222, land: "Pixar Pier" },
  "Radiator Springs Racers": { lat: 33.8059, lon: -117.9183, land: "Cars Land" },
  "Guardians of the Galaxy - Mission: BREAKOUT!": { lat: 33.8075, lon: -117.9176, land: "Avengers Campus" },
  "WEB SLINGERS: A Spider-Man Adventure": { lat: 33.8068, lon: -117.9174, land: "Avengers Campus" },
  "Soarin' Around the World": { lat: 33.8082, lon: -117.9189, land: "Grizzly Peak" },
  "Grizzly River Run": { lat: 33.8074, lon: -117.9201, land: "Grizzly Peak" },
  "Monsters, Inc. Mike & Sulley to the Rescue!": { lat: 33.8075, lon: -117.9169, land: "Hollywood Land" },
  "The Little Mermaid - Ariel's Undersea Adventure": { lat: 33.8058, lon: -117.9202, land: "Paradise Gardens Park" },
  "Goofy's Sky School": { lat: 33.8048, lon: -117.9194, land: "Paradise Gardens Park" }
};

const MANUAL_EVENTS = [
  {
    park: "disneyland",
    title: "Magic Happens Parade",
    type: "Parade",
    times: ["15:30", "18:30"],
    note: "示例时间，请出行前核对官方日程。"
  },
  {
    park: "disneyland",
    title: "Fireworks / Nighttime Spectacular",
    type: "Fireworks",
    times: ["21:30"],
    note: "烟花会受天气影响取消。"
  },
  {
    park: "dca",
    title: "World of Color",
    type: "Night Show",
    times: ["21:00", "22:15"],
    note: "示例时间，后续可接入 schedule 数据。"
  },
  {
    park: "dca",
    title: "Avengers Campus Character Moments",
    type: "Show",
    times: ["12:15", "14:45", "17:15"],
    note: "适合做路线规划中的固定时间约束。"
  }
];

const SAMPLE_QUEUE_TIMES = {
  disneyland: {
    lands: [
      {
        name: "Tomorrowland",
        rides: [
          { id: 1, name: "Space Mountain", is_open: true, wait_time: 65, last_updated: "2026-07-07T19:05:00.000Z" },
          { id: 2, name: "Buzz Lightyear Astro Blasters", is_open: true, wait_time: 25, last_updated: "2026-07-07T19:05:00.000Z" },
          { id: 3, name: "Autopia", is_open: false, wait_time: 0, last_updated: "2026-07-07T19:05:00.000Z" }
        ]
      },
      {
        name: "Adventureland",
        rides: [
          { id: 4, name: "Indiana Jones Adventure", is_open: true, wait_time: 55, last_updated: "2026-07-07T19:05:00.000Z" },
          { id: 5, name: "Pirates of the Caribbean", is_open: true, wait_time: 35, last_updated: "2026-07-07T19:05:00.000Z" }
        ]
      },
      {
        name: "Star Wars: Galaxy's Edge",
        rides: [
          { id: 6, name: "Star Wars: Rise of the Resistance", is_open: true, wait_time: 80, last_updated: "2026-07-07T19:05:00.000Z" },
          { id: 7, name: "Millennium Falcon: Smugglers Run", is_open: true, wait_time: 45, last_updated: "2026-07-07T19:05:00.000Z" }
        ]
      }
    ],
    rides: []
  },
  dca: {
    lands: [
      {
        name: "Cars Land",
        rides: [
          { id: 11, name: "Radiator Springs Racers", is_open: true, wait_time: 70, last_updated: "2026-07-07T19:05:00.000Z" }
        ]
      },
      {
        name: "Avengers Campus",
        rides: [
          { id: 12, name: "Guardians of the Galaxy - Mission: BREAKOUT!", is_open: true, wait_time: 50, last_updated: "2026-07-07T19:05:00.000Z" },
          { id: 13, name: "WEB SLINGERS: A Spider-Man Adventure", is_open: true, wait_time: 40, last_updated: "2026-07-07T19:05:00.000Z" }
        ]
      },
      {
        name: "Pixar Pier",
        rides: [
          { id: 14, name: "Incredicoaster", is_open: true, wait_time: 30, last_updated: "2026-07-07T19:05:00.000Z" },
          { id: 15, name: "Toy Story Midway Mania!", is_open: false, wait_time: 0, last_updated: "2026-07-07T19:05:00.000Z" }
        ]
      }
    ],
    rides: []
  }
};
