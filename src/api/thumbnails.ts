import { getBearerToken, validateJWT } from "../auth";
import { respondWithJSON } from "./json";
import { getVideo, updateVideo } from "../db/videos";
import type { ApiConfig } from "../config";
import type { BunRequest } from "bun";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";
import { mediaTypeToExt, getAssetDiskPath, getAssetURL } from "./assets";

export async function handlerUploadThumbnail(cfg: ApiConfig, req: BunRequest) {
  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);

  console.log("uploading thumbnail for video", videoId, "by user", userID);

  const video = getVideo(cfg.db, videoId);
  if (!video) {
    throw new NotFoundError("Couldn't find video");
  }
  if (video.userID !== userID) {
    throw new UserForbiddenError("You do not have access to edit this video");
  }

  const formData = await req.formData();
  const file = formData.get("thumbnail");
  if (!(file instanceof File)) {
    throw new BadRequestError("Thumbnail file missing");
  }

  const MAX_UPLOAD_SIZE = 10 << 20;
  if (file.size > MAX_UPLOAD_SIZE) {
    throw new BadRequestError("Thumbnail file size must be < 10MB");
  }

  const type = file.type;
  if (!type) {
    throw new BadRequestError("Missing Content-Type for thumbnail");
  }

  const ext = mediaTypeToExt(type);
  const filename = `${videoId}${ext}`;

  const assetDiskPath = getAssetDiskPath(cfg, filename);
  await Bun.write(assetDiskPath, file);

  const assetURL = getAssetURL(cfg, filename);
  video.thumbnailURL = assetURL;

  await updateVideo(cfg.db, video);
  return respondWithJSON(200, video);
}
