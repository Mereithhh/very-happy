import { randomKey } from "@/utils/randomKey";
import { processImage } from "./processImage";
import { s3bucket, s3client, s3host, isLocalStorage, putLocalFile, getPublicUrl, deleteStoredFile } from "./files";
import { db } from "./db";
import { inTx } from './inTx';
import { assertAccountResourceQuota, configuredResourceLimit, lockAccountResources } from '@/app/api/resourceLimits';

export async function uploadImage(userId: string, directory: string, prefix: string, url: string, src: Buffer) {

    // Check if image already exists
    const existing = await db.uploadedFile.findFirst({
        where: {
            accountId: userId,
            reuseKey: 'image-url:' + url,
        }
    });

    if (existing && existing.thumbhash && existing.width && existing.height) {
        return {
            path: existing.path,
            thumbhash: existing.thumbhash,
            width: existing.width,
            height: existing.height
        };
    }

    // Process image
    const processed = await processImage(src);
    const key = randomKey(prefix);
    let filename = `${key}.${processed.format === 'png' ? 'png' : 'jpg'}`;
    const filePath = `public/users/${userId}/${directory}/${filename}`;

    if (isLocalStorage()) {
        await putLocalFile(filePath, src);
    } else {
        await s3client.putObject(s3bucket, filePath, src);
    }

    try {
        const stored = await inTx(async (tx) => {
            await lockAccountResources(tx, userId);
            const concurrentExisting = await tx.uploadedFile.findFirst({
                where: { accountId: userId, reuseKey: 'image-url:' + url },
            });
            if (concurrentExisting?.thumbhash && concurrentExisting.width && concurrentExisting.height) {
                return concurrentExisting;
            }
            const count = await tx.uploadedFile.count({ where: { accountId: userId } });
            assertAccountResourceQuota({
                resource: 'attachment',
                current: { count, bytes: 0 },
                delta: { count: 1, bytes: 0 },
                limits: {
                    count: configuredResourceLimit('MAX_UPLOADED_FILES_PER_ACCOUNT', 2_000),
                    bytes: 0,
                },
            });
            return tx.uploadedFile.create({
                data: {
                    accountId: userId,
                    path: filePath,
                    reuseKey: 'image-url:' + url,
                    size: src.byteLength,
                    width: processed.width,
                    height: processed.height,
                    thumbhash: processed.thumbhash,
                },
            });
        });
        if (stored.path !== filePath) {
            await deleteStoredFile(filePath).catch(() => undefined);
            return {
                path: stored.path,
                thumbhash: stored.thumbhash!,
                width: stored.width!,
                height: stored.height!,
            };
        }
    } catch (error) {
        await deleteStoredFile(filePath).catch(() => undefined);
        throw error;
    }
    return {
        path: filePath,
        thumbhash: processed.thumbhash,
        width: processed.width,
        height: processed.height
    }
}

export function resolveImageUrl(path: string) {
    if (isLocalStorage()) {
        return getPublicUrl(path);
    }
    return `https://${s3host}/${s3bucket}/${path}`;
}
