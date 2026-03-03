import { rm } from "fs/promises";
import { respondWithJSON } from "./json";
import { type ApiConfig } from "../config";
import type { BunRequest } from "bun";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";
import { getBearerToken, validateJWT } from "../auth";
import { getVideo, updateVideo, type Video } from "../db/videos";
import { mediaTypeToExt, getAssetDiskPath, getS3AssetURL } from "./assets";

export async function handlerUploadVideo(cfg: ApiConfig, req: BunRequest) {
  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);

  const video = getVideo(cfg.db, videoId);
  if (!video) {
    throw new NotFoundError("Couldn't find video");
  }
  if (video.userID !== userID) {
    throw new UserForbiddenError("You do not have access to edit this video");
  }

  const formData = await req.formData();
  const file = formData.get("video");
  if (!(file instanceof File)) {
    throw new BadRequestError("Video file missing");
  }

  const MAX_UPLOAD_SIZE = 1 << 30;
  if (file.size > MAX_UPLOAD_SIZE) {
    throw new BadRequestError("Video file size must be < 1GB");
  }

  const type = file.type;
  if (!type) {
    throw new BadRequestError("Missing Content-Type for Video");
  }
  if (type !== "video/mp4") {
    throw new BadRequestError("Invalid Content-Type for Video");
  }

  const ext = mediaTypeToExt(type);
  const filename = `${videoId}${ext}`;

  const assetDiskPath = getAssetDiskPath(cfg, filename);
  await Bun.write(assetDiskPath, file);
  
  const aspectRatio = await getVideoAspectRatio(assetDiskPath);
  const prefixedFileName = `${aspectRatio}/${filename}`;

  const processedVideoPath = await processVideoForFastStart(assetDiskPath);
  const processedFile = Bun.file(processedVideoPath);

  const s3file = cfg.s3Client.file(prefixedFileName, {
    bucket: cfg.s3Bucket 
  });

  s3file.write(processedFile, {
    type: type
  });

  video.videoURL = prefixedFileName;
  await updateVideo(cfg.db, video);

  await Promise.all([
    rm(assetDiskPath, { force: true }),
    rm(processedVideoPath, { force: true }),
  ]);

  const presignedVideo = await dbVideoToSignedVideo(cfg, video)
  return respondWithJSON(200, presignedVideo);
}

export async function getVideoAspectRatio(filePath: string) {
  const proc = Bun.spawn([
    "ffprobe", 
    "-v", 
    "error", 
    "-select_streams", 
    "v:0", 
    "-show_entries", 
    "stream=width,height", 
    "-of", 
    "json",
    filePath
  ],{
    stdout: "pipe",
    stderr: "pipe",
  });
  
  const stdoutText = await new Response(proc.stdout).text();
  const stderrText = await new Response(proc.stderr).text();
  
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(stderrText);
  }

  const parsed = JSON.parse(stdoutText);

  if (!parsed.streams || parsed.streams.length === 0) {
    throw new Error("Stream data not found.")
  }

  const aspectData = parsed.streams[0];

  if (!aspectData.width || !aspectData.height) {
    throw new Error("Missing stream aspect ratio parameter.")
  }

  const adjustedWidth = Math.floor(16 * (aspectData.width/9));
  const adjustedHeight = Math.floor(16 * (aspectData.height/9));

  let aspectRatio;
  if (aspectData.width === adjustedHeight) {
    aspectRatio = "landscape";
  } else if (aspectData.height === adjustedWidth) {
    aspectRatio = "portrait";
  } else {
    aspectRatio = "other";
  }

  return aspectRatio;
}

export async function processVideoForFastStart(filePath: string) {
  const outputPath = `${filePath}.processed.mp4`;
  const proc = Bun.spawn([
    "ffmpeg", 
    "-i", 
    filePath, 
    "-movflags", 
    "faststart", 
    "-map_metadata", 
    "0", 
    "-codec", 
    "copy",
    "-f",
    "mp4",
    outputPath
  ],{
    stdout: "pipe",
    stderr: "pipe",
  });

  const stderrText = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(stderrText);
  }

  return outputPath;
}

export async function generatePresignedURL(cfg: ApiConfig, key: string, expireTime: number) {
  const presignedURL = await cfg.s3Client.presign(key, {
    expiresIn: expireTime,
    type: "video/mp4"
  });

  return presignedURL;
}

export async function dbVideoToSignedVideo(cfg: ApiConfig, video: Video) {
  if (!video.videoURL) {
    throw new Error("Video URL not found.");
  }

  const presignedURL = await generatePresignedURL(cfg, video.videoURL, 3600);
  video.videoURL = presignedURL;

  return video;
}