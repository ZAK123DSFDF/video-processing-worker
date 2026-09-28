// scripts/gha/concat-videos.ts
import { mkdir, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { eq } from "drizzle-orm"
import { getR2Client, getR2BucketUrl } from "#/lib/r2"
import { run } from "#/trigger/video-shared"
import { db, client } from "./db"
import { videoJobs } from "#/db/course-schema"

const jobId = process.env.JOB_ID!
const videos: { id: string; manifestUrl: string; position: number }[] =
	JSON.parse(process.env.VIDEOS_JSON!)

const DOWNLOAD_CONCURRENCY = 16

const outDir = join(tmpdir(), `merge-${jobId}`)
const pointerPath = join(tmpdir(), `merge-${jobId}-final-path.txt`)

async function listObjectKeys(prefix: string): Promise<string[]> {
	const aws = getR2Client()
	const keys: string[] = []
	let token: string | undefined

	do {
		const url = new URL(getR2BucketUrl())
		url.searchParams.set("list-type", "2")
		url.searchParams.set("prefix", prefix)
		if (token) url.searchParams.set("continuation-token", token)

		const res = await aws.fetch(url.toString())
		const xml = await res.text()
		if (!res.ok) {
			throw new Error(`List failed for ${prefix}: HTTP ${res.status} ${xml}`)
		}

		keys.push(...Array.from(xml.matchAll(/<Key>([^<]+)<\/Key>/g), (m) => m[1]))
		token = /<IsTruncated>true<\/IsTruncated>/.test(xml)
			? xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/)?.[1]
			: undefined
	} while (token)

	return keys
}

function sortSegments(keys: string[]): string[] {
	const parse = (k: string) => {
		const m = k.match(/chunk_(\d+)_seg_(\d+)\.ts$/)
		return m ? [Number(m[1]), Number(m[2])] : [0, 0]
	}
	return keys
		.filter((k) => k.endsWith(".ts"))
		.sort((a, b) => {
			const [ca, sa] = parse(a)
			const [cb, sb] = parse(b)
			return ca !== cb ? ca - cb : sa - sb
		})
}

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

async function cleanup() {
	try {
		await rm(outDir, { recursive: true, force: true })
		await rm(pointerPath, { force: true })
	} catch (err) {
		console.warn(`[Cleanup Warning]: ${err}`)
	}
}

async function downloadSegment(key: string, dest: string, attempts = 3) {
	const aws = getR2Client()
	let lastErr: unknown
	for (let i = 1; i <= attempts; i++) {
		try {
			const res = await aws.fetch(getR2BucketUrl(key))
			if (!res.ok) throw new Error(`HTTP ${res.status}`)
			await writeFile(dest, Buffer.from(await res.arrayBuffer()))
			return
		} catch (err) {
			lastErr = err
			await new Promise((r) => setTimeout(r, 500 * i))
		}
	}
	throw new Error(`Failed to download segment ${key}: ${lastErr}`)
}

async function downloadAll(keys: string[], dir: string): Promise<string[]> {
	const paths = keys.map((k) => join(dir, k.split("/").pop()!))
	let next = 0
	const worker = async () => {
		while (next < keys.length) {
			const i = next++
			await downloadSegment(keys[i], paths[i])
		}
	}
	await Promise.all(
		Array.from({ length: Math.min(DOWNLOAD_CONCURRENCY, keys.length) }, worker),
	)
	return paths
}

async function hasAudioStream(filePath: string): Promise<boolean> {
	const { stdout } = await run(
		"ffprobe",
		[
			"-v", "error",
			"-select_streams", "a",
			"-show_entries", "stream=codec_type",
			"-of", "csv=p=0",
			filePath,
		],
		60_000,
	)
	return stdout.trim().length > 0
}

/**
 * Builds one mp4 per video: video is copied untouched, audio is normalized to
 * AAC 48kHz stereo (or silence is generated if the video has no audio), so
 * every part has identical audio parameters and can be copy-concatenated.
 */
async function buildPartMp4(
	segmentPaths: string[],
	workDir: string,
	outPath: string,
) {
	const listPath = join(workDir, "segments.txt")
	await writeFile(listPath, segmentPaths.map((p) => `file '${p}'`).join("\n"))

	const withAudio = await hasAudioStream(segmentPaths[0])
	console.log(`  audio: ${withAudio ? "present, normalizing" : "none, adding silence"}`)

	const args = withAudio
		? [
				"-hide_banner", "-loglevel", "error", "-y",
				"-f", "concat", "-safe", "0", "-i", listPath,
				"-map", "0:v:0", "-map", "0:a:0",
				"-c:v", "copy",
				"-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2",
				"-af", "aresample=async=1:first_pts=0",
				"-movflags", "+faststart",
				outPath,
			]
		: [
				"-hide_banner", "-loglevel", "error", "-y",
				"-f", "concat", "-safe", "0", "-i", listPath,
				"-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo",
				"-map", "0:v:0", "-map", "1:a:0",
				"-c:v", "copy",
				"-c:a", "aac", "-b:a", "128k",
				"-shortest",
				"-movflags", "+faststart",
				outPath,
			]

	await run("ffmpeg", args, 60 * 60 * 1000)
}

async function merge() {
	const partPaths: string[] = []

	for (let i = 0; i < videos.length; i++) {
		const v = videos[i]
		const segmentKeys = sortSegments(
			await listObjectKeys(`processed/${v.id}/1080p/`),
		)
		if (segmentKeys.length === 0) {
			throw new Error(
				`Video ${v.id} has no 1080p rendition available in R2, cannot merge.`,
			)
		}

		const videoDir = join(outDir, v.id)
		await mkdir(videoDir, { recursive: true })
		const segmentPaths = await downloadAll(segmentKeys, videoDir)
		console.log(`Video ${v.id}: downloaded ${segmentKeys.length} segments`)

		const partPath = join(outDir, `part_${String(i).padStart(3, "0")}.mp4`)
		await buildPartMp4(segmentPaths, videoDir, partPath)
		partPaths.push(partPath)

		// Free disk as we go.
		await rm(videoDir, { recursive: true, force: true })

		await updateProgress(
			5 + Math.round(((i + 1) / videos.length) * 55),
			`Prepared ${i + 1}/${videos.length} videos`,
		)
	}

	await updateProgress(60, "Merging into a single file")

	const finalPath = join(outDir, "final.mp4")

	if (partPaths.length === 1) {
		// Single video: no need to re-copy the whole file, just rename it.
		await rename(partPaths[0], finalPath)
	} else {
		const listFile = join(outDir, "concat_list.txt")
		await writeFile(listFile, partPaths.map((p) => `file '${p}'`).join("\n"))

		await run(
			"ffmpeg",
			[
				"-hide_banner", "-loglevel", "error", "-y",
				"-f", "concat", "-safe", "0", "-i", listFile,
				"-c", "copy",
				"-movflags", "+faststart",
				finalPath,
			],
			60 * 60 * 1000,
		)

		await Promise.all(partPaths.map((p) => rm(p, { force: true })))
	}

	await updateProgress(70, "Merge complete, preparing YouTube upload")
	await writeFile(pointerPath, finalPath)
	console.log(`Final merged file ready: ${finalPath}`)
}

async function main() {
	// Clean BEFORE: remove any stale dir or pointer from an earlier run.
	await cleanup()
	await mkdir(outDir, { recursive: true })

	try {
		await merge()
	} catch (err) {
		// Clean on failure so a half-built merge never lingers.
		await cleanup()
		throw err
	}
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
