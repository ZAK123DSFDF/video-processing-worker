// scripts/gha/probe.ts
import { appendFileSync } from "node:fs"
import { getR2Client, getR2BucketUrl } from "#/lib/r2"
import { CHUNK_SECONDS, run } from "#/trigger/video-shared"
import { mkdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const r2Key = process.env.R2_KEY

if (!r2Key) {
	throw new Error("R2_KEY environment variable is missing or empty.")
}

function setGithubOutput(key: string, value: string | boolean | number) {
	const outputFile = process.env.GITHUB_OUTPUT
	if (outputFile) {
		appendFileSync(outputFile, `${key}=${value}\n`)
	}
}
async function uploadThumbnail(signedUrl: string, duration: number) {
	const videoId = process.env.VIDEO_ID
	if (!videoId) return

	const workDir = join(tmpdir(), `${videoId}-thumb`)
	await rm(workDir, { recursive: true, force: true })
	await mkdir(workDir, { recursive: true })
	const file = join(workDir, "thumbnail.jpg")

	// A frame ~10% in (max 10s) usually avoids black intro frames
	const at = Math.min(duration * 0.1, 10)

	await run("ffmpeg", [
		"-hide_banner",
		"-loglevel",
		"error",
		"-nostdin",
		"-ss",
		String(at),
		"-i",
		signedUrl,
		"-frames:v",
		"1",
		"-vf",
		"scale=1280:-2",
		"-q:v",
		"3",
		"-y",
		file,
	])

	const aws = getR2Client()
	const res = await aws.fetch(
		getR2BucketUrl(`processed/${videoId}/thumbnail.jpg`),
		{
			method: "PUT",
			headers: {
				"Content-Type": "image/jpeg",
				"Cache-Control": "public, max-age=31536000, immutable",
			},
			body: await readFile(file),
		},
	)
	if (!res.ok) throw new Error(`Thumbnail upload failed: HTTP ${res.status}`)
}

async function main() {
	const aws = getR2Client()
	const getUrl = new URL(getR2BucketUrl(r2Key))
	getUrl.searchParams.set("X-Amz-Expires", "43200")
	const signedReq = await aws.sign(
		new Request(getUrl.toString(), { method: "GET" }),
		{ aws: { signQuery: true } },
	)

	const { stdout } = await run("ffprobe", [
		"-v",
		"error",
		"-rw_timeout",
		"15000000",
		"-timeout",
		"15000000",
		"-show_entries",
		"format=duration:stream=codec_type",
		"-of",
		"json",
		signedReq.url,
	])

	const info = JSON.parse(stdout)
	const duration = Number.parseFloat(info.format?.duration)
	if (!Number.isFinite(duration) || duration <= 0) {
		throw new Error("Could not read video duration")
	}

	const hasAudio =
		info.streams?.some(
			(s: { codec_type?: string }) => s.codec_type === "audio",
		) ?? false

	let count = Math.ceil(duration / CHUNK_SECONDS)
	if (count > 1 && duration - (count - 1) * CHUNK_SECONDS < 30) count--

	const chunks = Array.from({ length: count }, (_, i) => ({
		chunkIndex: i,
		startSeconds: i * CHUNK_SECONDS,
		durationSeconds: i === count - 1 ? "" : String(CHUNK_SECONDS),
	}))

	setGithubOutput("matrix", JSON.stringify(chunks))
	setGithubOutput("hasAudio", hasAudio)
  setGithubOutput("duration", duration)
  try {
		await uploadThumbnail(signedReq.url.toString(), duration)
	} catch (err) {
		console.error("Thumbnail generation failed (non-fatal):", err)
	}
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
