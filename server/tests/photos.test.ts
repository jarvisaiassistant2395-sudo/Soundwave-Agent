// ── Where a short's popup photos come from ─────────────────────────────────
// Wikimedia Commons' answer shape is the one thing here that can change without
// warning, so it is parsed by a function of its own and tested against a real
// answer (trimmed). The rest of the suite proves the two promises: only freely
// licensed pictures are used, and the people who took them are credited.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  commonsSearchUrl,
  downloadPhoto,
  isFreeLicense,
  parseCommonsPages,
  photoCredit,
  resolvePhotoPlan,
  searchPhotos,
  type Photo,
  type PhotoProvider,
} from "../src/lib/photos.js";

// A real (trimmed) generator=search answer: one CC BY-SA photo, one public
// domain photo, one fair-use logo that must never ship, and one SVG diagram.
const ANSWER = {
  batchcomplete: "",
  query: {
    pages: {
      "111": {
        index: 2,
        pageid: 111,
        title: "File:Volcano eruption.jpg",
        imageinfo: [
          {
            url: "https://upload.wikimedia.org/wikipedia/commons/9/9f/Volcano.jpg",
            descriptionurl: "https://commons.wikimedia.org/wiki/File:Volcano_eruption.jpg",
            thumburl: "https://upload.wikimedia.org/wikipedia/commons/thumb/9/9f/Volcano.jpg/1080px-Volcano.jpg",
            thumbwidth: 1080,
            thumbheight: 720,
            width: 4000,
            height: 2666,
            size: 900_000,
            mime: "image/jpeg",
            extmetadata: {
              LicenseShortName: { value: "CC BY-SA 4.0" },
              Artist: { value: '<a href="//commons.wikimedia.org/wiki/User:Taro">Taro Yamada</a>' },
            },
          },
        ],
      },
      "222": {
        index: 1,
        pageid: 222,
        title: "File:Lava lake.png",
        imageinfo: [
          {
            url: "https://upload.wikimedia.org/wikipedia/commons/1/12/Lava.png",
            descriptionurl: "https://commons.wikimedia.org/wiki/File:Lava_lake.png",
            thumburl: "https://upload.wikimedia.org/wikipedia/commons/thumb/1/12/Lava.png/1080px-Lava.png",
            thumbwidth: 1080,
            thumbheight: 1080,
            width: 2000,
            height: 2000,
            size: 4_000_000,
            mime: "image/png",
            extmetadata: { LicenseShortName: { value: "Public domain" }, Artist: { value: "USGS" } },
          },
        ],
      },
      "333": {
        index: 3,
        pageid: 333,
        title: "File:Company logo.png",
        imageinfo: [
          {
            url: "https://upload.wikimedia.org/wikipedia/en/3/3a/Logo.png",
            descriptionurl: "https://en.wikipedia.org/wiki/File:Company_logo.png",
            thumburl: "https://upload.wikimedia.org/wikipedia/en/thumb/3/3a/Logo.png/1080px-Logo.png",
            width: 800,
            height: 400,
            size: 40_000,
            mime: "image/png",
            extmetadata: { LicenseShortName: { value: "Fair use" }, Artist: { value: "The company" } },
          },
        ],
      },
      "444": {
        index: 4,
        pageid: 444,
        title: "File:Diagram.svg",
        imageinfo: [
          {
            url: "https://upload.wikimedia.org/wikipedia/commons/4/4d/Diagram.svg",
            descriptionurl: "https://commons.wikimedia.org/wiki/File:Diagram.svg",
            width: 500,
            height: 500,
            size: 5000,
            mime: "image/svg+xml",
            extmetadata: { LicenseShortName: { value: "CC0" }, Artist: { value: "Someone" } },
          },
        ],
      },
    },
  },
};

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(4096, 7),
]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(4096, 3)]);

let dir = "";

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sw-photos-"));
});

afterAll(() => {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* the temp dir is the OS's business */
  }
});

describe("reading a Commons answer", () => {
  it("keeps the free pictures, in search order, and drops what can't ship", () => {
    const photos = parseCommonsPages(ANSWER, 5);
    expect(photos.map((p) => p.title)).toEqual(["Lava lake", "Volcano eruption"]);
    expect(photos[0]).toMatchObject({ id: "222", width: 1080, height: 1080 });
    // The thumbnail (scaled) is downloaded, not the 4000px original.
    expect(photos[1]!.url).toContain("thumb");
  });

  it("names the photographer and the licence in the credit", () => {
    const photos = parseCommonsPages(ANSWER, 5);
    expect(photos[1]!.author).toBe("Taro Yamada");
    expect(photos[1]!.credit).toBe("Taro Yamada — CC BY-SA 4.0 (Wikimedia Commons)");
    expect(photos[0]!.credit).toContain("Public domain");
  });

  it("trusts no licence it doesn't recognise, and never a non-free one", () => {
    expect(isFreeLicense("CC BY-SA 4.0")).toBe(true);
    expect(isFreeLicense("Public domain")).toBe(true);
    expect(isFreeLicense("CC0 1.0")).toBe(true);
    expect(isFreeLicense("Fair use")).toBe(false);
    expect(isFreeLicense("Non-free logo")).toBe(false);
    expect(isFreeLicense("All rights reserved")).toBe(false);
    expect(isFreeLicense("")).toBe(false);
    expect(photoCredit("", "")).toContain("Unknown author");
  });

  it("survives an answer that isn't one", () => {
    expect(parseCommonsPages(null)).toEqual([]);
    expect(parseCommonsPages({ query: {} })).toEqual([]);
    expect(parseCommonsPages({ query: { pages: { 1: { title: "File:X.jpg" } } } })).toEqual([]);
  });
});

describe("the search itself", () => {
  it("asks for bitmaps in the file namespace, at a usable width, keyless", () => {
    const url = new URL(commonsSearchUrl("https://commons.wikimedia.org/w/api.php", "molten lava", 4));
    expect(url.searchParams.get("generator")).toBe("search");
    expect(url.searchParams.get("gsrsearch")).toBe("molten lava filetype:bitmap");
    expect(url.searchParams.get("gsrnamespace")).toBe("6");
    expect(url.searchParams.get("gsrlimit")).toBe("4");
    expect(url.searchParams.get("iiurlwidth")).toBe("1080");
    expect(url.toString()).not.toMatch(/apikey|api_key|token/i);
  });

  it("returns nothing — never an exception — when the library can't be reached", async () => {
    const failing = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await searchPhotos("lava", 2, { fetchImpl: failing })).toEqual([]);
    expect(await searchPhotos("   ", 2, { fetchImpl: failing })).toEqual([]);
  });

  it("caches an answer so one render doesn't ask twice", async () => {
    const cache = new Map<string, Photo[]>();
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ANSWER }) as unknown as Response);
    await searchPhotos("volcano", 3, { fetchImpl: fetchImpl as unknown as typeof fetch, cache });
    await searchPhotos("Volcano", 3, { fetchImpl: fetchImpl as unknown as typeof fetch, cache });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("downloading a photo", () => {
  it("checks the bytes are really an image before keeping them", async () => {
    const photo: Photo = {
      id: "1",
      title: "X",
      url: "https://upload.wikimedia.org/x.jpg",
      pageUrl: "",
      author: "A",
      license: "CC0",
      width: 100,
      height: 100,
      credit: "A — CC0 (Wikimedia Commons)",
    };
    const notAnImage = (async () => ({ ok: true, arrayBuffer: async () => Buffer.from("<html>nope</html>").buffer })) as unknown as typeof fetch;
    expect(await downloadPhoto(photo, { dir, fetchImpl: notAnImage, normalize: false })).toBeNull();

    const good = (async () => ({ ok: true, arrayBuffer: async () => JPEG.buffer.slice(JPEG.byteOffset, JPEG.byteOffset + JPEG.byteLength) })) as unknown as typeof fetch;
    const file = await downloadPhoto(photo, { dir, fetchImpl: good, normalize: false });
    expect(file).toBeTruthy();
    expect(fs.statSync(file!).size).toBe(JPEG.length);
  });

  it("refuses an answer that is too big to be a popup", async () => {
    const photo: Photo = {
      id: "2",
      title: "Y",
      url: "https://upload.wikimedia.org/y.png",
      pageUrl: "",
      author: "A",
      license: "CC0",
      width: 100,
      height: 100,
      credit: "A — CC0",
    };
    const huge = (async () => ({ ok: true, arrayBuffer: async () => Buffer.concat([PNG, Buffer.alloc(13_000_000)]).buffer })) as unknown as typeof fetch;
    expect(await downloadPhoto(photo, { dir, fetchImpl: huge, normalize: false })).toBeNull();
  });

  it("downloads a photo once and hands back the cached file after that", async () => {
    const photo: Photo = {
      id: "3",
      title: "Z",
      url: "https://upload.wikimedia.org/wiki/z.png",
      pageUrl: "",
      author: "A",
      license: "CC0",
      width: 100,
      height: 100,
      credit: "A — CC0",
    };
    const fetchImpl = vi.fn(async () => ({ ok: true, arrayBuffer: async () => PNG.buffer.slice(PNG.byteOffset, PNG.byteOffset + PNG.byteLength) }) as unknown as Response);
    const first = await downloadPhoto(photo, { dir, fetchImpl: fetchImpl as unknown as typeof fetch, normalize: false });
    const second = await downloadPhoto(photo, { dir, fetchImpl: fetchImpl as unknown as typeof fetch, normalize: false });
    expect(first).toBe(second);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("a plan's worth of photos", () => {
  const provider: PhotoProvider = {
    async search(query) {
      if (query === "nothing here") return [];
      return [
        {
          id: query,
          title: `${query} picture`,
          url: `https://upload.wikimedia.org/${encodeURIComponent(query)}.png`,
          pageUrl: `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(query)}.png`,
          author: "Someone",
          license: "CC BY 2.0",
          width: 1600,
          height: 900,
          credit: "Someone — CC BY 2.0 (Wikimedia Commons)",
        },
      ];
    },
  };

  it("resolves one picture per beat, never the same one twice, and credits it", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, arrayBuffer: async () => PNG.buffer.slice(PNG.byteOffset, PNG.byteOffset + PNG.byteLength) }) as unknown as Response);
    const plan = await resolvePhotoPlan({
      requests: [
        { beatIndex: 1, query: "brain scan" },
        { beatIndex: 3, query: "nothing here" },
        { beatIndex: 4, query: "clock face" },
      ],
      provider,
      dir,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      normalize: false,
    });
    expect(plan.images.map((i) => i.beatIndex)).toEqual([1, 4]);
    expect(new Set(plan.images.map((i) => i.filePath)).size).toBe(2);
    expect(plan.credits).toHaveLength(2);
    expect(plan.credits[0]).toContain("CC BY 2.0");
    expect(plan.notes.join(" ")).toContain("no photo for “nothing here”");
  });

  it("hands back a beat with no picture instead of failing the render", async () => {
    const broken: PhotoProvider = {
      async search() {
        throw new Error("the library is down");
      },
    };
    const plan = await resolvePhotoPlan({ requests: [{ beatIndex: 2, query: "lava" }], provider: broken, dir, normalize: false });
    expect(plan.images).toEqual([]);
    expect(plan.credits).toEqual([]);
    expect(plan.notes.join(" ")).toContain("no photo for “lava”");
  });
});
