import { mkdir, rm, writeFile, readdir } from "node:fs/promises"
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
	return keys
		.filter((k) => k.endsWith(".ts"))
		.sort((a, b) => {
			// keys look like .../chunk_{chunkIndex}_seg_{segIndex}.ts
			const parse = (k: string) => {
				const m = k.match(/chunk_(\d+)_seg_(\d+)\.ts$/)
				return m ? [Number(m[1]), Number(m[2])] : [0, 0]
			}
			const [ca, sa] = parse(a)
			const [cb, sb] = parse(b)
			return ca !== cb ? ca - cb : sa - sb
		})
}

async function updateProgress(progress: number, step: string) {
	await db
		.update(videoJobs)
		.set({ progress, currentStep: step })
		.where(eq(videoJobs.id, jobId))
}

async function remuxVideoToMp4(videoId: string, outPath: string) {
	const segmentKeys = sortSegments(
		await listObjectKeys(`processed/${videoId}/1080p/`),
	)

	if (segmentKeys.length === 0) {
		throw new Error(
			`Video ${videoId} has no 1080p rendition available in R2 — cannot merge. ` +
				`Check that processing completed all renditions for this video.`,
		)
	}

	const workDir = join(tmpdir(), `concat-${videoId}`)
	await rm(workDir, { recursive: true, force: true })
	await mkdir(workDir, { recursive: true })

	const aws = getR2Client()
	const localPaths: string[] = []
	for (const key of segmentKeys) {
		const res = await aws.fetch(getR2BucketUrl(key))
		if (!res.ok) throw new Error(`Failed to download segment ${key}`)
		const buf = Buffer.from(await res.arrayBuffer())
		const localPath = join(workDir, key.split("/").pop()!)
		await writeFile(localPath, buf)
		localPaths.push(localPath)
	}

	// List file + concat demuxer: no command-line length limit, unlike the
	// `concat:a|b|c` protocol.
	const listPath = join(workDir, "segments.txt")
	await writeFile(listPath, localPaths.map((p) => `file '${p}'`).join("\n"))

	await run(
		"ffmpeg",
		[
			"-hide_banner", "-loglevel", "error", "-y",
			"-f", "concat", "-safe", "0",
			"-i", listPath,
			"-c", "copy",
			"-movflags", "+faststart",
			outPath,
		],
		30 * 60 * 1000,
	)

	await rm(workDir, { recursive: true, force: true })
	console.log(
		`Video ${videoId}: remuxed ${segmentKeys.length} 1080p segments -> ${outPath}`,
	)
}
async function main() {
	const outDir = join(tmpdir(), `merge-${jobId}`)
	await rm(outDir, { recursive: true, force: true })
	await mkdir(outDir, { recursive: true })

	const perVideoPaths: string[] = []
	for (let i = 0; i < videos.length; i++) {
		const v = videos[i]
		const outPath = join(outDir, `part_${String(i).padStart(3, "0")}.mp4`)
		await remuxVideoToMp4(v.id, outPath)
		perVideoPaths.push(outPath)
		await updateProgress(
			5 + Math.round(((i + 1) / videos.length) * 60),
			`Remuxed ${i + 1}/${videos.length} videos`,
		)
	}

	// Concat all per-video mp4s, in the same position order.
	const listFile = join(outDir, "concat_list.txt")
	await writeFile(
		listFile,
		perVideoPaths.map((p) => `file '${p}'`).join("\n"),
	)

	const finalPath = join(outDir, "final.mp4")
	await run("ffmpeg", [
		"-hide_banner", "-loglevel", "error", "-y",
		"-f", "concat", "-safe", "0",
		"-i", listFile,
		"-c", "copy",
		finalPath,
	], 30 * 60 * 1000)

	await updateProgress(70, "Concatenation complete, preparing YouTube upload")
	await writeFile(join(tmpdir(), `merge-${jobId}-final-path.txt`), finalPath)

	console.log(`Final merged file ready: ${finalPath}`)
}

main()
	.then(async () => { await client.end() })
	.catch(async (err) => {
		console.error(err)
		await client.end()
		process.exit(1)
	})
