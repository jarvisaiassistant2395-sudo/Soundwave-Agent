import { Router } from "express";
import multer from "multer";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { z } from "zod";
import { requireAuth, optionalAuth } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { ApiError } from "../middleware/error.js";
import { uploadLimiter } from "../lib/security.js";
import { getStore } from "../lib/store.js";
import { PLANS } from "../lib/plans.js";
import { importYouTubeLink, YouTubeImportError } from "../lib/youtubeImport.js";
import { config } from "../config.js";

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 * 1024 },
});

type Category = "video" | "audio" | "image";

function sniff(buf: Buffer): Category | null {
  if (buf.length < 12) return null;
  const hex = (off: number, len: number) => buf.subarray(off, off + len).toString("hex");
  if (hex(4, 4) === "66747970") return "video";
  if (hex(0, 4) === "1a45dfa3") return "video";
  if (buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "AVI ") return "video";
  if (buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WAVE") return "audio";
  if (buf.toString("latin1", 0, 4) === "OggS") return "audio";
  if (hex(0, 3) === "494433" || (buf[0] === 0xff && (buf[1]! & 0xe0) === 0xe0)) return "audio";
  if (hex(0, 3) === "ffd8ff") return "image";
  if (hex(0, 8) === "89504e470d0a1a0a") return "image";
  return null;
}

function saveFile(buf: Buffer, ext: string): { key: string; dir: string } {
  const key = `${crypto.randomUUID()}${ext}`;
  const dir = path.join(config.uploadsDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, key), buf);
  return { key, dir };
}

function filePath(key: string): string {
  if (!/^[0-9a-f-]{36}\.[a-z0-9]+$/.test(key)) throw new ApiError(400, "INVALID_FILE", "Invalid file reference.");
  return path.join(config.uploadsDir, key);
}

// NO LIMITS MODE — optionalAuth, no plan checks, Enterprise unlimited
router.post("/video", optionalAuth, uploadLimiter, upload.single("file"), async (req, res, next) => {
  try {
    if (!req.file) throw new ApiError(400, "NO_FILE", "No file provided.");
    const cat = sniff(req.file.buffer);
    if (cat !== "video") throw new ApiError(400, "INVALID_FILE", "The uploaded file is not a supported video format.");
    const maxMb = 2048;
    if (req.file.size > maxMb * 1024 * 1024) {
      throw new ApiError(413, "FILE_TOO_LARGE", `Video exceeds the ${maxMb}MB limit.`);
    }
    const { key } = saveFile(req.file.buffer, ".video");
    res.status(201).json({ fileKey: key, name: req.file.originalname, size: req.file.size });
  } catch (e) {
    next(e);
  }
});

router.post("/audio", optionalAuth, uploadLimiter, upload.single("file"), async (req, res, next) => {
  try {
    if (!req.file) throw new ApiError(400, "NO_FILE", "No file provided.");
    const cat = sniff(req.file.buffer);
    if (cat !== "audio") throw new ApiError(400, "INVALID_FILE", "The uploaded file is not a supported audio format.");
    if (req.file.size > 100 * 1024 * 1024) throw new ApiError(413, "FILE_TOO_LARGE", "Audio exceeds the 100MB limit.");
    const { key } = saveFile(req.file.buffer, ".audio");
    res.status(201).json({ fileKey: key, name: req.file.originalname, size: req.file.size });
  } catch (e) {
    next(e);
  }
});

router.post("/avatar", optionalAuth, uploadLimiter, upload.single("file"), async (req, res, next) => {
  try {
    if (!req.file) throw new ApiError(400, "NO_FILE", "No file provided.");
    const cat = sniff(req.file.buffer);
    if (cat !== "image") throw new ApiError(400, "INVALID_FILE", "Avatar must be a JPG or PNG image.");
    if (req.file.size > 5 * 1024 * 1024) throw new ApiError(413, "FILE_TOO_LARGE", "Avatar must be under 5MB.");
    const { key } = saveFile(req.file.buffer, cat === "image" ? ".png" : ".img");
    if (req.user) {
      const store = await getStore();
      await store.updateUser(req.user.id, { avatarUrl: `/api/v1/user/avatar/${key}` });
    }
    res.status(201).json({ avatarUrl: `/api/v1/user/avatar/${key}` });
  } catch (e) {
    next(e);
  }
});

const youtubeSchema = z.object({
  url: z.string().min(10).max(2048),
});

router.post("/youtube", optionalAuth, uploadLimiter, validate({ body: youtubeSchema }), async (req, res, next) => {
  try {
    const { url } = req.body as z.infer<typeof youtubeSchema>;
    // NO LIMITS — ignore duration limit for local agent automation (2GB cap).
    const result = await importYouTubeLink(url).catch((e: unknown) => {
      if (!(e instanceof YouTubeImportError)) throw e;
      if (e.stage === "url") throw new ApiError(400, "INVALID_YOUTUBE_URL", e.message);
      if (e.stage === "metadata") throw new ApiError(502, "YOUTUBE_METADATA_FAILED", e.message);
      if (e.code === "YT_NOT_INSTALLED") throw new ApiError(503, "YOUTUBE_IMPORT_UNAVAILABLE", e.message);
      throw new ApiError(502, "YOUTUBE_DOWNLOAD_FAILED", e.message);
    });
    res.status(201).json({ fileKey: result.fileKey, name: result.name, size: result.size, duration: result.duration });
  } catch (e) {
    next(e);
  }
});

const VIDEO_MIME: Record<string, string> = {
  mp4: "video/mp4",
  m4v: "video/mp4",
  webm: "video/webm",
  mkv: "video/x-matroska",
  mov: "video/quicktime",
  avi: "video/x-msvideo",
  video: "video/mp4",
};

router.get("/file/:key", optionalAuth, async (req, res, next) => {
  try {
    const key = req.params.key ?? "";
    const ext = key.split(".").pop() ?? "";
    const mime = VIDEO_MIME[ext];
    if (!mime) throw new ApiError(400, "INVALID_FILE", "Not a streamable video file.");
    const p = filePath(key);
    if (!fs.existsSync(p)) throw new ApiError(404, "NOT_FOUND", "The file no longer exists. Please import it again.");
    res.setHeader("Content-Type", mime);
    res.sendFile(path.resolve(p), (err) => {
      if (err && !res.headersSent) next(err);
    });
  } catch (e) {
    next(e);
  }
});

export { filePath };
export default router;
