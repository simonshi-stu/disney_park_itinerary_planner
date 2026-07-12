const RealDate = Date;
const now = process.env.CHARACTERIZATION_NOW || "2026-07-01T17:00:00.000Z";

globalThis.Date = class extends RealDate {
  constructor(...args) {
    super(...(args.length ? args : [now]));
  }

  static now() {
    return new RealDate(now).getTime();
  }
};

globalThis.fetch = async (url) => {
  if (String(url).includes("/schedule")) {
    return response({
      schedule: [{ openingTime: "2026-07-01T16:00:00.000Z", closingTime: "2026-07-02T06:00:00.000Z" }]
    });
  }

  return response({ lands: [{ name: "Test Land", rides: [] }], rides: [] });
};

function response(body) {
  return { ok: true, status: 200, async json() { return body; } };
}
