import { S3Client, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import path from "path";
import crypto from "crypto";

/**
 * Storage abstraction: S3-compatible object storage (AWS S3, Cloudflare R2,
 * MinIO, Railway) when configured, otherwise local disk (dev).
 *
 * Env: S3_ENDPOINT, S3_BUCKET, S3_REGION, S3_ACCESS_KEY, S3_SECRET_KEY,
 * S3_PUBLIC_URL (optional base URL for served files).
 */

const isS3Configured = () =>
    Boolean(process.env.S3_ENDPOINT && process.env.S3_BUCKET && process.env.S3_ACCESS_KEY && process.env.S3_SECRET_KEY);

let s3Client: S3Client | null = null;

const getS3 = () => {
    if (!s3Client) {
        s3Client = new S3Client({
            endpoint: process.env.S3_ENDPOINT,
            region: process.env.S3_REGION || "auto",
            credentials: {
                accessKeyId: process.env.S3_ACCESS_KEY!,
                secretAccessKey: process.env.S3_SECRET_KEY!,
            },
            forcePathStyle: true,
        });
    }
    return s3Client;
};

const LOCAL_UPLOAD_DIR = path.join(__dirname, "../../public/uploads");

const randomKey = (originalName: string) => {
    const ext = path.extname(originalName).toLowerCase().replace(/[^a-z0-9.]/g, "");
    return `avatars/${Date.now()}-${crypto.randomBytes(6).toString("hex")}${ext || ".jpg"}`;
};

/** Saves a buffer and returns the public URL. Falls back to local disk in dev. */
export const saveFile = async (buffer: Buffer, originalName: string, mimeType: string): Promise<string> => {
    const key = randomKey(originalName);

    if (isS3Configured()) {
        await getS3().send(
            new PutObjectCommand({
                Bucket: process.env.S3_BUCKET!,
                Key: key,
                Body: buffer,
                ContentType: mimeType,
            })
        );
        const base = (process.env.S3_PUBLIC_URL || `${process.env.S3_ENDPOINT}/${process.env.S3_BUCKET}`).replace(/\/$/, "");
        return `${base}/${key}`;
    }

    const fs = await import("fs");
    fs.mkdirSync(LOCAL_UPLOAD_DIR, { recursive: true });
    const localPath = path.join(LOCAL_UPLOAD_DIR, path.basename(key));
    fs.writeFileSync(localPath, buffer);
    return `/uploads/${path.basename(key)}`;
};

/** Deletes a stored file by URL. Local fallback removes the file; S3 removes the object. */
export const deleteFile = async (url: string) => {
    if (!url) return;
    if (isS3Configured()) {
        const base = (process.env.S3_PUBLIC_URL || `${process.env.S3_ENDPOINT}/${process.env.S3_BUCKET}`).replace(/\/$/, "");
        if (!url.startsWith(base)) return;
        const key = url.slice(base.length + 1);
        try {
            await getS3().send(new DeleteObjectCommand({ Bucket: process.env.S3_BUCKET!, Key: key }));
        } catch {
            // best-effort cleanup
        }
        return;
    }
    const fs = await import("fs");
    const match = /^\/uploads\/([^/]+)$/.exec(url);
    if (match) {
        // `path.basename` as defence in depth. `match[1]` cannot contain a
        // separator by the regex, but it *can* be `..`, which would unlink the
        // upload directory itself. Not reachable today - `User.avatar` is only
        // ever written by `saveFile`, and `UpdateProfileSchema` is `.strict()`
        // and does not accept `avatar` from the body - but this is a filesystem
        // call on a value that came from a database column.
        const name = path.basename(match[1]);
        if (!name || name.startsWith(".")) return;
        const p = path.join(LOCAL_UPLOAD_DIR, name);
        if (fs.existsSync(p)) fs.unlinkSync(p);
    }
};
