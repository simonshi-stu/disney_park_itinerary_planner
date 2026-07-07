import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const cacheDir = path.join(rootDir, "src", "cache", "themeparks");

const parks = {
  disneyland: {
    name: "Disneyland",
    entityId: "7340550b-c14d-4def-80bb-acdb51d49a66"
  },
  dca: {
    name: "Disney California Adventure",
    entityId: "832fcd51-ea19-4e77-85c7-75d5843b127c"
  }
};

const endpoints = ["children", "live", "schedule"];

await mkdir(cacheDir, { recursive: true });

const manifest = {
  generatedAt: new Date().toISOString(),
  source: "https://api.themeparks.wiki/v1",
  files: []
};

for (const [parkId, park] of Object.entries(parks)) {
  for (const endpoint of endpoints) {
    const url = `https://api.themeparks.wiki/v1/entity/${park.entityId}/${endpoint}`;
    const response = await fetch(url, { cache: "no-store" });

    if (!response.ok) {
      throw new Error(`${url} returned ${response.status}`);
    }

    const data = await response.json();
    const fileName = `${parkId}.${endpoint}.json`;
    const filePath = path.join(cacheDir, fileName);

    await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    manifest.files.push({
      park: park.name,
      endpoint,
      url,
      file: `src/cache/themeparks/${fileName}`
    });
  }
}

await writeFile(path.join(cacheDir, "cache-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(`ThemeParks.wiki cache updated in ${cacheDir}`);
