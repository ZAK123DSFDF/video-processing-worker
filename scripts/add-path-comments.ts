// scripts/add-path-comments.ts
import fs from "node:fs/promises"
import path from "node:path"

// Directories to recursively scan
const TARGET_DIRS = ["src", "scripts", "drizzle"]

// Specific root-level files to tag
const TARGET_ROOT_FILES = [
	"vite.config.ts",
	"vite.config.js",
	"drizzle.config.ts",
	"app.config.ts",
	"tailwind.config.ts",
]

const VALID_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"])
const PATH_COMMENT_REGEX = /^\/\/\s+([a-zA-Z0-9_\-\.\/]+)$/

async function processFile(fullPath: string) {
	try {
		const relativePath = path
			.relative(process.cwd(), fullPath)
			.replace(/\\/g, "/")

		const expectedHeader = `// ${relativePath}`
		const fileContent = await fs.readFile(fullPath, "utf-8")
		const lines = fileContent.split(/\r?\n/)

		const nonPathComments: string[] = []
		let lineIndex = 0
		let foundCorrectPathHeader = false

		while (lineIndex < lines.length) {
			const line = lines[lineIndex].trim()

			if (!line.startsWith("//") && line !== "") {
				break
			}

			const match = line.match(PATH_COMMENT_REGEX)

			if (match) {
				const existingPath = match[1]
				if (existingPath === relativePath && !foundCorrectPathHeader) {
					foundCorrectPathHeader = true
				}
			} else if (line !== "") {
				nonPathComments.push(lines[lineIndex])
			}

			lineIndex++
		}

		const restOfFile = lines.slice(lineIndex).join("\n")

		const hasOnlyFirstPath =
			lines[0]?.trim() === expectedHeader &&
			!lines.slice(1, lineIndex).some((l) => PATH_COMMENT_REGEX.test(l.trim()))

		if (hasOnlyFirstPath) {
			console.log(`⏩ Already tagged: ${relativePath}`)
			return
		}

		const headerParts = [expectedHeader, ...nonPathComments]
		const newContent =
			headerParts.join("\n") +
			(restOfFile
				? (nonPathComments.length > 0 ? "\n\n" : "\n") + restOfFile
				: "\n")

		await fs.writeFile(fullPath, newContent, "utf-8")
		console.log(`✅ Fixed header: ${relativePath}`)
	} catch (err: any) {
		if (err.code !== "ENOENT") throw err
	}
}

async function processDirectory(dirPath: string) {
	try {
		const entries = await fs.readdir(dirPath, { withFileTypes: true })

		for (const entry of entries) {
			const fullPath = path.join(dirPath, entry.name)

			if (entry.isDirectory()) {
				if (
					entry.name === "node_modules" ||
					entry.name === ".next" ||
					entry.name === "dist" ||
					entry.name === ".output"
				) {
					continue
				}
				await processDirectory(fullPath)
				continue
			}

			const ext = path.extname(entry.name)
			if (VALID_EXTENSIONS.has(ext)) {
				await processFile(fullPath)
			}
		}
	} catch (err: any) {
		if (err.code !== "ENOENT") throw err
	}
}

async function run() {
	console.log("🚀 Tagging and cleaning file path comments...")

	// 1. Process target directories
	for (const dir of TARGET_DIRS) {
		await processDirectory(path.join(process.cwd(), dir))
	}

	// 2. Process root config files
	for (const rootFile of TARGET_ROOT_FILES) {
		await processFile(path.join(process.cwd(), rootFile))
	}

	console.log("🎉 Done tagging file paths!")
}

run().catch(console.error)
