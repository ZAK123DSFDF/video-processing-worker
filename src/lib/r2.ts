// src/lib/r2.ts
import { AwsClient } from "aws4fetch"

let r2ClientInstance: AwsClient | null = null

export function getR2Client(): AwsClient {
	if (!r2ClientInstance) {
		const accessKeyId = process.env.R2_ACCESS_KEY_ID
		const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY

		if (!accessKeyId || !secretAccessKey) {
			throw new Error("R2 access keys are missing from environment variables.")
		}

		r2ClientInstance = new AwsClient({
			accessKeyId,
			secretAccessKey,
			service: "s3",
			region: "auto",
		})
	}
	return r2ClientInstance
}

/**
 * Returns the base S3 API endpoint URL for your Cloudflare R2 bucket
 */
export function getR2BucketUrl(key?: string): string {
	const bucketName = process.env.R2_BUCKET_NAME
	const accountId = process.env.CLOUDFLARE_ACCOUNT_ID

	if (!bucketName || !accountId) {
		throw new Error(
			"R2_BUCKET_NAME or CLOUDFLARE_ACCOUNT_ID is missing from environment variables.",
		)
	}

	const base = `https://${accountId}.r2.cloudflarestorage.com/${bucketName}`
	if (!key) return base

	const cleanKey = key.startsWith("/") ? key.slice(1) : key
	return `${base}/${encodeURIComponent(cleanKey).replace(/%2F/g, "/")}`
}
