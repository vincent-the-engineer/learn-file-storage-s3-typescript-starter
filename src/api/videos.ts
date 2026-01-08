import type { BunRequest } from "bun";
import { randomBytes } from "crypto";
import { unlink } from 'node:fs/promises';
import path from "path";

import { respondWithJSON } from "./json";
import { getBearerToken, validateJWT } from "../auth";
import { type ApiConfig } from "../config";
import { getVideo, updateVideo } from "../db/videos";


interface VideoStream {
    width: number;
    height: number;
}

interface FFprobeRoot {
    streams: VideoStream[];
}

const MAX_UPLOAD_SIZE = 1 << 30;  // 1GB

export async function handlerUploadVideo(cfg: ApiConfig, req: BunRequest) {
  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const formData = await req.formData();
  const file = formData.get("video");
  if (!(file instanceof File)) {
    throw new BadRequestError("Video file missing");
  }

  if (file.size > MAX_UPLOAD_SIZE) {
    throw new BadRequestError("Video is too large");
  }

  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);

  const video = getVideo(cfg.db, videoId);
  if (!video) {
    throw new NotFoundError("Couldn't find video");
  }

  if (video.userID !== userID) {
    throw new UserForbiddenError("Forbidden");
  }

  const mediaType = file.type.toLowerCase();
  if (mediaType !== "video/mp4") {
    throw new BadRequestError("Video is not an accepted media type");
  }

  console.log("uploading video for video", videoId, "by user", userID);

  const filePath = path.join(cfg.assetsRoot, "temp_video.mp4");
  await Bun.write(filePath, file);

  const aspect = await getVideoAspectRatio(filePath);

  const fileExt = mediaType.split("/").pop();
  const key = `${aspect}/${randomBytes(32).toString("base64url")}.${fileExt}`;
  const s3file: S3File = cfg.s3Client.file(key, {
    type: mediaType
  });

  const processedFilePath = await processVideoForFastStart(filePath);
  await unlink(filePath);

  await s3file.write(Bun.file(processedFilePath));
  await unlink(processedFilePath);

  const videoURL = `https://${cfg.s3Bucket}.s3.${cfg.s3Region}.amazonaws.com/${key}`;
  video.videoURL = videoURL;

  updateVideo(cfg.db, video);

  return respondWithJSON(200, video);
}

async function getVideoAspectRatio(filePath: string) {
  const proc = Bun.spawn([
      "ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
      "stream=width,height", "-of", "json", filePath
    ], {
      stdout: "pipe",
      stderr: "pipe",
    }
  );

  const output = await new Response(proc.stdout).text();
  const error = await new Response(proc.stderr).text();
  const result = await proc.exited;
  if (result !== 0) {
    throw new Error(`ffprobe error: ${error}`);
  }

  const data = JSON.parse(output) as FFprobeRoot;
  if (!data.streams || data.streams.length === 0) {
    throw new Error("No video stream found");
  }
  const videoStream = data.streams[0];

  const landscape = (Math.abs(videoStream.width * 9 / 16 - videoStream.height) < 1);
  if (landscape) {
    return "landscape";
  }

  const portrait = (Math.abs(videoStream.width * 16 / 9 - videoStream.height) < 1);
  if (portrait) {
    return "portrait";
  }

  return "other";
}

async function processVideoForFastStart(inputFilePath: string) {
  const outputFilePath = `${inputFilePath}.processed`;
  const proc = Bun.spawn([
      "ffmpeg", "-i", inputFilePath, "-movflags", "faststart", "-map_metadata",
      "0", "-codec", "copy", "-f", "mp4", outputFilePath
    ], {
      stdout: "pipe",
      stderr: "pipe",
    }
  );

  const output = await new Response(proc.stdout).text();
  const error = await new Response(proc.stderr).text();
  const result = await proc.exited;
  if (result !== 0) {
    throw new Error(`ffmpeg error: ${error}`);
  }

  return outputFilePath;
}

