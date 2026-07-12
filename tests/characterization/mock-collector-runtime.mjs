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
    if (process.env.CHARACTERIZATION_SCHEDULE_MODE === "fail") {
      return response({}, { ok: false, status: 503 });
    }
    return response({
      schedule: [{ openingTime: "2026-07-01T16:00:00.000Z", closingTime: "2026-07-02T06:00:00.000Z" }]
    });
  }

  if (process.env.CHARACTERIZATION_QUEUE_MODE === "fail") {
    return response({}, { ok: false, status: 502 });
  }
  return response({ lands: [{ name: "Test Land", rides: [] }], rides: [] });
};

function response(body, options = {}) {
  return { ok: options.ok ?? true, status: options.status ?? 200, async json() { return body; } };
}
