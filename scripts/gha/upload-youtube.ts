import { open, readFile, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { eq } from "drizzle-orm"
import { db, client } from "./db"
import { videoJobs } from "#/db/course-schema"

const jobId = process.env.JOB_ID!
const title = process.env.YT_TITLE || "Merged Course Video"
const description = process.env.YT_DESCRIPTION || ""

const CHUNK_SIZE = 8 * 1024 * 1024
const MAX_CHUNK_ATTEMPTS = 4

async function updateProgress(progress: number, step: string) {
	try {
		await db
			.update(videoJobs)
			.set({ progress, currentStep: step })
			.where(eq(videoJobs.id, jobId))
	} catch (err) {
		console.warn(`[DB Progress Update Warning]: ${err}`)
	}
}

async function getAccessToken(){
	const res = await fetch("https://oauth2.googleapis.com/token", {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: process.env.YOUTUBE_CLIENT_ID!,
			client_secret: process.env.YOUTUBE_CLIENT_SECRET!,
			refresh_token: process.env.YOUTUBE_REFRESH_TOKEN!,
			grant_type: "refresh_token",
		}),
	})
	if (!res.ok) throw new Error(`Token refresh failed: ${await res.text()}`)
	const data = (await res.json()) as { access_token: string }
	return data.access_token
}

function offsetFromRange(res: Response): number {
	const range = res.headers.get("Range")
	const match = range?.match(/bytes=0-(\d+)/)
	return match ? Number.parseInt(match[1], 10) + 1 : 0
}

async function queryUploadedBytes(
	uploadUrl: string,
	fileSize: number,
): Promise<{ offset: number; videoId?: string }> {
	const res = await fetch(uploadUrl, {
		method: "PUT",
		headers: {
			"Content-Length": "0",
			"Content-Range": `bytes */${fileSize}`,
		},
	})
	if (res.status === 200 || res.status === 201) {
		const data = (await res.json()) as { id: string }
		return { offset: fileSize, videoId: data.id }
	}
	if (res.status === 308) return { offset: offsetFromRange(res) }
	throw new Error(`Could not query upload status: HTTP ${res.status}`)
}

async function main() {
	const finalPath = (
		await readFile(join(tmpdir(), `merge-${jobId}-final-path.txt`), "utf-8")
	).trim()

	const fileSize = (await stat(finalPath)).size
	const accessToken = await getAccessToken()

	console.log(`Initiating YouTube resumable upload for ${fileSize} bytes...`)

	// Step 1: Initiate resumable session
	const initRes = await fetch(
		"https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status",
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${accessToken}`,
				"Content-Type": "application/json",
				"X-Upload-Content-Type": "video/mp4",
				"X-Upload-Content-Length": String(fileSize),
			},
			body: JSON.stringify({
				snippet: {
					title,
					description,
					categoryId: "27" // Education
				},
				status: {
					privacyStatus: "private",
					selfDeclaredMadeForKids: false
				},
			}),
		},
	)

	if (!initRes.ok) {
		throw new Error(`Failed to initiate YouTube upload: ${await initRes.text()}`)
	}

	const uploadUrl = initRes.headers.get("Location")
	if (!uploadUrl) throw new Error("No resumable upload URL returned by YouTube")

	// Step 2: Stream chunk by chunk
	const fh = await open(finalPath, "r")
	let uploadedBytes = 0
	let videoId: string | null = null

	try {
		while (uploadedBytes < fileSize && !videoId) {
			const end = Math.min(uploadedBytes + CHUNK_SIZE, fileSize)
			const len = end - uploadedBytes
			const chunk = Buffer.alloc(len)

			const { bytesRead } = await fh.read(chunk, 0, len, uploadedBytes)
			const payloadChunk = bytesRead < len ? chunk.subarray(0, bytesRead) : chunk

			let sent = false
			for (let attempt = 1; attempt <= MAX_CHUNK_ATTEMPTS && !sent; attempt++) {
				try {
					const res = await fetch(uploadUrl, {
						method: "PUT",
						headers: {
							"Content-Length": String(payloadChunk.length),
							"Content-Range": `bytes \({uploadedBytes}-\){uploadedBytes + payloadChunk.length - 1}/${fileSize}`,
						},
						body: payloadChunk,
					})

					if (res.status === 200 || res.status === 201) {
						const data = (await res.json()) as { id: string }
						videoId = data.id
						uploadedBytes = fileSize
						sent = true
					} else if (res.status === 308) {
						uploadedBytes = offsetFromRange(res)
						sent = true
					} else if (res.status >= 500) {
						throw new Error(`Server error HTTP ${res.status}`)
					} else {
						throw Object.assign(
							new Error(`Upload chunk failed: HTTP \({res.status}\){await res.text()}`),
							{ fatal: true },
						)
					}
				} catch (err) {
					if ((err as { fatal?: boolean }).fatal || attempt === MAX_CHUNK_ATTEMPTS) {
						throw err
					}
					console.warn(`Chunk at byte \({uploadedBytes} failed (attempt\){attempt}):`, err)
					await new Promise((r) => setTimeout(r, 2000 * attempt))

					const status = await queryUploadedBytes(uploadUrl, fileSize)
					uploadedBytes = status.offset
					if (status.videoId) {
						videoId = status.videoId
						sent = true
					}
				}
			}

			const progress = 70 + Math.round((uploadedBytes / fileSize) * 30)
			await updateProgress(
				progress,
				`Uploading to YouTube (\({Math.round(uploadedBytes / 1048576)}MB /\){Math.round(fileSize / 1048576)}MB)`,
			)
		}
	} finally {
		await fh.close()
	}

	if (!videoId) throw new Error("Upload completed but YouTube returned no Video ID.")

	await db
		.update(videoJobs)
		.set({
			status: "COMPLETED",
			progress: 100,
			currentStep: `Uploaded: https://youtu.be/${videoId}`,
		})
		.where(eq(videoJobs.id, jobId))

	console.log(`Job \({jobId} complete. YouTube video: https://youtu.be/\){videoId}`)
}

main()
	.then(async () => {
		await client.end()
	})
	.catch(async (err) => {
		console.error(err)
		await client.end()
		process.exit(1)
	})
