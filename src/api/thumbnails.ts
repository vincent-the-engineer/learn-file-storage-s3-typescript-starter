import path from "path";

import { getBearerToken, validateJWT } from "../auth";
import { respondWithJSON } from "./json";
import { getVideo, updateVideo } from "../db/videos";
import type { ApiConfig } from "../config";
import type { BunRequest } from "bun";
import {
  BadRequestError,
  NotFoundError,
  UserForbiddenError,
} from "./errors";


type Thumbnail = {
  data: ArrayBuffer;
  mediaType: string;
};

const MAX_UPLOAD_SIZE = 10 << 20;  // 10MB

export async function handlerUploadThumbnail(cfg: ApiConfig, req: BunRequest) {
  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const formData = await req.formData();
  const file = formData.get("thumbnail");
  if (!(file instanceof File)) {
    throw new BadRequestError("Thumbnail file missing");
  }

  if (file.size > MAX_UPLOAD_SIZE) {
    throw new BadRequestError("Thumbnail is too large");
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
  if (mediaType !== "image/jpeg" && mediaType !== "image/png") {
    throw new BadRequestError("Thumbnail is not an accepted media type");
  }

  console.log("uploading thumbnail for video", videoId, "by user", userID);

  const fileExt = mediaType.split("/").pop();
  const filename = `${videoId}.${fileExt}`;
  const filePath = path.join(cfg.assetsRoot, filename);

  await Bun.write(filePath, file);

  const thumbnailURL = `http://localhost:${cfg.port}/assets/${filename}`;
  video.thumbnailURL = thumbnailURL;

  updateVideo(cfg.db, video);

  return respondWithJSON(200, video);
}

