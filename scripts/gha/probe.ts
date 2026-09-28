// scripts/gha/probe.ts
import { appendFileSync } from "node:fs"
import { getR2Client, getR2BucketUrl } from "#/lib/r2"
import { CHUNK_SECONDS, run } from "#/trigger/video-shared"


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
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
