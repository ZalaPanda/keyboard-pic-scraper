import { Readable, Writable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { load } from "cheerio";
import * as PImage from "pureimage";
import makeFetchCookie from "fetch-cookie";

const fetch = makeFetchCookie(globalThis.fetch);
const authUrl = "https://auth.rios.hu/hozzaferes/azonosit.php?redir_host=hardverapro.hu&redir_uri=%2Findex.html";
const orderUrl = "https://hardverapro.hu/muvelet/beallitasok/modosit.php?mode=uad";
const orderParams = new URLSearchParams({ order: "time", dir: "d", block: 10 }); // order: "lstup"|"time"|"price", dir: "a"|"d"
const sourceUrl = "https://hardverapro.hu/aprok/hardver/billentyuzet_eger_pad/pc/billentyuzet/index.html";
const targetUrl = process.env.UPLOAD_URL ?? `http://esp32-display.local/api/image?fit=cover`;
const pollInterval = Number(process.env.POLL_INTERVAL_MS ?? 60_000);
if (!Number.isInteger(pollInterval) || pollInterval < 1 || pollInterval > 2_147_483_647) {
  throw new Error("POLL_INTERVAL_MS must be an integer between 1 and 2147483647.");
}

const shutdown = new AbortController();
process.once("SIGTERM", () => shutdown.abort());
process.once("SIGINT", () => shutdown.abort());

const requestSignal = () => AbortSignal.any([shutdown.signal, AbortSignal.timeout(15_000)]);

const priceFont = PImage.registerFont(fileURLToPath(new URL("./slkscr.ttf", import.meta.url)), "Silkscreen").loadSync();

const decodeImage = (buffer) => {
  const signature = buffer.toString("hex", 0, 8);
  if (signature.startsWith("ffd8ff")) {
    return PImage.decodeJPEGFromStream(Readable.from([buffer]));
  }
  if (signature === "89504e470d0a1a0a") {
    return PImage.decodePNGFromStream(Readable.from([buffer]));
  }
  throw new Error("Unsupported image format: expected JPEG or PNG.");
};

const drawPrice = (image, text) => {
  const { width, height } = image;
  const fontSize = 100;
  const { commands } = priceFont.font.getPath(text, 0, 0, fontSize);
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  // Silkscreen uses straight-sided glyphs; their vertices give the visible bounds.
  for (const { type, x, y } of commands) {
    if (type === "Z") continue;
    left = Math.min(left, x);
    top = Math.min(top, y);
    right = Math.max(right, x);
    bottom = Math.max(bottom, y);
  }
  if (left === Infinity) return;
  const outlineRadius = fontSize / 20;
  const scale = Math.min(
    Math.min(width, height) / (right - left + 2 * outlineRadius),
    height / (bottom - top + 2 * outlineRadius),
  );
  const x = (width / scale - left - right) / 2;
  const y = (height / scale - top - bottom) / 2;
  const ctx = image.getContext("2d");
  ctx.save();
  ctx.scale(scale, scale);
  ctx.font = `${fontSize}px Silkscreen`;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  // PureImage's strokeText mishandles some closed Silkscreen glyph paths.
  ctx.fillStyle = "#ffffff";
  for (let direction = 0; direction < 8; direction++) {
    const angle = direction * Math.PI / 4;
    ctx.fillText(text, x + Math.cos(angle) * outlineRadius, y + Math.sin(angle) * outlineRadius);
  }
  ctx.fillStyle = "#b90000";
  ctx.fillText(text, x, y);
  ctx.restore();
};

const uploadNewImage = async () => {
  const cookies = await fetch.cookieJar.getCookies(URL.parse(orderUrl).origin);
  if (cookies.length < 2) { // required: sid + vid
    const auth = await fetch(authUrl, {
      signal: requestSignal()
    });
    if (!auth.ok) {
      await auth.body?.cancel();
      throw new Error(`Auth: HTTP ${auth.status}`);
    }
    const order = await fetch(orderUrl, {
      method: "POST",
      body: orderParams,
      signal: requestSignal()
    });
    if (!order.ok) {
      await order.body?.cancel();
      throw new Error(`Order request failed: HTTP ${order.status}`);
    }
  }
  const list = await fetch(sourceUrl, {
    headers: { "User-Agent": "Mozilla/5.0" },
    signal: requestSignal()
  });
  if (!list.ok) {
    await list.body?.cancel();
    throw new Error(`Listing request failed: HTTP ${list.status}`);
  }

  const $ = load(await list.text());
  const firstItem = $("li.media").not("li.featured").first();
  const imageUrl = firstItem.find("img").first().attr("src");
  if (!imageUrl) {
    console.error(`No image found at ${sourceUrl}`);
    return;
  }
  if (imageUrl === process.env.LAST_IMAGE_URL) return;

  const rawImageUrl = imageUrl.replace(/\/\d+$/, ""); // "...691edb2b5bb9.jpg/100" --> "...691edb2b5bb9.jpg"
  const imageResponse = await fetch(new URL(rawImageUrl, sourceUrl), {
    signal: requestSignal()
  });
  if (!imageResponse.ok) {
    await imageResponse.body?.cancel();
    throw new Error(`Image download failed: HTTP ${imageResponse.status}`);
  }
  const image = await decodeImage(Buffer.from(await imageResponse.arrayBuffer()));
  const priceText = firstItem.find("div.uad-price").first().text().toUpperCase().trim();
  drawPrice(image, priceText);

  const chunks = [];
  const output = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk);
      callback();
    },
  });
  await PImage.encodeJPEGToStream(image, output, 90);
  const imageWithCaption = Buffer.concat(chunks);
  shutdown.signal.throwIfAborted();

  const upload = await fetch(targetUrl, {
    method: "POST",
    headers: { "Content-Type": "image/jpeg" },
    body: imageWithCaption,
    signal: requestSignal()
  });
  if (!upload.ok) {
    throw new Error(`Upload failed: HTTP ${upload.status} ${await upload.text()}`);
  }
  process.env.LAST_IMAGE_URL = imageUrl;
  void upload.body?.cancel().catch((error) => console.error("Failed to close upload response:", error));
  console.log("Image uploaded successfully.");
};

while (!shutdown.signal.aborted) {
  try {
    await uploadNewImage();
  } catch (error) {
    console.error("Image check failed:", error);
  }

  try {
    await sleep(pollInterval, undefined, { signal: shutdown.signal });
  } catch (error) {
    if (!shutdown.signal.aborted) throw error;
  }
}
