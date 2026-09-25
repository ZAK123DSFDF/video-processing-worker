// src/trigger/video-shared.ts
import { getR2Client, getR2BucketUrl } from "#/lib/r2"
import { spawn } from "node:child_process"
import { readFile } from "node:fs/promises"

export const RENDITIONS = [
	{
		name: "1080p",
		width: 1920,
		height: 1080,
		videoBitrate: "5000k",
		maxrate: "5350k",
		bufsize: "7500k",
	},
	{
		name: "720p",
		width: 1280,
		height: 720,
		videoBitrate: "2800k",
		maxrate: "2996k",
		bufsize: "4200k",
	},
	{
		name: "480p",
		width: 854,
		height: 480,
		videoBitrate: "1400k",
		maxrate: "1498k",
		bufsize: "2100k",
	},
] as const

export const AUDIO_BITRATE = "128k"
export const HLS_SEGMENT_SECONDS = 6
export const CHUNK_SECONDS = 300

export const IMMUTABLE_CACHE = "public, max-age=31536000, immutable"

/** Executes CLI commands with a safety execution timeout to prevent infinite execution hangs */
export function run(cmd: string, args: string[], timeoutMs = 15 * 60 * 1000) {
	return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
		const proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] })
		let stdout = ""
		let stderr = ""

		const timer = setTimeout(() => {
			proc.kill("SIGKILL")
			reject(new Error(`${cmd} timed out after ${timeoutMs / 1000}s`))
		}, timeoutMs)

		proc.stdout.on("data", (d) => (stdout += d.toString()))
		proc.stderr.on(
			"data",
			(d) => (stderr = (stderr + d.toString()).slice(-4000)),
		)

		proc.on("error", (err) => {
			clearTimeout(timer)
			reject(err)
		})

		proc.on("close", (code) => {
			clearTimeout(timer)
			if (code === 0) {
				resolve({ stdout, stderr })
			} else {
				reject(new Error(`${cmd} exited ${code}: ${stderr}`))
			}
		})
	})
}

type UploadItem = {
	key: string
	path: string
	contentType: string
	cacheControl?: string
}

export async function putMany(items: UploadItem[], concurrency = 8) {
	let next = 0
	const aws = getR2Client()

	const worker = async () => {
		while (next < items.length) {
			const item = items[next++]
			const targetUrl = getR2BucketUrl(item.key)
			const fileBuffer = await readFile(item.path)

			const headers: Record<string, string> = {
				"Content-Type": item.contentType,
			}

			if (item.cacheControl) {
				headers["Cache-Control"] = item.cacheControl
			}

			const response = await aws.fetch(targetUrl, {
				method: "PUT",
				headers,
				body: fileBuffer,
			})

			if (!response.ok) {
				const errText = await response.text()
				throw new Error(
					`Failed to upload object (${item.key}): HTTP ${response.status} - ${errText}`,
				)
			}
		}
	}

	await Promise.all(
		Array.from({ length: Math.min(concurrency, items.length) }, worker),
	)
}
