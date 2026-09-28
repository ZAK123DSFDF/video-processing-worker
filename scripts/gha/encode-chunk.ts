// scripts/gha/encode-chunk.ts
import { mkdir, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import {  join } from "node:path"
import { getR2Client, getR2BucketUrl } from "#/lib/r2"
import {
	AUDIO_BITRATE,
	HLS_SEGMENT_SECONDS,
	IMMUTABLE_CACHE,
	RENDITIONS,
	putMany,
	run,
} from "#/trigger/video-shared"

const videoId = process.env.VIDEO_ID!
const r2Key = process.env.R2_KEY!
const chunkIndex = Number.parseInt(process.env.CHUNK_INDEX!, 10)
const startSeconds = Number.parseFloat(process.env.START_SECONDS!)
const durationSeconds = process.env.DURATION_SECONDS
	? Number.parseFloat(process.env.DURATION_SECONDS)
	: null
const hasAudio = process.env.HAS_AUDIO === "true"

async function main() {
	const workDir = join(tmpdir(), `${videoId}-chunk-${chunkIndex}`)
	await rm(workDir, { recursive: true, force: true })
	await Promise.all(
		RENDITIONS.map((r) => mkdir(join(workDir, r.name), { recursive: true })),
	)

	const aws = getR2Client()
	const getUrl = new URL(getR2BucketUrl(r2Key))
	getUrl.searchParams.set("X-Amz-Expires", "43200")
	const signedReq = await aws.sign(
		new Request(getUrl.toString(), { method: "GET" }),
		{ aws: { signQuery: true } },
	)

	const n = RENDITIONS.length
	const labels = (prefix: string) =>
		RENDITIONS.map((_, i) => `[${prefix}${i}]`).join("")

	const filters = [
		`[0:v:0]format=yuv420p,split=${n}${labels("s")}`,
		...RENDITIONS.map(
			(r, i) =>
				`[s${i}]scale=${r.width}:${r.height}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${r.width}:${r.height}:(ow-iw)/2:(oh-ih)/2[v${i}]`,
		),
	]
	if (hasAudio) filters.push(`[0:a:0]asplit=${n}${labels("a")}`)

	const streams: string[] = []
	RENDITIONS.forEach((r, i) => {
		streams.push(
			"-map",
			`[v${i}]`,
			`-c:v:${i}`,
			"libx264",
			"-preset",
			"veryfast",
			"-profile:v",
			"high",
			`-b:v:${i}`,
			r.videoBitrate,
			`-maxrate:v:${i}`,
			r.maxrate,
			`-bufsize:v:${i}`,
			r.bufsize,
			"-sc_threshold",
			"0",
			`-force_key_frames:v:${i}`,
			`expr:gte(t,n_forced*${HLS_SEGMENT_SECONDS})`,
		)
		if (hasAudio) {
			streams.push(
				"-map",
				`[a${i}]`,
				`-c:a:${i}`,
				"aac",
				`-b:a:${i}`,
				AUDIO_BITRATE,
			)
		}
	})

	const ffmpegArgs = [
		"-hide_banner",
		"-loglevel",
		"error",
		"-nostdin",
		"-rw_timeout",
		"15000000",
		"-timeout",
		"15000000",
		"-reconnect",
		"1",
		"-reconnect_at_eof",
		"1",
		"-reconnect_streamed",
		"1",
		"-reconnect_delay_max",
		"5",
		"-probesize",
		"10000000",
		"-analyzeduration",
		"10000000",
		"-ss",
		String(startSeconds),
		...(durationSeconds ? ["-t", String(durationSeconds)] : []),
		"-i",
		signedReq.url.toString(),
		"-filter_complex",
		filters.join(";"),
		...streams,
		"-output_ts_offset",
		String(startSeconds),
		"-f",
		"hls",
		"-hls_time",
		String(HLS_SEGMENT_SECONDS),
		"-hls_playlist_type",
		"vod",
		"-hls_segment_filename",
		join(workDir, "%v", `chunk_${chunkIndex}_seg_%03d.ts`),
		"-var_stream_map",
		RENDITIONS.map((r, i) => `v:${i}${hasAudio ? `,a:${i}` : ""},name:${r.name}`).join(" "),
		join(workDir, "%v", "playlist.m3u8"),
	]

	console.log(`Encoding chunk ${chunkIndex}...`)
	await run("ffmpeg", ffmpegArgs, 30 * 60 * 1000)

	const uploads: Parameters<typeof putMany>[0] = []
	for (const r of RENDITIONS) {
		const dir = join(workDir, r.name)

		// Save segment mapping metadata so publisher can construct full playlist
		uploads.push({
			key: `processed/${videoId}/${r.name}/meta_chunk_${chunkIndex}.json`,
			path: join(dir, "playlist.m3u8"),
			contentType: "text/plain",
		})

		for (const file of await readdir(dir)) {
			if (!file.endsWith(".ts")) continue
			uploads.push({
				key: `processed/${videoId}/${r.name}/${file}`,
				path: join(dir, file),
				contentType: "video/mp2t",
				cacheControl: IMMUTABLE_CACHE,
			})
		}
	}

	await putMany(uploads)
	console.log(`Chunk ${chunkIndex} completed successfully.`)
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
